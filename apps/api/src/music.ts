import type { Env } from './env'
import { spaceBaseUrl } from './spaces'

// THE AGENT'S MUSIC: free music models running as public Hugging Face
// Spaces, called through their Gradio API — no key. With HF_TOKEN stored the
// calls count against the owner's own free GPU allowance on Hugging Face
// instead of the one shared by every anonymous caller. The owner picks the
// model in the page (☰ → Models); ACE-Step, the fastest, is the default.
//
//   ACE-Step  style tags and, optionally, lyrics → a track of 10-180 s
//   YuE2 3B   a style and lyrics → a full song with vocals (slower)
//
// A Space's inputs are filled from its own /gradio_api/info, every one at its
// default but those named here, so a Space that adds an input keeps working.
// The track is downloaded from the Space (only ever from its own host) and
// kept in MEMORY — the owner's library — and played by the page
// (GET /api/music/<id>); a model only ever hears its number.

export type MusicModel = {
  id: string
  label: string
  api: string
  /** Lyrics are required: without them another model makes the track. */
  needsLyrics: boolean
  inputs: (o: { style: string; lyrics: string; seconds: number }) => Record<string, unknown>
}

export const MUSIC_MODELS: MusicModel[] = [
  {
    id: 'ACE-Step/ACE-Step',
    label: 'ACE-Step — fast; instrumental or with lyrics',
    api: '/__call__',
    needsLyrics: false,
    inputs: ({ style, lyrics, seconds }) => ({ audio_duration: seconds, prompt: style, lyrics: lyrics || '[instrumental]', infer_step: 27 }),
  },
  {
    id: 'mrfakename/yue2-3b',
    label: 'YuE2 3B — full songs with vocals; slower',
    api: '/generate_song',
    needsLyrics: true,
    inputs: ({ style, lyrics }) => ({ style, lyrics }),
  },
]
export const DEFAULT_MUSIC_MODEL = MUSIC_MODELS[0]!.id
export const musicModel = (id: string | null | undefined) => MUSIC_MODELS.find((m) => m.id === id) ?? MUSIC_MODELS[0]!

export const MAX_MUSIC_STYLE = 500
export const MAX_LYRICS = 3000
export const MAX_TRACK_BYTES = 12_000_000
export const MUSIC_TIMEOUT_MS = 300_000

type Param = { parameter_name: string; parameter_has_default?: boolean; parameter_default?: unknown }
type FileData = { url?: string | null; path?: string; orig_name?: string; mime_type?: string | null }

export type Track = { base64: string; type: string; model: string; seconds: number }

const failed = (model: MusicModel, why: unknown) => ({ error: `${model.label.split(' —')[0]} failed: ${String((why as Error)?.message ?? why).slice(0, 200)}` })

/** The first file in a Gradio `complete` event, or the error it reported. */
export function fileFrom(sse: string): FileData | { error: string } {
  let event = ''
  for (const line of sse.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:') && (event === 'error' || event === 'complete')) {
      const data = line.slice(5).trim()
      if (event === 'error') return { error: data && data !== 'null' ? data.slice(0, 200) : 'the Space gave no reason (it may be busy or out of free GPU time)' }
      const out = JSON.parse(data) as unknown[]
      const file = out.find((o) => o && typeof o === 'object' && ('url' in (o as object) || 'path' in (o as object)))
      return (file as FileData) ?? { error: 'the Space returned no audio' }
    }
  }
  return { error: 'the Space ended without a track' }
}

const AUDIO_TYPES: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4' }

export async function composeMusic(env: Env, opts: { style: string; lyrics?: string; seconds?: number; model?: string | null }): Promise<Track | { error: string }> {
  const lyrics = (opts.lyrics ?? '').trim()
  let model = musicModel(opts.model)
  if (model.needsLyrics && !lyrics) model = MUSIC_MODELS.find((m) => !m.needsLyrics)!
  const seconds = Math.round(Math.min(180, Math.max(10, opts.seconds ?? 60)))
  const base = spaceBaseUrl(env, model.id)
  const auth: Record<string, string> = env.HF_TOKEN ? { authorization: `Bearer ${env.HF_TOKEN}` } : {}
  const signal = AbortSignal.timeout(MUSIC_TIMEOUT_MS)
  try {
    const info = (await (await fetch(`${base}/gradio_api/info`, { headers: auth, signal })).json()) as { named_endpoints?: Record<string, { parameters: Param[] }> }
    const params = info.named_endpoints?.[model.api]?.parameters
    if (!params) return { error: `${model.id} no longer offers ${model.api}; choose another music model in Settings → Models` }
    const given = model.inputs({ style: opts.style, lyrics, seconds })
    const data = params.map((p) => (p.parameter_name in given ? given[p.parameter_name] : (p.parameter_default ?? null)))

    const started = await fetch(`${base}/gradio_api/call${model.api}`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ data }), signal })
    if (!started.ok) return failed(model, `the Space refused the call (${started.status})`)
    const { event_id: eventId } = (await started.json()) as { event_id?: string }
    if (!eventId) return failed(model, 'the Space did not start a job')
    const stream = await fetch(`${base}/gradio_api/call${model.api}/${encodeURIComponent(eventId)}`, { headers: auth, signal })
    const file = fileFrom(await stream.text())
    if ('error' in file) return failed(model, file.error)

    // The track is fetched from the Space's own host and nowhere else, so the
    // owner's token never leaves Hugging Face.
    const url = file.url ?? (file.path ? `${base}/gradio_api/file=${file.path}` : '')
    if (!url.startsWith(`${base}/`)) return failed(model, 'the Space pointed somewhere else for its audio')
    const audio = await fetch(url, { headers: auth, signal })
    if (!audio.ok) return failed(model, `the track could not be fetched (${audio.status})`)
    const bytes = new Uint8Array(await audio.arrayBuffer())
    if (bytes.length > MAX_TRACK_BYTES) return failed(model, 'the track is too big to keep')
    const ext = (file.orig_name ?? url).split('.').pop()?.toLowerCase() ?? ''
    const type = file.mime_type || AUDIO_TYPES[ext] || audio.headers.get('content-type') || 'audio/mpeg'
    return { base64: toBase64(bytes), type, model: model.id, seconds }
  } catch (error) {
    return failed(model, (error as Error)?.name === 'TimeoutError' ? 'it took longer than 5 minutes (the Space may be busy); try again later' : error)
  }
}

export function toBase64(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

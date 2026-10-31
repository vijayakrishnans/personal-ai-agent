import type { Env } from './env'
import { HF_HUB_URL } from './hub'
import type { MemoryStore } from './memory'
import { HF_ROUTER_URL, SPACE_ID } from './models'
import { toBase64 } from './music'

// THE AGENT'S VIDEOS: text-to-video models on Hugging Face's Inference
// Providers, called through the router with the owner's HF_TOKEN and billed
// to their Hugging Face account. A video costs far more than a chat answer,
// so a free account's monthly credits may not cover one: the failure says so.
//
// Only fal-ai is spoken for now (it serves most of the Hub's video models).
// The model's fal-ai id is read from the Hub's own mapping at each call, so a
// model the Hub remaps keeps working. The job goes through fal's queue:
//
//   POST <router>/fal-ai/<fal id>?_subdomain=queue     → request_id, response_url
//   GET  <router>/fal-ai<response path>/status?…       until COMPLETED (slowly:
//                                                       a Worker's subrequests
//                                                       are counted)
//   GET  <router>/fal-ai<response path>?…               → { video: { url } }
//   GET  the video's url, from fal's CDN — without the token
//
// The video is kept in MEMORY (the owner's library) and played by the page
// (GET /api/videos/<id>); a model only ever hears its number.

export type VideoModel = { id: string; label: string }

export const VIDEO_MODELS: VideoModel[] = [
  { id: 'Wan-AI/Wan2.2-TI2V-5B', label: 'Wan 2.2 5B — quickest and cheapest' },
  { id: 'Lightricks/LTX-Video-0.9.7-distilled', label: 'LTX-Video distilled — fast' },
  { id: 'Wan-AI/Wan2.2-T2V-A14B', label: 'Wan 2.2 A14B — better, slower, costs more' },
  { id: 'tencent/HunyuanVideo-1.5', label: 'HunyuanVideo 1.5 — high quality, costs more' },
]
export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0]!.id

export const MAX_VIDEO_PROMPT = 1000
export const MAX_VIDEO_BYTES = 15_000_000
export const MAX_ADDED_VIDEO_MODELS = 10
export const VIDEO_TIMEOUT_MS = 360_000

/** The video models on offer: the built-in ones, then the owner's added ones. */
export function videoModels(added: string[]): (VideoModel & { added: boolean })[] {
  const out = VIDEO_MODELS.map((m) => ({ ...m, added: false }))
  for (const id of added) if (!out.some((m) => m.id === id)) out.push({ id, label: id, added: true })
  return out
}

/** The added video models, as kept in the `videoModels` setting (a JSON list). */
export function parseAddedVideoModels(raw: string | null): string[] {
  try {
    const list = JSON.parse(raw ?? '[]') as unknown
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && SPACE_ID.test(id)) : []
  } catch {
    return []
  }
}

/** The chosen video model, if it is still on offer; else the default. */
export async function chosenVideoModel(memory: MemoryStore): Promise<string> {
  const id = await memory.getSetting('videoModel')
  return id && videoModels(parseAddedVideoModels(await memory.getSetting('videoModels'))).some((m) => m.id === id) ? id : DEFAULT_VIDEO_MODEL
}

export type Video = { base64: string; type: string; model: string }
type Mapping = Record<string, { status?: string; task?: string; providerId?: string }>

const routerOrigin = (env: Env) => new URL(env.HF_ROUTER_URL || HF_ROUTER_URL).origin
const name = (id: string) => VIDEO_MODELS.find((m) => m.id === id)?.label.split(' —')[0] ?? id

const TOKEN_HELP = 'Make a new one at huggingface.co/settings/tokens (fine-grained, with "Make calls to Inference Providers") and paste it in Settings → Models.'

/**
 * Where fal-ai runs `id` as text-to-video, from the Hub's mapping — or why it
 * cannot be used. Used when a model is added and before every video.
 */
export async function videoRoute(env: Env, id: string): Promise<{ falId: string } | { error: string }> {
  let res: Response
  try {
    res = await fetch(`${env.HF_HUB_URL || HF_HUB_URL}/api/models/${id}?expand[]=inferenceProviderMapping&expand[]=pipeline_tag`, {
      headers: env.HF_TOKEN ? { authorization: `Bearer ${env.HF_TOKEN}` } : {},
      signal: AbortSignal.timeout(10_000),
    })
  } catch {
    return { error: 'Hugging Face could not be reached just now; try again in a minute.' }
  }
  if (res.status === 401 && env.HF_TOKEN) return { error: `Hugging Face refused your token (it may be expired, deleted or mistyped). ${TOKEN_HELP}` }
  if (res.status === 401 || res.status === 404) return { error: `There is no model ${id} on Hugging Face. Copy the name from the top of the model's page (owner/name).` }
  if (!res.ok) return { error: `Hugging Face answered ${res.status}; try again in a minute.` }
  const model = (await res.json().catch(() => ({}))) as { pipeline_tag?: string; inferenceProviderMapping?: Mapping }
  const live = Object.entries(model.inferenceProviderMapping ?? {}).filter(([, m]) => !m.status || m.status === 'live')
  const fal = live.find(([provider, m]) => provider === 'fal-ai' && m.task === 'text-to-video' && m.providerId)
  if (fal) return { falId: fal[1].providerId! }
  const t2v = live.filter(([, m]) => m.task === 'text-to-video').map(([p]) => p)
  if (t2v.length) return { error: `${id} makes video, but only on ${t2v.join(', ')}; this agent speaks to fal-ai so far. Pick a model whose page lists fal-ai.` }
  const task = live[0]?.[1].task ?? model.pipeline_tag
  if (task && /video/.test(task)) return { error: `${id} is ${task === 'image-to-video' || task === 'image-text-to-video' ? 'an' : 'a'} ${task} model: it needs a picture to start from, and this agent makes video from text only so far. Pick a text-to-video model.` }
  if (task) return { error: `${id} is not a video model (it is ${/^[aeiou]/i.test(task) ? 'an' : 'a'} ${task} model).` }
  return { error: `No Inference Provider runs ${id}, so it cannot make video from here. Pick one listed at huggingface.co/models?pipeline_tag=text-to-video&inference_provider=fal-ai.` }
}

/** Why a step of the job failed, in the owner's words. */
async function refusal(res: Response): Promise<string> {
  let said = ''
  try {
    const body = (await res.json()) as { error?: string | { message?: string }; detail?: unknown; message?: string }
    said = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? (typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail ?? '')))
  } catch {
    /* no body */
  }
  said = String(said).slice(0, 200)
  switch (res.status) {
    case 401:
      return `Hugging Face refused your token. ${TOKEN_HELP}`
    case 402:
      return 'your Hugging Face account has no Inference Providers credits left for this month. A video costs much more than a chat answer, so a free account’s small monthly credits rarely cover one; Hugging Face PRO gives more and keeps going after (pay as you go): huggingface.co/pricing.'
    case 403:
      return `Hugging Face would not let your token make video: a fine-grained token needs "Make calls to Inference Providers". ${TOKEN_HELP}${said ? ` (It said: ${said})` : ''}`
    case 429:
      return 'too many requests just now; wait a minute and try again.'
    default:
      return `the provider refused (${res.status})${said ? `: ${said}` : ''}.`
  }
}

/** Makes a video of `prompt`; a few minutes. */
export async function makeVideo(env: Env, opts: { prompt: string; model?: string | null }): Promise<Video | { error: string }> {
  const model = opts.model || DEFAULT_VIDEO_MODEL
  const failed = (why: string) => ({ error: `${name(model)} failed: ${why}` })
  if (!env.HF_TOKEN) return failed(`making video needs a Hugging Face token. ${TOKEN_HELP}`)
  const route = await videoRoute(env, model)
  if ('error' in route) return failed(route.error)

  const auth = { authorization: `Bearer ${env.HF_TOKEN}` }
  const base = `${routerOrigin(env)}/fal-ai`
  const signal = AbortSignal.timeout(VIDEO_TIMEOUT_MS)
  try {
    const submitted = await fetch(`${base}/${route.falId}?_subdomain=queue`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ prompt: opts.prompt }), signal })
    if (!submitted.ok) return failed(await refusal(submitted))
    const job = (await submitted.json()) as { request_id?: string; response_url?: string; status?: string }
    if (!job.request_id || !job.response_url) return failed('the provider did not start a job.')
    const path = new URL(job.response_url).pathname

    // Slowly: 3 s, growing to 10 s — a few dozen checks for a few minutes.
    let status = job.status
    for (let wait = Number(env.VIDEO_POLL_MS ?? 3000); status !== 'COMPLETED'; wait = Math.min(wait * 1.5, 10_000)) {
      await new Promise((r) => setTimeout(r, wait))
      const check = await fetch(`${base}${path}/status?_subdomain=queue`, { headers: auth, signal })
      if (!check.ok) return failed(await refusal(check))
      const s = (await check.json()) as { status?: string; error?: string }
      status = s.status
      if (status === 'FAILED' || status === 'ERROR' || s.error) return failed(`the provider could not make it${s.error ? `: ${String(s.error).slice(0, 200)}` : '.'}`)
    }
    const result = await fetch(`${base}${path}?_subdomain=queue`, { headers: auth, signal })
    if (!result.ok) return failed(await refusal(result))
    const out = (await result.json()) as { video?: { url?: string; content_type?: string } }
    const url = out.video?.url ?? ''
    if (!/^https:\/\//.test(url) && !url.startsWith(routerOrigin(env))) return failed('the provider returned no video.')

    // From the provider's CDN, without the owner's token.
    const file = await fetch(url, { signal })
    if (!file.ok) return failed(`the video could not be fetched (${file.status}).`)
    const bytes = new Uint8Array(await file.arrayBuffer())
    if (bytes.length > MAX_VIDEO_BYTES) return failed('the video is too big to keep.')
    const type = out.video?.content_type || file.headers.get('content-type') || 'video/mp4'
    return { base64: toBase64(bytes), type: type.startsWith('video/') ? type : 'video/mp4', model }
  } catch (error) {
    return failed((error as Error)?.name === 'TimeoutError' ? 'it took longer than 6 minutes (the provider may be busy); try again later.' : String((error as Error)?.message ?? error).slice(0, 200))
  }
}

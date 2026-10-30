import type { Env } from './env'

// A GRADIO SPACE, CALLED THROUGH ITS HTTP API (Gradio 5):
//
//   POST <space>/gradio_api/call/<endpoint>   {"data": [<message>]} → {"event_id"}
//   GET  <space>/gradio_api/call/<endpoint>/<event_id>               → server-sent events
//
// The stream ends with `event: complete` carrying the endpoint's outputs, or
// `event: error`. A ChatInterface Space's endpoint is `chat`, and it takes
// the message alone — it keeps no history of ours — so the agent sends the
// owner's last message and reads the first output back as the answer.
//
// THE URL IS DERIVED, NEVER GIVEN: a Space id `<owner>/<name>` is
// https://<owner>-<name>.hf.space, so the owner's HF_TOKEN (which lets a
// private Space answer) is only ever sent to Hugging Face. HF_SPACES_URL, a
// test-only override, replaces that host for the e2e's stand-in.

export const SPACE_TIMEOUT_MS = 90_000

export function spaceBaseUrl(env: Env, id: string): string {
  if (env.HF_SPACES_URL) return `${env.HF_SPACES_URL.replace(/\/+$/, '')}/${id}`
  const host = id.replace('/', '-').replace(/[._]/g, '-').toLowerCase()
  return `https://${host}.hf.space`
}

export class SpaceError extends Error {}

export async function callSpace(env: Env, id: string, apiName: string, message: string): Promise<string> {
  const base = `${spaceBaseUrl(env, id)}/gradio_api/call/${apiName}`
  const auth: Record<string, string> = env.HF_TOKEN ? { authorization: `Bearer ${env.HF_TOKEN}` } : {}
  const signal = AbortSignal.timeout(SPACE_TIMEOUT_MS)

  const started = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ data: [message] }),
    signal,
  })
  if (!started.ok) throw new SpaceError(`Space ${id} refused the call (${started.status}): is its endpoint "${apiName}"?`)
  const { event_id: eventId } = (await started.json()) as { event_id?: string }
  if (!eventId) throw new SpaceError(`Space ${id} did not start a job`)

  const stream = await fetch(`${base}/${encodeURIComponent(eventId)}`, { headers: auth, signal })
  if (!stream.ok) throw new SpaceError(`Space ${id} answered ${stream.status} for its result`)
  return answerFrom(id, await stream.text())
}

/** The answer in a Gradio event stream: the `complete` event's first output, as text. */
export function answerFrom(id: string, sse: string): string {
  let event = ''
  let last: unknown
  for (const line of sse.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) {
      const data = line.slice(5).trim()
      if (event === 'error') throw new SpaceError(`Space ${id} failed: ${data === 'null' ? 'no reason given' : data}`)
      if (event === 'complete') {
        try {
          last = JSON.parse(data)
        } catch {
          last = data
        }
      }
    }
  }
  if (last === undefined) throw new SpaceError(`Space ${id} ended without an answer`)
  const first = Array.isArray(last) ? last[0] : last
  return asText(first)
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>
    if (typeof o.content === 'string') return o.content
    if (typeof o.text === 'string') return o.text
    if (Array.isArray(value)) {
      // A chatbot's history: the last assistant turn is the answer.
      const turn = [...value].reverse().find((m) => (m as Record<string, unknown>)?.role === 'assistant')
      if (turn) return asText(turn)
    }
  }
  return JSON.stringify(value)
}

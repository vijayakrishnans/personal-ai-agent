import { APICallError } from 'ai'
import type { Env } from './env'
import type { ModelEntry } from './models'

// ASKING THE HUB BEFORE A MODEL IS ADDED, and saying in plain words why a
// Hugging Face call failed.
//
// A model the owner pastes is checked against the Hub's own record of it:
// that it exists, and that at least one Inference Provider serves it FOR
// CHAT (task `conversational`). A video, image or speech model has
// providers too, but the chat cannot call them, so it is refused with that
// reason instead of being added and failing on the first message.
//
// Nothing here is PRO-only: every model the router serves can be called on
// a free account's monthly credits; PRO only gives more of them and lets
// calls go on after they run out.

export const HF_HUB_URL = 'https://huggingface.co'

const TOKEN_HELP =
  'Make a new one at huggingface.co/settings/tokens (type "Read", or fine-grained with "Make calls to Inference Providers") and paste it in Settings → Models.'
const CREDITS_HELP =
  'Free accounts get a small monthly allowance; Hugging Face PRO gives more and keeps going after it (pay as you go): huggingface.co/pricing. Workers AI models keep working meanwhile.'

// The router's policies, which are not provider names.
const POLICIES = new Set(['fastest', 'cheapest', 'preferred'])

// What a non-chat task makes, for the refusal.
const TASK_WORDS: Record<string, string> = {
  'text-to-image': 'makes pictures from text',
  'image-to-image': 'edits pictures',
  'text-to-video': 'makes video from text',
  'image-to-video': 'makes video from a picture',
  'image-text-to-video': 'makes video from a picture and text',
  'text-to-speech': 'makes speech from text',
  'automatic-speech-recognition': 'turns speech into text',
  'feature-extraction': 'makes embeddings',
  'text-classification': 'classifies text',
  'image-classification': 'classifies pictures',
}

export type HubCheck =
  | { ok: true; providers: string[]; gated: boolean; checked: boolean; note: string }
  | { ok: false; status: 422; error: string; message: string }

type Mapping = Record<string, { status?: string; task?: string }>
type HubModel = { pipeline_tag?: string; gated?: boolean | string; inferenceProviderMapping?: Mapping }

const refuse = (error: string, message: string): HubCheck => ({ ok: false, status: 422, error, message })

/** Checks `owner/name[:provider]` against the Hub. A Hub that cannot be reached does not block adding. */
export async function checkHubModel(env: Env, id: string): Promise<HubCheck> {
  const [repo = id, suffix] = id.split(':')
  const url = `${env.HF_HUB_URL || HF_HUB_URL}/api/models/${repo}?expand[]=inferenceProviderMapping&expand[]=pipeline_tag&expand[]=gated`
  let res: Response
  try {
    res = await fetch(url, { headers: env.HF_TOKEN ? { authorization: `Bearer ${env.HF_TOKEN}` } : {}, signal: AbortSignal.timeout(10_000) })
  } catch {
    return { ok: true, providers: [], gated: false, checked: false, note: `Added without checking: Hugging Face could not be reached just now. If ${repo} is not a chat model, the chat will say so.` }
  }
  if (res.status === 401 && env.HF_TOKEN) return refuse('hf_token_rejected', `Hugging Face refused your token (it may be expired, deleted or mistyped). ${TOKEN_HELP}`)
  if (res.status === 401 || res.status === 404) {
    return refuse(
      'model_not_found',
      `There is no ${env.HF_TOKEN ? '' : 'public '}model ${repo} on Hugging Face. Check the spelling: copy the name from the top of the model's page (owner/name, e.g. Qwen/Qwen3.8-27B).` +
        (env.HF_TOKEN ? ' If it is private, your token cannot read it.' : ' If it is private, paste a token that can read it first.'),
    )
  }
  if (!res.ok) {
    return { ok: true, providers: [], gated: false, checked: false, note: `Added without checking: Hugging Face answered ${res.status}. If ${repo} is not a chat model, the chat will say so.` }
  }
  const model = (await res.json().catch(() => ({}))) as HubModel
  const live = Object.entries(model.inferenceProviderMapping ?? {}).filter(([, m]) => !m.status || m.status === 'live')
  const chat = live.filter(([, m]) => m.task === 'conversational').map(([name]) => name)

  if (chat.length === 0) {
    const task = live[0]?.[1].task ?? model.pipeline_tag
    if (live.length > 0 || (task && task in TASK_WORDS)) {
      const a = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`)
      const what = task ? (TASK_WORDS[task] ? `${a(task)} model (it ${TASK_WORDS[task]})` : `${a(task)} model`) : 'not a chat model'
      return refuse('not_a_chat_model', `${repo} is ${what}, not a chat model, so it cannot answer in the chat. Add a text-generation model instead.`)
    }
    return refuse(
      'not_served',
      `No Inference Provider runs ${repo} right now, so it cannot be called from here — on a free account or on PRO. Pick a model whose page lists Inference Providers (huggingface.co/models?inference_provider=all&pipeline_tag=text-generation), or run it in your own Space and add that Space.`,
    )
  }
  if (suffix && !POLICIES.has(suffix) && !chat.includes(suffix)) {
    return refuse('provider_not_serving', `${suffix} does not serve ${repo} for chat. These do: ${chat.join(', ')}. Paste it without “:${suffix}” to let Hugging Face pick.`)
  }
  const gated = Boolean(model.gated)
  const note =
    `Added. Served for chat by ${chat.slice(0, 4).join(', ')}${chat.length > 4 ? ` and ${chat.length - 4} more` : ''}. It runs on your Hugging Face account's monthly credits — a free account works; PRO gives more.` +
    (gated ? ` It is gated: accept its licence at huggingface.co/${repo}, signed in as the token's account, or calls are refused.` : '') +
    (env.HF_TOKEN ? '' : ' Paste a Hugging Face token above to use it.')
  return { ok: true, providers: chat, gated, checked: true, note }
}

/**
 * Why a Hugging Face call failed, for the owner: the reason and what to do.
 * Null when it is not an HTTP error from the router (the caller then says
 * what the error said).
 */
export function hfFailure(entry: ModelEntry, error: unknown): { reason: string; message: string } | null {
  if (entry.provider !== 'huggingface' || !APICallError.isInstance(error)) return null
  const repo = entry.id.split(':')[0]
  const said = providerMessage(error)
  const name = entry.label.replace(/ · Hugging Face$/, '')
  const as = (reason: string, message: string) => ({ reason, message: `${name}: ${message}` })
  switch (error.statusCode) {
    case 401:
      return as('token_rejected', `Hugging Face refused your token (it may be expired, deleted or mistyped). ${TOKEN_HELP}`)
    case 402:
      return as('credits_used_up', `your Hugging Face account has used up its Inference Providers credits for this month. ${CREDITS_HELP}`)
    case 403:
      return as(
        'token_not_allowed',
        `Hugging Face would not let your token call this model. Either the token is fine-grained without "Make calls to Inference Providers" (${TOKEN_HELP.replace(/^Make/, 'make')}), or the model is gated and its licence is not accepted yet: accept it at huggingface.co/${repo}.` +
          (said ? ` (Hugging Face said: ${said})` : ''),
      )
    case 404:
      return as('not_served', `no provider serves this model for chat any more, or its name is wrong. Remove it in Settings → Models and add another.${said ? ` (Hugging Face said: ${said})` : ''}`)
    case 429:
      return as('rate_limited', 'too many requests just now. Wait a minute and try again, or pick another model.')
    default:
      if (/not a chat model|not supported for task|does not support chat/i.test(said)) {
        return as('not_a_chat_model', `this is not a chat model (it is for pictures, video or audio), so it cannot answer here. Remove it in Settings → Models.`)
      }
      if (error.statusCode !== undefined && error.statusCode >= 500) {
        return as('provider_down', `the provider serving it is down or busy (${error.statusCode}). Try again shortly, or add it with “:fastest” to let Hugging Face pick another.`)
      }
      return null
  }
}

function providerMessage(error: APICallError): string {
  let said = ''
  try {
    const body = JSON.parse(error.responseBody ?? '') as { error?: string | { message?: string }; message?: string }
    said = typeof body.error === 'string' ? body.error : (body.error?.message ?? body.message ?? '')
  } catch {
    said = error.message ?? ''
  }
  return String(said).slice(0, 200)
}

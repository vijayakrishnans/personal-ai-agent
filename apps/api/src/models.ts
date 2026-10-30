import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { createWorkersAI } from 'workers-ai-provider'
import type { Env } from './env'
import type { StoredModel } from './memory'

// THE MODELS THE AGENT OFFERS, in three kinds:
//
//   workers-ai   built in, through the Worker's own `AI` binding — no key, so
//                a fresh deployment answers with nothing but its access key
//   huggingface  any model Hugging Face's Inference Providers serve — the
//                models HuggingChat runs included — through the router's
//                OpenAI-compatible API, with the owner's HF_TOKEN. An id may
//                carry a provider policy suffix, `:fastest`, `:cheapest`, or
//                a provider's name (`:groq`), as the router reads it
//   space        a Gradio Space, called through its HTTP API: the owner's
//                own Space, a public one, or a private one HF_TOKEN can read
//
// The Hugging Face kinds come from the HF_MODELS secret (offered from the
// start) and from the page (kept in the agent's memory). Nothing else is
// offered, and /api/chat refuses a model that is not in this list.

export type Provider = 'workers-ai' | 'huggingface' | 'space'

export type ModelEntry = {
  key: string
  provider: Provider
  id: string
  label: string
  tools: boolean
  apiName?: string
  source: 'built-in' | 'secret' | 'added'
}

export const DEFAULT_MODEL = '@cf/moonshotai/kimi-k2.6'

export const WORKERS_AI_MODELS: ModelEntry[] = [
  { key: `workers-ai:${DEFAULT_MODEL}`, provider: 'workers-ai', id: DEFAULT_MODEL, label: 'Kimi K2.6 · Workers AI', tools: true, source: 'built-in' },
  {
    key: 'workers-ai:@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    provider: 'workers-ai',
    id: '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
    label: 'Llama 3.3 70B · Workers AI',
    tools: true,
    source: 'built-in',
  },
]

export const HF_ROUTER_URL = 'https://router.huggingface.co/v1'

// A Hub repo id (`owner/name`), as the Hub spells one; a router id may add
// `:<provider or policy>`. A Space's Gradio endpoint is a path segment.
export const HF_MODEL_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,96}(:[a-z0-9-]{1,40})?$/
export const SPACE_ID = /^[A-Za-z0-9][\w.-]{0,95}\/[\w.-]{1,96}$/
export const API_NAME_PATTERN = /^[A-Za-z_][\w-]{0,63}$/

export const modelKey = (provider: Provider, id: string) => `${provider}:${id}`

/**
 * HF_MODELS as the owner wrote it: comma- or newline-separated, a Space as
 * `space:<owner>/<name>` (with `#<endpoint>` when its chat endpoint is not
 * `chat`). An entry that does not parse is dropped, never guessed at.
 */
export function parseHfModels(raw: string | undefined): ModelEntry[] {
  const out: ModelEntry[] = []
  for (const part of (raw ?? '').split(/[,\n]/)) {
    const entry = part.trim()
    if (!entry) continue
    if (entry.startsWith('space:')) {
      const [id = '', apiName] = entry.slice('space:'.length).split('#')
      if (!SPACE_ID.test(id) || (apiName !== undefined && !API_NAME_PATTERN.test(apiName))) continue
      out.push({ key: modelKey('space', id), provider: 'space', id, label: `${id} · Space`, tools: false, apiName: apiName ?? 'chat', source: 'secret' })
    } else if (HF_MODEL_ID.test(entry)) {
      out.push({ key: modelKey('huggingface', entry), provider: 'huggingface', id: entry, label: `${entry} · Hugging Face`, tools: true, source: 'secret' })
    }
  }
  return out
}

/** Every model the agent offers, in order: built in, the secret's, the page's. Keys are unique; the first wins. */
export function catalog(env: Env, stored: StoredModel[]): ModelEntry[] {
  const added: ModelEntry[] = stored.map((m) => ({
    key: modelKey(m.provider, m.id),
    provider: m.provider,
    id: m.id,
    label: m.label,
    tools: m.provider === 'space' ? false : m.tools,
    ...(m.provider === 'space' ? { apiName: m.apiName ?? 'chat' } : {}),
    source: 'added',
  }))
  const seen = new Set<string>()
  return [...WORKERS_AI_MODELS, ...parseHfModels(env.HF_MODELS), ...added].filter((m) => !seen.has(m.key) && seen.add(m.key))
}

/** The language model for a Workers AI or Hugging Face entry. A Space is not one: spaces.ts calls it. */
export function languageModel(env: Env, entry: ModelEntry): LanguageModel {
  if (entry.provider === 'workers-ai') {
    return createWorkersAI({ binding: env.AI })(entry.id as Parameters<ReturnType<typeof createWorkersAI>>[0])
  }
  if (entry.provider === 'huggingface') {
    return createOpenAICompatible({
      name: 'huggingface',
      baseURL: env.HF_ROUTER_URL || HF_ROUTER_URL,
      apiKey: env.HF_TOKEN,
    })(entry.id)
  }
  throw new Error(`${entry.key} is a Space, not a language model`)
}

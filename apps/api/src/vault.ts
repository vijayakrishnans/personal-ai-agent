// Keys the owner pastes into the page (Settings → Models), rather than storing
// them as Orun secrets: the Hugging Face token and the OpenAlex key. Each is
// kept in MEMORY encrypted (AES-GCM) under a key derived from
// AGENT_ACCESS_KEY, so the Durable Object's storage alone does not give it
// away. None is ever sent back to the page, put in a prompt or logged; each
// goes only to its own service, standing in for its secret for one request.
//
// The secret, when stored, wins. Rotating the access key makes a pasted key
// unreadable: it is then treated as absent, and the page asks for it again.

import type { Env } from './env'
import type { AgentMemory } from './memory'

const SALT = new TextEncoder().encode('personal-ai-agent/vault/v1')

export const KEYS = {
  hf: {
    vault: 'hf-token',
    secret: 'HF_TOKEN',
    // A Hugging Face user access token: hf_ and letters and digits.
    pattern: /^hf_[A-Za-z0-9]{30,200}$/,
    invalid: 'That is not a Hugging Face access token (hf_ followed by letters and digits).',
  },
  openalex: {
    vault: 'openalex-key',
    secret: 'OPENALEX_API_KEY',
    pattern: /^[A-Za-z0-9_-]{16,128}$/,
    invalid: 'That is not an OpenAlex API key (letters, digits, - and _, from openalex.org/settings/api).',
  },
} as const satisfies Record<string, { vault: string; secret: keyof Env; pattern: RegExp; invalid: string }>

export type KeyName = keyof typeof KEYS
export const KEY_NAMES = Object.keys(KEYS) as KeyName[]
export const isKeyName = (name: string): name is KeyName => Object.hasOwn(KEYS, name)

/** Where a key comes from: its secret, the page, one that can no longer be read (the access key changed), or nowhere. */
export type KeySource = 'secret' | 'app' | 'unreadable' | null
export type HfTokenSource = KeySource

async function keyFor(accessKey: string, vaultName: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(accessKey), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode(vaultName) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0))

export async function seal(accessKey: string, value: string, vaultName: string = KEYS.hf.vault): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(accessKey, vaultName), new TextEncoder().encode(value)))
  return `v1:${b64(iv)}:${b64(sealed)}`
}

/** The value, or null when there is none or it was sealed under another key. */
export async function unseal(accessKey: string, stored: string | null, vaultName: string = KEYS.hf.vault): Promise<string | null> {
  const [version, iv, sealed] = stored?.split(':') ?? []
  if (version !== 'v1' || !iv || !sealed) return null
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await keyFor(accessKey, vaultName), unb64(sealed))
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

/**
 * Every key, from its secret or the page: the env this request runs with
 * (pasted keys standing in for their secrets) and where each came from.
 */
export async function withPastedKeys(env: Env, memory: Pick<AgentMemory, 'getVault'>): Promise<{ env: Env; sources: Record<KeyName, KeySource> }> {
  const sources = {} as Record<KeyName, KeySource>
  let out = env
  for (const name of KEY_NAMES) {
    const { vault, secret } = KEYS[name]
    if (env[secret]) { sources[name] = 'secret'; continue }
    const stored = await memory.getVault(vault)
    if (!stored) { sources[name] = null; continue }
    const value = await unseal(env.AGENT_ACCESS_KEY ?? '', stored, vault)
    sources[name] = value ? 'app' : 'unreadable'
    if (value) out = { ...out, [secret]: value }
  }
  return { env: out, sources }
}

export async function storeKey(env: Env, memory: Pick<AgentMemory, 'setVault'>, name: KeyName, value: string): Promise<void> {
  await memory.setVault(KEYS[name].vault, await seal(env.AGENT_ACCESS_KEY ?? '', value, KEYS[name].vault))
}

export async function forgetKey(memory: Pick<AgentMemory, 'setVault'>, name: KeyName): Promise<void> {
  await memory.setVault(KEYS[name].vault, null)
}

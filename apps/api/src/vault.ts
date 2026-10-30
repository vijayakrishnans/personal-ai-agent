// A Hugging Face token the owner pastes into the page, rather than storing it
// as an Orun secret. It is kept in MEMORY encrypted (AES-GCM) under a key
// derived from AGENT_ACCESS_KEY, so the Durable Object's storage alone does
// not give it away. It is never sent back to the page, never put in a prompt
// and never logged; only Hugging Face sees it, as the bearer token
// spaces.ts, music.ts and models.ts already send for HF_TOKEN.
//
// HF_TOKEN stored as a secret wins. Rotating the access key makes the stored
// token unreadable: it is then treated as absent, and the page asks for it
// again.

import type { Env } from './env'
import type { AgentMemory } from './memory'

const VAULT_NAME = 'hf-token'
const SALT = new TextEncoder().encode('personal-ai-agent/vault/v1')

/** A Hugging Face user access token: hf_ and letters and digits. */
export const HF_TOKEN_PATTERN = /^hf_[A-Za-z0-9]{30,200}$/

async function keyFor(accessKey: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(accessKey), 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: SALT, info: new TextEncoder().encode(VAULT_NAME) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  )
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))
const unb64 = (text: string) => Uint8Array.from(atob(text), (ch) => ch.charCodeAt(0))

export async function seal(accessKey: string, token: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(accessKey), new TextEncoder().encode(token)))
  return `v1:${b64(iv)}:${b64(sealed)}`
}

/** The token, or null when there is none or it was sealed under another key. */
export async function unseal(accessKey: string, stored: string | null): Promise<string | null> {
  const [version, iv, sealed] = stored?.split(':') ?? []
  if (version !== 'v1' || !iv || !sealed) return null
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, await keyFor(accessKey), unb64(sealed))
    return new TextDecoder().decode(plain)
  } catch {
    return null
  }
}

export type HfTokenSource = 'secret' | 'app' | 'unreadable' | null

/**
 * Where the Hugging Face token comes from: the Orun secret, the one pasted in
 * the page, one that can no longer be read (the access key changed), or none.
 */
export async function hfToken(env: Env, memory: Pick<AgentMemory, 'getVault'>): Promise<{ token?: string; source: HfTokenSource }> {
  if (env.HF_TOKEN) return { token: env.HF_TOKEN, source: 'secret' }
  const stored = await memory.getVault(VAULT_NAME)
  if (!stored) return { source: null }
  const token = await unseal(env.AGENT_ACCESS_KEY ?? '', stored)
  return token ? { token, source: 'app' } : { source: 'unreadable' }
}

export async function storeHfToken(env: Env, memory: Pick<AgentMemory, 'setVault'>, token: string): Promise<void> {
  await memory.setVault(VAULT_NAME, await seal(env.AGENT_ACCESS_KEY ?? '', token))
}

export async function forgetHfToken(memory: Pick<AgentMemory, 'setVault'>): Promise<void> {
  await memory.setVault(VAULT_NAME, null)
}

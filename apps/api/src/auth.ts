// The owner's door. Every /api route needs `Authorization: Bearer <key>`,
// the key being AGENT_ACCESS_KEY. Compared as SHA-256 digests in constant
// time, so neither the key's length nor its prefix leaks through timing.

const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))

export async function keyMatches(presented: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([digest(presented), digest(expected)])
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0)
  return diff === 0
}

export function bearer(header: string | undefined): string | null {
  const m = /^Bearer\s+(.+)$/i.exec(header ?? '')
  return m?.[1]?.trim() || null
}

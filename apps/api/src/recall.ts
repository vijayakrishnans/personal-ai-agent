// FINDING WHAT THE AGENT KEPT, two ways at once (memory.ts's recall):
//
//   by its words    a memory that holds the query's words, ranked by how
//                   many it holds. Exact: a code, a number, a rare name.
//   by its meaning  a memory whose embedding lies near the query's: "where do
//                   I live?" finds "I'm from Kochi" with no word in common.
//
// The two rankings are merged by reciprocal rank fusion — each list adds
// 1 / (K + rank) to a memory's score — so a memory both find comes first and
// either one alone still counts. No tuning between incomparable scores.
//
// Embeddings come from Workers AI through the Worker's own AI binding (no key)
// and are kept beside the memories in the Durable Object: at most a few
// hundred memories, so comparing against all of them is a millisecond's work
// and no vector database is needed. If Workers AI fails, recall is by words
// alone; it never fails because of meaning.

export const EMBEDDING_MODEL = '@cf/baai/bge-m3'
// What is embedded of a memory: its question and text, this much of it.
export const MAX_EMBEDDED_CHARS = 2000
// Texts embedded in one call, and memories filled in per recall.
export const EMBED_BATCH = 50
export const BACKFILL_PER_RECALL = 100
// Below this a memory is not near the query at all, only least far.
export const MIN_SIMILARITY = 0.4
const RRF_K = 60

type EmbeddingOutput = { data?: number[][]; shape?: number[] }

/** One vector per text, or null when Workers AI cannot be asked or fails. */
export async function embed(ai: Ai | undefined, texts: string[]): Promise<number[][] | null> {
  if (!ai || texts.length === 0) return texts.length === 0 ? [] : null
  try {
    const out: number[][] = []
    for (let i = 0; i < texts.length; i += EMBED_BATCH) {
      const batch = texts.slice(i, i + EMBED_BATCH)
      const res = (await (ai as unknown as { run: (m: string, i: unknown) => Promise<EmbeddingOutput> }).run(EMBEDDING_MODEL, { text: batch })) ?? {}
      if (!Array.isArray(res.data) || res.data.length !== batch.length) return null
      out.push(...res.data)
    }
    return out
  } catch (error) {
    console.error('embedding failed', error)
    return null
  }
}

/** What of a memory is embedded. */
export const embeddedText = (m: { text: string; question: string | null }) =>
  (m.question ? `${m.question}\n${m.text}` : m.text).slice(0, MAX_EMBEDDED_CHARS)

/** A vector as kept in SQL: its float32 bytes, base64. */
export function encodeVector(v: number[]): string {
  const bytes = new Uint8Array(new Float32Array(v).buffer)
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

export function decodeVector(s: string): Float32Array {
  const bytes = Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
  return new Float32Array(bytes.buffer)
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Ids by meaning: nearest first, only those near enough. */
export function byMeaning(query: ArrayLike<number>, vectors: { id: number; vector: Float32Array }[]): number[] {
  return vectors
    .map(({ id, vector }) => ({ id, score: cosine(query, vector) }))
    .filter((v) => v.score >= MIN_SIMILARITY)
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .map((v) => v.id)
}

/** Ids by words: the most of the query's words first, then the newest. */
export function byWords(words: string[], memories: { id: number; haystack: string }[]): number[] {
  return memories
    .map((m) => ({ id: m.id, hits: words.filter((w) => m.haystack.includes(w)).length }))
    .filter((m) => m.hits > 0)
    .sort((a, b) => b.hits - a.hits || b.id - a.id)
    .map((m) => m.id)
}

/** The two rankings as one: reciprocal rank fusion. */
export function fuse(...rankings: number[][]): number[] {
  const score = new Map<number, number>()
  for (const ranking of rankings) ranking.forEach((id, rank) => score.set(id, (score.get(id) ?? 0) + 1 / (RRF_K + rank + 1)))
  return [...score.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]).map(([id]) => id)
}

import type { Env } from './env'

// SCHOLARLY RESEARCH, on OpenAlex: an open index of some 250 million works —
// papers, books, datasets — with their authors, venues, citations and open
// access copies. Two tools (agent.ts):
//
//   papers  search works by topic: by relevance, most cited, or newest;
//           optionally from a year on
//   paper   one work by DOI or OpenAlex id: its details, the works that cite
//           it most, and whether it exists at all — which is how a citation
//           is checked rather than trusted
//
// No key is needed, but keyless calls share a small daily budget per IP
// address — on Workers, with everyone else's. OPENALEX_API_KEY (free, at
// openalex.org/settings/api) gives the agent its own. LOOKUP_URL, a
// test-only override, reaches a stand-in at <LOOKUP_URL>/openalex.

const TIMEOUT_MS = 15_000
const SELECT = 'id,doi,title,publication_year,cited_by_count,authorships,primary_location,open_access,abstract_inverted_index,type'

type Work = {
  id: string
  doi?: string | null
  title?: string | null
  publication_year?: number | null
  cited_by_count?: number
  type?: string
  authorships?: { author?: { display_name?: string } }[]
  primary_location?: { source?: { display_name?: string } | null; landing_page_url?: string | null } | null
  open_access?: { oa_url?: string | null } | null
  abstract_inverted_index?: Record<string, number[]> | null
  referenced_works_count?: number
}

export type Paper = {
  id: string
  title: string
  year: number | null
  authors: string[]
  venue: string | null
  citations: number
  doi: string | null
  url: string
  openAccess: string | null
  abstract: string
}

function base(env: Env): string {
  return env.LOOKUP_URL ? `${env.LOOKUP_URL.replace(/\/+$/, '')}/openalex` : 'https://api.openalex.org'
}

async function openalex<T>(env: Env, path: string, params: Record<string, string>): Promise<T> {
  const q = new URLSearchParams(params)
  if (env.OPENALEX_API_KEY) q.set('api_key', env.OPENALEX_API_KEY)
  const res = await fetch(`${base(env)}${path}?${q}`, { headers: { accept: 'application/json', 'user-agent': 'personal-agent/1.0 (+https://orunbase.com)' }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (res.status === 404) throw new NotFound()
  if (res.status === 429) throw new Error('OpenAlex is busy or its free daily budget is spent; OPENALEX_API_KEY gives the agent its own')
  if (!res.ok) throw new Error(`OpenAlex answered ${res.status}`)
  return (await res.json()) as T
}

class NotFound extends Error {}

const failed = (error: unknown) => ({ error: String((error as Error)?.message ?? error).slice(0, 200) })

/** An abstract from OpenAlex's inverted index (word → positions). */
export function abstractText(index: Record<string, number[]> | null | undefined, max = 700): string {
  if (!index) return ''
  const words: string[] = []
  for (const [word, positions] of Object.entries(index)) for (const p of positions) words[p] = word
  const text = words.filter(Boolean).join(' ')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function paperOf(w: Work): Paper {
  const doi = w.doi ? w.doi.replace(/^https:\/\/doi\.org\//, '') : null
  return {
    id: w.id.replace('https://openalex.org/', ''),
    title: w.title ?? '(untitled)',
    year: w.publication_year ?? null,
    authors: (w.authorships ?? []).map((a) => a.author?.display_name ?? '').filter(Boolean).slice(0, 6),
    venue: w.primary_location?.source?.display_name ?? null,
    citations: w.cited_by_count ?? 0,
    doi,
    url: doi ? `https://doi.org/${doi}` : (w.primary_location?.landing_page_url ?? w.id),
    openAccess: w.open_access?.oa_url ?? null,
    abstract: abstractText(w.abstract_inverted_index),
  }
}

const SORTS = { relevance: '', citations: 'cited_by_count:desc', newest: 'publication_date:desc' } as const
export type PaperSort = keyof typeof SORTS

export async function papers(env: Env, opts: { query: string; sort?: PaperSort; fromYear?: number }) {
  // Titles and abstracts only: a full-text match ranks any paper that merely
  // mentions the words — sorted by citations, the most cited of those.
  const words = opts.query.replace(/[,:|]/g, ' ').replace(/\s+/g, ' ').trim()
  const filters = [`title_and_abstract.search:${words}`]
  if (opts.fromYear) filters.push(`from_publication_date:${opts.fromYear}-01-01`)
  const params: Record<string, string> = { filter: filters.join(','), per_page: '8', select: SELECT }
  const sort = SORTS[opts.sort ?? 'relevance']
  if (sort) params.sort = sort
  try {
    const r = await openalex<{ meta?: { count?: number }; results: Work[] }>(env, '/works', params)
    return { found: r.meta?.count ?? r.results.length, papers: r.results.map(paperOf) }
  } catch (error) {
    return failed(error)
  }
}

/** A DOI (bare, doi:, or a doi.org URL) or an OpenAlex work id, as OpenAlex takes it. */
export function workKey(id: string): string | null {
  const s = id.trim()
  const w = /(?:^|openalex\.org\/)(W\d{3,})$/i.exec(s)
  if (w) return (w[1] as string).toUpperCase()
  const doi = /(10\.\d{4,9}\/\S+)$/.exec(s.replace(/^doi:\s*/i, ''))
  return doi ? `doi:${doi[1]}` : null
}

export async function paper(env: Env, opts: { id: string }) {
  const key = workKey(opts.id)
  if (!key) return { error: 'give a DOI (10.xxxx/…) or an OpenAlex id (W…)' }
  try {
    const w = await openalex<Work>(env, `/works/${encodeURIComponent(key)}`, { select: `${SELECT},referenced_works_count` })
    const found = paperOf(w)
    const citing = await openalex<{ results: Work[] }>(env, '/works', {
      filter: `cites:${found.id}`,
      sort: 'cited_by_count:desc',
      per_page: '5',
      select: 'id,doi,title,publication_year,cited_by_count,authorships,primary_location',
    }).catch(() => ({ results: [] as Work[] }))
    return {
      exists: true,
      ...found,
      abstract: abstractText(w.abstract_inverted_index, 1500),
      type: w.type ?? null,
      references: w.referenced_works_count ?? null,
      mostCitedBy: citing.results.map((c) => {
        const p = paperOf(c)
        return { title: p.title, year: p.year, citations: p.citations, url: p.url }
      }),
    }
  } catch (error) {
    if (error instanceof NotFound) return { exists: false, error: `no work with ${key.replace(/^doi:/, 'DOI ')} — the reference may be wrong or invented` }
    return failed(error)
  }
}

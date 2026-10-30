import type { Env } from './env'

// THE AGENT'S WINDOW ON THE WEB: three tools a model can call, none of them
// shown in the page.
//
//   news       Google News' RSS: the top stories for a country, or the news
//              on a topic. No key. (The feed is for personal, non-commercial
//              reading — which one owner's agent is.)
//   readPage   any http(s) page, fetched by the Worker and turned into plain
//              text, so the model can read an article, a doc or a result.
//   webSearch  a web search through Tavily, offered only once its owner has
//              stored TAVILY_API_KEY; the key is only ever sent to Tavily.
//
// What comes back is the web's, not the owner's: the system prompt tells the
// model to treat it as information, never as instructions. A tool that fails
// answers `{ error }` rather than throwing, so the model can say so or try
// another way. NEWS_URL and WEB_SEARCH_URL are test-only overrides that point
// the tools at a local stand-in.

export const WEB_TIMEOUT_MS = 15_000
export const MAX_PAGE_BYTES = 2_000_000
export const MAX_PAGE_CHARS = 12_000
export const MAX_NEWS = 12
const USER_AGENT = 'Mozilla/5.0 (compatible; personal-agent/1.0; +https://orunbase.com)'

export type NewsItem = { title: string; source: string; published: string; link: string }
export type Page = { url: string; title: string; text: string; truncated: boolean }
export type SearchResult = { title: string; url: string; snippet: string; published?: string }
export type WebError = { error: string }

/** Web search is offered once a Tavily key is stored. */
export const webSearchConnected = (env: Env) => Boolean(env.TAVILY_API_KEY)

const get = (url: string, init: RequestInit = {}) =>
  fetch(url, { ...init, redirect: 'follow', signal: AbortSignal.timeout(WEB_TIMEOUT_MS), headers: { 'user-agent': USER_AGENT, ...(init.headers ?? {}) } })

const failed = (what: string, error: unknown): WebError => ({ error: `${what}: ${String((error as Error)?.message ?? error).slice(0, 200)}` })

// ── news ────────────────────────────────────────────────────────────────────

export async function news(env: Env, opts: { query?: string; country?: string }): Promise<{ items: NewsItem[] } | WebError> {
  const country = /^[a-z]{2}$/i.test(opts.country ?? '') ? (opts.country as string).toUpperCase() : 'US'
  const edition = `hl=en-${country}&gl=${country}&ceid=${country}:en`
  const base = (env.NEWS_URL ?? 'https://news.google.com/rss').replace(/\/+$/, '')
  const query = opts.query?.trim()
  const url = query ? `${base}/search?q=${encodeURIComponent(query)}&${edition}` : `${base}?${edition}`
  try {
    const res = await get(url)
    if (!res.ok) return { error: `the news feed answered ${res.status}` }
    return { items: newsItems(await res.text()) }
  } catch (error) {
    return failed('the news feed failed', error)
  }
}

/** The items of an RSS feed: title, source, publication date and link. */
export function newsItems(rss: string): NewsItem[] {
  const items: NewsItem[] = []
  for (const [, item] of rss.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const field = (name: string) => decode(stripCdata(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(item ?? '')?.[1] ?? '')).trim()
    const source = field('source')
    let title = field('title')
    // Google News appends " - <source>" to every title; the source is its own field.
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3))
    if (title) items.push({ title, source, published: field('pubDate'), link: field('link') })
    if (items.length >= MAX_NEWS) break
  }
  return items
}

const stripCdata = (s: string) => s.replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')

// ── readPage ────────────────────────────────────────────────────────────────

export async function readPage(url: string): Promise<Page | WebError> {
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return { error: `not a URL: ${url.slice(0, 200)}` }
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return { error: 'only http(s) pages can be read' }
  try {
    const res = await get(target.toString(), { headers: { accept: 'text/html, text/plain, application/json, application/xml;q=0.9, */*;q=0.5' } })
    if (!res.ok) return { error: `${target.host} answered ${res.status}` }
    const type = res.headers.get('content-type') ?? ''
    if (type && !/text\/|json|xml/i.test(type)) return { error: `${target.host} sent ${type.split(';')[0]}, not a page that can be read as text` }
    const raw = await readCapped(res, MAX_PAGE_BYTES)
    const html = /html/i.test(type) || /^\s*<(!doctype|html)/i.test(raw)
    const { title, text } = html ? htmlToText(raw) : { title: '', text: raw.trim() }
    return { url: res.url || target.toString(), title, text: text.slice(0, MAX_PAGE_CHARS), truncated: text.length > MAX_PAGE_CHARS }
  } catch (error) {
    return failed(`reading ${target.host} failed`, error)
  }
}

/** A body as text, read no further than `max` bytes. */
async function readCapped(res: Response, max: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (size < max) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    size += value.byteLength
  }
  await reader.cancel().catch(() => {})
  const all = new Uint8Array(Math.min(size, max))
  let at = 0
  for (const c of chunks) {
    const part = c.subarray(0, all.length - at)
    all.set(part, at)
    at += part.byteLength
    if (at >= all.length) break
  }
  return new TextDecoder().decode(all)
}

/**
 * An HTML page as readable text: its title, and the text of its <article> or
 * <main> when it has one (else <body>), with scripts, styles and navigation
 * dropped and block elements on lines of their own.
 */
// A tag's attributes, quoted values included — one may hold a `>`.
const ATTRS = `(?:[^>"']|"[^"]*"|'[^']*')*`
const tags = (names: string) => new RegExp(`<\\/?(?:${names})\\b${ATTRS}>`, 'gi')

export function htmlToText(html: string): { title: string; text: string } {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim()
  let body = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|template|iframe|head|nav|footer|form)\b[\s\S]*?<\/\1>/gi, '')
  const main = /<(article|main)\b[^>]*>([\s\S]*)<\/\1>/i.exec(body)
  if (main && (main[2] ?? '').replace(/<[^>]+>/g, '').trim().length > 200) body = main[2] ?? ''
  const text = decode(
    body
      .replace(new RegExp(`<li\\b${ATTRS}>`, 'gi'), '\n- ')
      .replace(tags('br|hr|p|div|section|article|main|header|h[1-6]|ul|ol|table|tr|blockquote|pre|figure|figcaption|dd|dt'), '\n')
      .replace(/<\/t[dh]>/gi, ' ')
      .replace(new RegExp(`<${ATTRS}>`, 'g'), ''),
  )
  const lines = text.split('\n').map((line) => line.replace(/[ \t\f\v\u00a0]+/g, ' ').trim())
  return { title, text: dropMenus(lines).join('\n').replace(/\n{3,}/g, '\n\n').trim() }
}

/**
 * Lines without the page's menus: a run of MENU_RUN or more short list items
 * (blank lines between them aside) is a menu or a language picker, not the
 * page's content — it would spend the text budget on links.
 */
export const MENU_RUN = 15
function dropMenus(lines: string[]): string[] {
  const short = (line: string) => line.startsWith('- ') && line.length <= 42
  const out: string[] = []
  for (let i = 0; i < lines.length; ) {
    const line = lines[i] as string
    if (!short(line)) {
      out.push(line)
      i++
      continue
    }
    let end = i
    let items = 0
    while (end < lines.length && (short(lines[end] as string) || lines[end] === '')) {
      if (lines[end] !== '') items++
      end++
    }
    if (items < MENU_RUN) out.push(...lines.slice(i, end))
    i = end
  }
  return out
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

// ── webSearch ───────────────────────────────────────────────────────────────

export async function webSearch(env: Env, opts: { query: string; news?: boolean }): Promise<{ results: SearchResult[] } | WebError> {
  if (!env.TAVILY_API_KEY) return { error: 'web search is not connected (TAVILY_API_KEY is not stored)' }
  try {
    const res = await get(env.WEB_SEARCH_URL ?? 'https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.TAVILY_API_KEY}` },
      body: JSON.stringify({ query: opts.query, topic: opts.news ? 'news' : 'general', search_depth: 'basic', max_results: 8 }),
    })
    if (!res.ok) return { error: `web search answered ${res.status}` }
    const body = (await res.json()) as { results?: { title?: string; url?: string; content?: string; published_date?: string }[] }
    return {
      results: (body.results ?? []).map((r) => ({
        title: r.title ?? '',
        url: r.url ?? '',
        snippet: (r.content ?? '').slice(0, 600),
        ...(r.published_date ? { published: r.published_date } : {}),
      })),
    }
  } catch (error) {
    return failed('web search failed', error)
  }
}

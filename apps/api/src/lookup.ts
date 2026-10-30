import type { Env } from './env'

// WHERE THE AGENT LOOKS THINGS UP: open services that need no key, each a
// tool the model can call (agent.ts). Every answer is trimmed to what a model
// needs and carries the `url` it came from, so the agent can cite it and
// readPage may open it. A service that fails answers `{ error }`.
//
//   weather       Open-Meteo: now and the next days, for a place by name
//   exchangeRate  Frankfurter: the European Central Bank's daily rates
//   wikipedia     Wikipedia: a search, then the best match's summary
//   dictionary    Wiktionary: what a word means
//   hackerNews    Hacker News (Algolia): stories on a topic, or the front page
//   arxiv         arXiv: research papers, newest first
//   books         Open Library: books by title, author or subject
//
// LOOKUP_URL is a test-only override: every service is then reached at
// <LOOKUP_URL>/<service>/…, a local stand-in.

export const LOOKUP_TIMEOUT_MS = 15_000
const USER_AGENT = 'personal-agent/1.0 (+https://orunbase.com)'

export type LookupError = { error: string }

const BASES = {
  geocode: 'https://geocoding-api.open-meteo.com/v1',
  forecast: 'https://api.open-meteo.com/v1',
  rates: 'https://api.frankfurter.dev/v1',
  wikipedia: 'https://{lang}.wikipedia.org',
  wiktionary: 'https://en.wiktionary.org',
  hn: 'https://hn.algolia.com/api/v1',
  arxiv: 'https://export.arxiv.org/api',
  books: 'https://openlibrary.org',
} as const

function base(env: Env, service: keyof typeof BASES, lang = 'en'): string {
  if (env.LOOKUP_URL) return `${env.LOOKUP_URL.replace(/\/+$/, '')}/${service}`
  return BASES[service].replace('{lang}', lang)
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/json' }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
  if (!res.ok) throw new LookupFailed(res.status)
  return (await res.json()) as T
}

async function getText(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS) })
  if (!res.ok) throw new LookupFailed(res.status)
  return res.text()
}

class LookupFailed extends Error {
  constructor(readonly status: number) {
    super(`answered ${status}`)
  }
}

const failed = (service: string, error: unknown): LookupError => ({
  error: `${service} ${error instanceof LookupFailed ? error.message : `failed: ${String((error as Error)?.message ?? error).slice(0, 160)}`}`,
})

const q = encodeURIComponent
const plain = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()

// ── weather ─────────────────────────────────────────────────────────────────

// WMO weather codes, as Open-Meteo reports them.
const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
}
const sky = (code: number | undefined) => (code === undefined ? 'unknown' : (WMO[code] ?? `code ${code}`))

type Place = { name: string; latitude: number; longitude: number; country?: string; admin1?: string; timezone?: string }

export async function weather(env: Env, opts: { place: string; country?: string; days?: number }) {
  const days = Math.min(Math.max(opts.days ?? 3, 1), 7)
  const country = /^[a-z]{2}$/i.test(opts.country ?? '') ? `&countryCode=${(opts.country as string).toUpperCase()}` : ''
  try {
    const found = await getJson<{ results?: Place[] }>(`${base(env, 'geocode')}/search?name=${q(opts.place)}&count=1&language=en${country}`)
    const place = found.results?.[0]
    if (!place) return { error: `no place called "${opts.place}"${country ? ' in that country' : ''}` }
    const f = await getJson<{
      timezone?: string
      current?: { time: string; temperature_2m: number; apparent_temperature: number; relative_humidity_2m: number; precipitation: number; weather_code: number; wind_speed_10m: number }
      daily?: { time: string[]; weather_code: number[]; temperature_2m_max: number[]; temperature_2m_min: number[]; precipitation_probability_max: (number | null)[] }
    }>(
      `${base(env, 'forecast')}/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m' +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=${days}`,
    )
    const c = f.current
    return {
      place: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      timezone: f.timezone ?? place.timezone,
      now: c && {
        time: c.time,
        sky: sky(c.weather_code),
        temperatureC: c.temperature_2m,
        feelsLikeC: c.apparent_temperature,
        humidityPercent: c.relative_humidity_2m,
        precipitationMm: c.precipitation,
        windKmh: c.wind_speed_10m,
      },
      days: (f.daily?.time ?? []).map((date, i) => ({
        date,
        sky: sky(f.daily?.weather_code[i]),
        minC: f.daily?.temperature_2m_min[i],
        maxC: f.daily?.temperature_2m_max[i],
        rainChancePercent: f.daily?.precipitation_probability_max[i] ?? null,
      })),
      url: `https://open-meteo.com/en/docs#latitude=${place.latitude}&longitude=${place.longitude}`,
    }
  } catch (error) {
    return failed('the weather service', error)
  }
}

// ── exchangeRate ────────────────────────────────────────────────────────────

export async function exchangeRate(env: Env, opts: { from: string; to: string[]; amount?: number }) {
  const from = opts.from.toUpperCase()
  const to = opts.to.map((c) => c.toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c) && c !== from)
  if (!/^[A-Z]{3}$/.test(from) || to.length === 0) return { error: 'currencies are three-letter codes, e.g. USD, INR, EUR' }
  const amount = opts.amount ?? 1
  try {
    const r = await getJson<{ date: string; base: string; rates: Record<string, number> }>(`${base(env, 'rates')}/latest?base=${from}&symbols=${to.join(',')}`)
    return {
      date: r.date,
      amount,
      from,
      converted: Object.fromEntries(Object.entries(r.rates).map(([cur, rate]) => [cur, Math.round(rate * amount * 10_000) / 10_000])),
      source: 'European Central Bank reference rates, via Frankfurter',
      url: `https://api.frankfurter.dev/v1/latest?base=${from}`,
    }
  } catch (error) {
    return failed('the exchange-rate service', error)
  }
}

// ── wikipedia ───────────────────────────────────────────────────────────────

export async function wikipedia(env: Env, opts: { query: string; language?: string }) {
  const lang = /^[a-z]{2,3}$/.test(opts.language ?? '') ? (opts.language as string) : 'en'
  const wiki = base(env, 'wikipedia', lang)
  try {
    const found = await getJson<{ query?: { search?: { title: string; snippet: string }[] } }>(
      `${wiki}/w/api.php?action=query&list=search&srsearch=${q(opts.query)}&srlimit=5&format=json&origin=*`,
    )
    const hits = found.query?.search ?? []
    if (hits.length === 0) return { error: `Wikipedia has no article on "${opts.query}"` }
    const best = hits[0] as { title: string }
    const page = await getJson<{ title: string; description?: string; extract?: string; content_urls?: { desktop?: { page?: string } } }>(
      `${wiki}/api/rest_v1/page/summary/${q(best.title.replace(/ /g, '_'))}`,
    )
    return {
      title: page.title,
      description: page.description ?? '',
      summary: (page.extract ?? '').slice(0, 2500),
      url: page.content_urls?.desktop?.page ?? `https://${lang}.wikipedia.org/wiki/${q(best.title.replace(/ /g, '_'))}`,
      otherArticles: hits.slice(1).map((h) => ({ title: h.title, snippet: plain(h.snippet).slice(0, 200) })),
    }
  } catch (error) {
    return failed('Wikipedia', error)
  }
}

// ── dictionary ──────────────────────────────────────────────────────────────

export async function dictionary(env: Env, opts: { word: string }) {
  const word = opts.word.trim()
  try {
    const entries = await getJson<{ en?: { partOfSpeech: string; definitions: { definition: string; examples?: string[] }[] }[] }>(
      `${base(env, 'wiktionary')}/api/rest_v1/page/definition/${q(word.replace(/ /g, '_'))}`,
    )
    const senses = (entries.en ?? []).slice(0, 4).map((e) => ({
      partOfSpeech: e.partOfSpeech,
      definitions: e.definitions
        .map((d) => plain(d.definition))
        .filter(Boolean)
        .slice(0, 4),
    }))
    if (senses.length === 0) return { error: `Wiktionary has no English entry for "${word}"` }
    return { word, senses, url: `https://en.wiktionary.org/wiki/${q(word.replace(/ /g, '_'))}` }
  } catch (error) {
    if (error instanceof LookupFailed && error.status === 404) return { error: `Wiktionary has no entry for "${word}"` }
    return failed('Wiktionary', error)
  }
}

// ── hackerNews ──────────────────────────────────────────────────────────────

export async function hackerNews(env: Env, opts: { query?: string }) {
  const query = opts.query?.trim()
  const url = query
    ? `${base(env, 'hn')}/search?query=${q(query)}&tags=story&hitsPerPage=10`
    : `${base(env, 'hn')}/search?tags=front_page&hitsPerPage=15`
  try {
    const r = await getJson<{ hits: { objectID: string; title?: string; url?: string; points?: number; num_comments?: number; created_at?: string }[] }>(url)
    return {
      stories: r.hits
        .filter((h) => h.title)
        .map((h) => ({
          title: h.title,
          url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
          discussion: `https://news.ycombinator.com/item?id=${h.objectID}`,
          points: h.points ?? 0,
          comments: h.num_comments ?? 0,
          posted: h.created_at ?? '',
        })),
    }
  } catch (error) {
    return failed('Hacker News', error)
  }
}

// ── arxiv ───────────────────────────────────────────────────────────────────

export async function arxiv(env: Env, opts: { query: string }) {
  const terms = opts.query
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => `all:${q(t.replace(/[^\p{L}\p{N}-]/gu, ''))}`)
    .join('+AND+')
  try {
    const atom = await getText(`${base(env, 'arxiv')}/query?search_query=${terms}&max_results=6&sortBy=relevance`)
    const field = (entry: string, name: string) => plain(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`).exec(entry)?.[1] ?? '')
    const papers = [...atom.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e = '']) => ({
      title: field(e, 'title'),
      authors: [...e.matchAll(/<name>([\s\S]*?)<\/name>/g)].map((m) => plain(m[1] ?? '')).slice(0, 6),
      published: field(e, 'published').slice(0, 10),
      summary: field(e, 'summary').slice(0, 700),
      url: (/<link[^>]+href="([^"]+)"[^>]+rel="alternate"/.exec(e)?.[1] ?? field(e, 'id')).replace(/^http:/, 'https:'),
    }))
    return { papers }
  } catch (error) {
    return failed('arXiv', error)
  }
}

// ── books ───────────────────────────────────────────────────────────────────

export async function books(env: Env, opts: { query: string }) {
  try {
    const r = await getJson<{ docs: { key: string; title: string; author_name?: string[]; first_publish_year?: number; number_of_pages_median?: number; subject?: string[] }[] }>(
      `${base(env, 'books')}/search.json?q=${q(opts.query)}&limit=6&fields=key,title,author_name,first_publish_year,number_of_pages_median,subject`,
    )
    return {
      books: r.docs.map((d) => ({
        title: d.title,
        authors: (d.author_name ?? []).slice(0, 4),
        firstPublished: d.first_publish_year ?? null,
        pages: d.number_of_pages_median ?? null,
        subjects: (d.subject ?? []).filter((s) => !s.includes(':')).slice(0, 6),
        url: `https://openlibrary.org${d.key}`,
      })),
    }
  } catch (error) {
    return failed('Open Library', error)
  }
}

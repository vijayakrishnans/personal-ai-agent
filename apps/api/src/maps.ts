import type { Env } from './env'

// MAPS AND TRAVEL, on OpenStreetMap's open services — no key (agent.ts):
//
//   showMap  places by name (Nominatim), drawn on a map under the reply
//   route    how far and how long from one place to another, by car, on foot
//            or by bike (FOSSGIS's OSRM), the way drawn on the map, with a
//            link to turn-by-turn directions
//   places   what is near somewhere — restaurants, hotels, sights, pharmacies
//            … (Overpass), on the map
//
// The page draws the map itself from OpenStreetMap's tiles (ui.ts); a tool
// answers the model with names, distances and links, and the page with a
// MapView. Nominatim asks for at most one request a second, so places are
// looked up one after another. LOOKUP_URL, a test-only override, reaches a
// stand-in at <LOOKUP_URL>/nominatim, /osrm and /overpass.

const TIMEOUT_MS = 20_000
const USER_AGENT = 'personal-agent/1.0 (+https://orunbase.com)'
const BASES = {
  nominatim: 'https://nominatim.openstreetmap.org',
  osrm: 'https://routing.openstreetmap.de',
  overpass: 'https://overpass-api.de/api',
} as const

export const MAX_MAP_PLACES = 8
export const MAX_MAPS_PER_TURN = 3
const MAX_LINE_POINTS = 300

export type Place = { name: string; lat: number; lon: number; url: string; kind?: string; address?: string; website?: string; hours?: string }
export type Route = { from: string; to: string; mode: TravelMode; km: number; minutes: number; directions: string; line: [number, number][] }
export type MapView = { title: string; places: Place[]; route?: Route }
export type TravelMode = 'car' | 'foot' | 'bike'

function base(env: Env, service: keyof typeof BASES): string {
  return env.LOOKUP_URL ? `${env.LOOKUP_URL.replace(/\/+$/, '')}/${service}` : BASES[service]
}

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'user-agent': USER_AGENT, accept: 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`answered ${res.status}`)
  return (await res.json()) as T
}

const failed = (service: string, error: unknown) => ({ error: `${service} failed: ${String((error as Error)?.message ?? error).slice(0, 160)}` })
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits
const osm = (lat: number, lon: number) => `https://www.openstreetmap.org/?mlat=${round(lat, 5)}&mlon=${round(lon, 5)}#map=16/${round(lat, 5)}/${round(lon, 5)}`
const pause = (env: Env, ms: number) => (env.LOOKUP_URL ? Promise.resolve() : new Promise((r) => setTimeout(r, ms)))

/** One place by name, as Nominatim finds it best, or null. */
export async function geocode(env: Env, query: string): Promise<Place | null> {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '1', addressdetails: '0' })
  const found = await getJson<{ lat: string; lon: string; display_name: string; type?: string }[]>(`${base(env, 'nominatim')}/search?${params}`)
  const hit = found[0]
  if (!hit) return null
  const lat = Number(hit.lat), lon = Number(hit.lon)
  return { name: hit.display_name.split(', ').slice(0, 3).join(', '), lat, lon, url: osm(lat, lon), ...(hit.type ? { kind: hit.type } : {}) }
}

/** Several places by name, one a second, for one map. */
export async function showMap(env: Env, opts: { places: string[]; title?: string }) {
  try {
    const places: Place[] = []
    const notFound: string[] = []
    for (const [i, name] of opts.places.slice(0, MAX_MAP_PLACES).entries()) {
      if (i) await pause(env, 1100)
      const p = await geocode(env, name)
      if (p) places.push(p)
      else notFound.push(name)
    }
    if (!places.length) return { error: `no place found for ${opts.places.map((p) => `"${p}"`).join(', ')}; add the town or country` }
    return { map: { title: opts.title || places.map((p) => p.name.split(', ')[0]).join(' · '), places } satisfies MapView, ...(notFound.length ? { notFound } : {}) }
  } catch (error) {
    return failed('OpenStreetMap search', error)
  }
}

const PROFILES: Record<TravelMode, string> = { car: 'routed-car', foot: 'routed-foot', bike: 'routed-bike' }
const ENGINES: Record<TravelMode, string> = { car: 'fossgis_osrm_car', foot: 'fossgis_osrm_foot', bike: 'fossgis_osrm_bike' }

/** Fewer points for a long way: every n-th, keeping the last. */
export function thin(line: [number, number][], max = MAX_LINE_POINTS): [number, number][] {
  if (line.length <= max) return line
  const step = Math.ceil(line.length / max)
  const kept = line.filter((_, i) => i % step === 0)
  const last = line[line.length - 1] as [number, number]
  return kept[kept.length - 1] === last ? kept : [...kept, last]
}

export async function route(env: Env, opts: { from: string; to: string; mode?: TravelMode }) {
  const mode = opts.mode ?? 'car'
  try {
    const a = await geocode(env, opts.from)
    await pause(env, 1100)
    const b = await geocode(env, opts.to)
    if (!a || !b) return { error: `no place found for "${!a ? opts.from : opts.to}"; add the town or country` }
    const r = await getJson<{ code: string; routes?: { distance: number; duration: number; geometry: { coordinates: [number, number][] } }[] }>(
      `${base(env, 'osrm')}/${PROFILES[mode]}/route/v1/driving/${a.lon},${a.lat};${b.lon},${b.lat}?overview=simplified&geometries=geojson`,
    )
    const best = r.routes?.[0]
    if (r.code !== 'Ok' || !best) return { error: `no ${mode} route from ${a.name} to ${b.name}` }
    const directions = `https://www.openstreetmap.org/directions?engine=${ENGINES[mode]}&route=${round(a.lat, 5)}%2C${round(a.lon, 5)}%3B${round(b.lat, 5)}%2C${round(b.lon, 5)}`
    const line = thin(best.geometry.coordinates.map(([lon, lat]) => [round(lat, 5), round(lon, 5)] as [number, number]))
    const routed: Route = { from: a.name, to: b.name, mode, km: round(best.distance / 1000, 1), minutes: Math.round(best.duration / 60), directions, line }
    return { map: { title: `${a.name.split(', ')[0]} → ${b.name.split(', ')[0]}`, places: [a, b], route: routed } satisfies MapView }
  } catch (error) {
    return failed('Routing', error)
  }
}

// What `places` can look for, as OpenStreetMap tags them.
export const PLACE_KINDS = {
  restaurant: ['amenity', 'restaurant'],
  cafe: ['amenity', 'cafe'],
  bar: ['amenity', 'bar'],
  hotel: ['tourism', 'hotel'],
  hostel: ['tourism', 'hostel'],
  attraction: ['tourism', 'attraction'],
  museum: ['tourism', 'museum'],
  viewpoint: ['tourism', 'viewpoint'],
  park: ['leisure', 'park'],
  beach: ['natural', 'beach'],
  hospital: ['amenity', 'hospital'],
  pharmacy: ['amenity', 'pharmacy'],
  atm: ['amenity', 'atm'],
  fuel: ['amenity', 'fuel'],
  ev_charging: ['amenity', 'charging_station'],
  supermarket: ['shop', 'supermarket'],
  train_station: ['railway', 'station'],
  bus_station: ['amenity', 'bus_station'],
  place_of_worship: ['amenity', 'place_of_worship'],
} as const
export type PlaceKind = keyof typeof PLACE_KINDS

type OverpassElement = { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }

export async function places(env: Env, opts: { kind: PlaceKind; near: string; radiusKm?: number }) {
  const radius = Math.round(Math.min(10, Math.max(0.2, opts.radiusKm ?? 2)) * 1000)
  try {
    const centre = await geocode(env, opts.near)
    if (!centre) return { error: `no place found for "${opts.near}"; add the town or country` }
    const [k, v] = PLACE_KINDS[opts.kind]
    const query = `[out:json][timeout:20];nwr["${k}"="${v}"]["name"](around:${radius},${centre.lat},${centre.lon});out center 20;`
    const r = await getJson<{ elements: OverpassElement[] }>(`${base(env, 'overpass')}/interpreter`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data: query }).toString(),
    })
    const found: Place[] = r.elements
      .map((e) => {
        const lat = e.lat ?? e.center?.lat, lon = e.lon ?? e.center?.lon
        const t = e.tags ?? {}
        if (lat === undefined || lon === undefined || !t.name) return null
        const address = [t['addr:housenumber'], t['addr:street'], t['addr:city']].filter(Boolean).join(' ')
        return {
          name: t.name,
          lat,
          lon,
          url: `https://www.openstreetmap.org/${e.type}/${e.id}`,
          kind: t.cuisine ? `${opts.kind.replace('_', ' ')} · ${t.cuisine.replace(/;/g, ', ')}` : opts.kind.replace('_', ' '),
          ...(address ? { address } : {}),
          ...(t.website ? { website: t.website } : {}),
          ...(t.opening_hours ? { hours: t.opening_hours } : {}),
        } satisfies Place
      })
      .filter((p): p is NonNullable<typeof p> => p !== null)
      .slice(0, 15)
    if (!found.length) return { error: `no ${opts.kind.replace('_', ' ')} with a name within ${radius / 1000} km of ${centre.name}` }
    return { near: centre.name, map: { title: `${opts.kind.replace('_', ' ')} near ${centre.name.split(', ')[0]}`, places: found } satisfies MapView }
  } catch (error) {
    return failed('OpenStreetMap places', error)
  }
}

/** What the model is told of a map: everything but the way's points, which only the page draws. */
export function forModel(result: { map?: MapView; [k: string]: unknown }) {
  if (!result.map) return result
  const { route: r, ...map } = result.map
  return { ...result, map: { ...map, ...(r ? { route: { ...r, line: undefined } } : {}) }, shown: true }
}

// SECRETS THE AGENT MUST NEVER HOLD. What the owner types is looked through
// before any model sees it: a password, an API key, a card number, an ID
// number is replaced by a marker, so no model — Workers AI's or a third
// party's — can read it, remember it or send it anywhere. The same check
// refuses a memory that looks like one, and a URL or query that carries one
// out to the web.
//
// It errs towards catching: a long random-looking string is taken for a key.
// It cannot know a secret that looks like an ordinary word ("my password is
// sunshine" is caught by its wording; "sunshine" alone is not).

export type Found = { kind: string; start: number; end: number }

// Tokens whose shape says what they are.
const TOKENS: [string, RegExp][] = [
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['API key', /\b(?:sk|pk|rk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g],
  ['API key', /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}/g],
  ['access token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['API key', /\btvly-[A-Za-z0-9-]{16,}/g],
  ['access token', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/g],
  ['access token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['access token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['API key', /\bAIza[0-9A-Za-z_-]{35}/g],
  ['access key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['access token', /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g],
  ['access token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  // A secret in a URL's query string.
  ['credential in a URL', /[?&](?:api[_-]?key|apikey|access[_-]?token|auth|token|key|secret|password|passwd|pwd|sig|signature)=[^&\s#]{6,}/gi],
  // "my password is …", "PIN: …", "OTP = …": the value after the words.
  [
    'password',
    /\b(?:password|passcode|passwd|pwd|pass ?phrase|pin|otp|cvv|cvc|security code|secret key|api ?key|access ?key|private ?key)\b(?: (?:for|to|of|on) [\w.@-]+)?\s*(?:is|was|:|=|-)\s*["'“]?[^\s"'”]+/gi,
  ],
  // A wallet's seed phrase: the 12 to 24 words after the words.
  ['seed phrase', /\b(?:seed phrase|recovery phrase|mnemonic|seed words)\b[^:\n]{0,30}(?:is|was|:|=|-)\s*(?:[a-z]+\s+){11,23}[a-z]+/gi],
  ['PAN', /\b[A-Z]{3}[ABCFGHLJPT][A-Z]\d{4}[A-Z]\b/g],
]

// Number-shaped secrets, confirmed by their check digit so that a phone
// number or an order number is not taken for one.
const CARD = /\b\d(?:[ -]?\d){12,18}\b/g
const AADHAAR = /\b[2-9]\d{3}[ -]?\d{4}[ -]?\d{4}\b/g

// A long run of mixed letters and digits, as keys and passwords are.
const RANDOM = /[A-Za-z0-9+/_=-]{24,}/g
const URLS = /\bhttps?:\/\/[^\s<>"')\]]+/g

/** Every secret in a text, by kind and place; overlapping finds merged. */
export function findSecrets(text: string): Found[] {
  const found: Found[] = []
  const add = (kind: string, start: number, end: number) => found.push({ kind, start, end })
  for (const [kind, re] of TOKENS) for (const m of text.matchAll(re)) add(kind, m.index, m.index + m[0].length)
  for (const m of text.matchAll(CARD)) if (luhn(m[0].replace(/\D/g, ''))) add('card number', m.index, m.index + m[0].length)
  for (const m of text.matchAll(AADHAAR)) if (verhoeff(m[0].replace(/\D/g, ''))) add('Aadhaar number', m.index, m.index + m[0].length)
  // Random-looking runs, but not a URL's path (a news link's id is one).
  const urls = [...text.matchAll(URLS)].map((m) => [m.index, m.index + m[0].length] as const)
  for (const m of text.matchAll(RANDOM)) {
    const start = m.index
    if (urls.some(([a, b]) => start >= a && start < b)) continue
    if (looksRandom(m[0])) add('key or password', start, start + m[0].length)
  }
  return merge(found)
}

/** The text with every secret replaced by a marker naming its kind. */
export function redact(text: string): { text: string; count: number } {
  const found = findSecrets(text)
  let out = ''
  let at = 0
  for (const f of found) {
    out += text.slice(at, f.start) + `[${f.kind} removed]`
    at = f.end
  }
  return { text: out + text.slice(at), count: found.length }
}

export const hasSecret = (text: string) => findSecrets(text).length > 0

function merge(found: Found[]): Found[] {
  const sorted = found.sort((a, b) => a.start - b.start || b.end - a.end)
  const out: Found[] = []
  for (const f of sorted) {
    const last = out[out.length - 1]
    if (last && f.start < last.end) last.end = Math.max(last.end, f.end)
    else out.push({ ...f })
  }
  return out
}

/** Mixed case and digits, and no word-like run: a key, not a long word or a slug. */
function looksRandom(s: string): boolean {
  const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((re) => re.test(s)).length
  if (classes < 3) return false
  // A hyphenated or underscored phrase ("my-long-blog-post-title-2026") is not a key.
  if (/^[a-z0-9]+(?:[-_][a-z0-9]+){3,}$/i.test(s) && !/[A-Z].*[a-z].*\d|\d.*[A-Z]/.test(s.replace(/[-_]/g, ''))) return false
  const digits = (s.match(/\d/g) ?? []).length
  return digits >= 2
}

function luhn(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19 || /^(\d)\1+$/.test(digits)) return false
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

// Aadhaar's check digit is Verhoeff's.
const V_D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7], [4, 0, 1, 2, 3, 9, 5, 6, 7, 8],
  [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3], [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
]
const V_P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
]
function verhoeff(digits: string): boolean {
  let c = 0
  for (let i = 0; i < digits.length; i++) c = V_D[c]![V_P[i % 8]![Number(digits[digits.length - 1 - i])]!]!
  return c === 0
}

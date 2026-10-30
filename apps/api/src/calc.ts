// THE CALCULATOR: arithmetic a model should not do in its head. A small
// parser of its own — never eval, never Function — over numbers, + - * / ^ %
// (remainder), parentheses, the constants pi and e, and a few functions.
// Percentages read as people write them: "18% of 2500", "2500 + 18%".

const FUNCTIONS: Record<string, (...xs: number[]) => number> = {
  sqrt: Math.sqrt, cbrt: Math.cbrt, abs: Math.abs, round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d,
  floor: Math.floor, ceil: Math.ceil, ln: Math.log, log: Math.log10, log2: Math.log2, exp: Math.exp,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  min: Math.min, max: Math.max, pow: Math.pow,
}
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E }

export const MAX_EXPRESSION = 500

export class CalcError extends Error {}

/** The value of an expression, or a CalcError saying where it went wrong. */
export function calculate(expression: string): number {
  if (expression.length > MAX_EXPRESSION) throw new CalcError(`at most ${MAX_EXPRESSION} characters`)
  // People write 1,250,000 and ×, ÷, −.
  const src = expression.replace(/(\d),(?=\d{3}\b)/g, '$1').replace(/×/g, '*').replace(/(\d)\s*x\s*(?=[\d(.])/g, '$1*').replace(/÷/g, '/').replace(/[−–]/g, '-').toLowerCase()
  let i = 0
  const peek = () => {
    while (src[i] === ' ') i++
    return src[i] ?? ''
  }
  const eat = (s: string) => {
    if (src.startsWith(s, (peek(), i))) {
      i += s.length
      return true
    }
    return false
  }
  const fail = (what: string): never => {
    throw new CalcError(`${what} at position ${i + 1} of "${expression}"`)
  }

  // sum := product (('+' | '-') product ['%'])*
  function sum(): number {
    let v = product()
    for (;;) {
      if (eat('+')) v = withPercent(v, product(), 1)
      else if (eat('-')) v = withPercent(v, product(), -1)
      else return v
    }
  }
  // "2500 + 18%" is 2500 plus 18% of 2500.
  function withPercent(left: number, right: number, sign: number): number {
    if (eat('%')) return left + sign * left * (right / 100)
    return left + sign * right
  }
  // product := unary (('*' | '/' | '%' | 'of') unary)*
  function product(): number {
    let v = unary()
    for (;;) {
      if (eat('*')) v *= unary()
      else if (eat('/')) {
        const d = unary()
        if (d === 0) fail('division by zero')
        v /= d
      } else if (peek() === '%' && /^%\s*of\b/.test(src.slice(i))) {
        eat('%')
        eat('of')
        v = (v / 100) * unary()
      } else if (peek() === '%' && /^%\s*[\d(a-z]/.test(src.slice(i)) && !/^%\s*of\b/.test(src.slice(i))) {
        eat('%')
        v %= unary()
      } else return v
    }
  }
  // unary := ('-' | '+') unary | power — so -3^2 is -(3^2), as in maths.
  function unary(): number {
    if (eat('-')) return -unary()
    if (eat('+')) return unary()
    return power()
  }
  // power := atom ('^' unary)?
  function power(): number {
    const base = atom()
    if (eat('**') || eat('^')) return base ** unary()
    return base
  }
  function atom(): number {
    if (eat('(')) {
      const v = sum()
      if (!eat(')')) fail('missing )')
      return v
    }
    const num = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/.exec(src.slice((peek(), i)))
    if (num) {
      i += num[0].length
      return Number(num[0])
    }
    const name = /^[a-z][a-z0-9]*/.exec(src.slice(i))?.[0]
    if (!name) fail(peek() ? `unexpected "${peek()}"` : 'expression ends too soon')
    i += (name as string).length
    if (name! in CONSTANTS) return CONSTANTS[name as string] as number
    const fn = FUNCTIONS[name as string]
    if (!fn) fail(`unknown name "${name}"`)
    if (!eat('(')) fail(`${name} needs (…)`)
    const args = [sum()]
    while (eat(',')) args.push(sum())
    if (!eat(')')) fail('missing )')
    return (fn as (...xs: number[]) => number)(...args)
  }

  let v = sum()
  // A lone "50%" is a half.
  if (peek() === '%' && !src.slice(i + 1).trim()) {
    i++
    v /= 100
  }
  if (peek()) fail(`unexpected "${peek()}"`)
  if (!Number.isFinite(v)) throw new CalcError('the result is not a finite number')
  return v
}

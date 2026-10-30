import type { Env } from './env'

// THE AGENT'S PICTURES: FLUX.1 [schnell] on Workers AI, through the Worker's
// own AI binding — no key, billed to the account like the chat models. The
// image is kept in MEMORY and shown by the page (GET /api/images/<id>); a
// model only ever hears its number, never its bytes.

export const IMAGE_MODEL = '@cf/black-forest-labs/flux-1-schnell'
export const MAX_IMAGE_PROMPT = 1000
export const MAX_IMAGES_PER_TURN = 2
const STEPS = 6

export async function drawImage(env: Env, prompt: string): Promise<{ jpegBase64: string } | { error: string }> {
  try {
    const out = (await env.AI.run(IMAGE_MODEL, { prompt, steps: STEPS })) as { image?: string }
    if (!out?.image) return { error: 'the image model returned no image' }
    return { jpegBase64: out.image }
  } catch (error) {
    return { error: `the image model failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
  }
}

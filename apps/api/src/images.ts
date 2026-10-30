import type { Env } from './env'

// THE AGENT'S PICTURES: FLUX on Workers AI, through the Worker's own AI
// binding — no key, billed to the account like the chat models. The owner
// picks the model in the page (☰ → Models); FLUX.1 [schnell], the fastest,
// is the default. Every image is kept in MEMORY — the owner's library — and
// shown by the page (GET /api/images/<id>); a model only ever hears its
// number, never its bytes.
//
// FLUX.1 takes JSON; FLUX.2 takes a multipart form. Both answer with the
// image as base64.

export type ImageModel = { id: string; label: string; multipart: boolean }

export const IMAGE_MODELS: ImageModel[] = [
  { id: '@cf/black-forest-labs/flux-1-schnell', label: 'FLUX.1 [schnell] — fastest', multipart: false },
  { id: '@cf/black-forest-labs/flux-2-klein-4b', label: 'FLUX.2 [klein] 4B — fast, sharper', multipart: true },
  { id: '@cf/black-forest-labs/flux-2-klein-9b', label: 'FLUX.2 [klein] 9B — balanced', multipart: true },
  { id: '@cf/black-forest-labs/flux-2-dev', label: 'FLUX.2 [dev] — best quality, slowest', multipart: true },
]
export const DEFAULT_IMAGE_MODEL = IMAGE_MODELS[0]!.id
export const imageModel = (id: string | null | undefined) => IMAGE_MODELS.find((m) => m.id === id) ?? IMAGE_MODELS[0]!

export const MAX_IMAGE_PROMPT = 1000
export const MAX_IMAGES_PER_TURN = 2

export async function drawImage(env: Env, prompt: string, modelId?: string | null): Promise<{ base64: string } | { error: string }> {
  const model = imageModel(modelId)
  try {
    let inputs: Record<string, unknown>
    if (model.multipart) {
      const form = new FormData()
      form.append('prompt', prompt)
      form.append('width', '1024')
      form.append('height', '1024')
      const body = new Response(form)
      inputs = { multipart: { body: body.body, contentType: body.headers.get('content-type') ?? 'multipart/form-data' } }
    } else {
      inputs = { prompt, steps: 6 }
    }
    const out = (await (env.AI.run as (model: string, inputs: unknown) => Promise<unknown>)(model.id, inputs)) as { image?: string }
    if (!out?.image) return { error: 'the image model returned no image' }
    return { base64: out.image }
  } catch (error) {
    return { error: `${model.label.split(' —')[0]} failed: ${String((error as Error)?.message ?? error).slice(0, 200)}` }
  }
}

/** An image's type from its first bytes (as base64): JPEG, PNG or WebP. */
export function imageType(base64: string): string {
  if (base64.startsWith('iVBOR')) return 'image/png'
  if (base64.startsWith('UklGR')) return 'image/webp'
  return 'image/jpeg'
}

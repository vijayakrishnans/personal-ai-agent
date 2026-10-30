import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { runAgent, ChatRequest, toolNames } from './agent'
import { bearer, keyMatches } from './auth'
import { accessConfigured, huggingfaceConnected, killSwitchOn, type Env } from './env'
import { API_NAME } from './identity'
import { memoryOf, MAX_MEMORY_CHARS, MAX_NOTE_CHARS, MAX_SAVED_CHARS, MAX_SPACE_CHARS, type MemoryStore, type NoteChange } from './memory'
import { API_NAME_PATTERN, catalog, DEFAULT_MODEL, HF_MODEL_ID, modelKey, parseHfModels, SPACE_ID, WORKERS_AI_ID, WORKERS_AI_MODELS } from './models'
import { SpaceError } from './spaces'
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS, imageModel, imageType } from './images'
import { hasSecret } from './secrets'
import { BUILT_IN_SKILLS, MAX_SKILL_DESCRIPTION, MAX_SKILL_INSTRUCTIONS, SKILL_NAME, skillsOnOffer } from './skills'
import { page } from './ui'
import { webSearchConnected } from './web'

export { AgentMemory } from './memory'

type Vars = { memory: MemoryStore }
type AppContext = Context<{ Bindings: Env; Variables: Vars }>
const app = new Hono<{ Bindings: Env; Variables: Vars }>()

const NOT_CONFIGURED = {
  ok: false,
  error: 'access_not_configured',
  message:
    'This agent is locked until its owner stores AGENT_ACCESS_KEY as this environment’s secret and redeploys (README → Unlock the agent).',
}
const KILLED = {
  ok: false,
  error: 'agent_disabled',
  message: 'This agent is switched off: AGENT_KILL_SWITCH is on. Remove that secret (or set it to off) and redeploy to switch it back on.',
}
const PAUSED = {
  ok: false,
  error: 'agent_paused',
  message: 'This agent is paused, so it calls no model. Resume it in ☰ → Access.',
}
const HF_NOT_CONNECTED = {
  ok: false,
  error: 'huggingface_not_connected',
  message: 'Hugging Face models need HF_TOKEN stored as this environment’s secret, then a redeploy (README → Add Hugging Face models).',
}

// THE OWNER'S DOOR, before anything under /api does any work: the hard kill
// switch on is a 503 for everyone, the owner too; no key stored is a 503
// that says so (the agent spends nothing on anyone's behalf), a missing or
// wrong key a 401.
app.use('/api/*', async (c, next) => {
  if (killSwitchOn(c.env)) return c.json(KILLED, 503)
  if (!accessConfigured(c.env)) return c.json(NOT_CONFIGURED, 503)
  const presented = bearer(c.req.header('authorization'))
  if (!presented || !(await keyMatches(presented, c.env.AGENT_ACCESS_KEY as string))) {
    c.header('WWW-Authenticate', 'Bearer realm="agent"')
    return c.json({ ok: false, error: 'unauthorized', message: 'Send the agent’s access key as a bearer token.' }, 401)
  }
  c.set('memory', memoryOf(c.env.MEMORY))
  return next()
})

const models = async (c: AppContext) => catalog(c.env, await c.var.memory.listModels())

app.get('/api/models', async (c) => {
  return c.json({
    default: modelKey('workers-ai', DEFAULT_MODEL),
    huggingface: huggingfaceConnected(c.env),
    models: await models(c),
    images: { models: IMAGE_MODELS, default: DEFAULT_IMAGE_MODEL },
  })
})

const AddModel = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('workers-ai'),
    id: z.string().regex(WORKERS_AI_ID, 'a Workers AI model id, @cf/owner/name'),
    label: z.string().trim().min(1).max(80).optional(),
    tools: z.boolean().default(true),
  }),
  z.object({
    provider: z.literal('huggingface'),
    id: z.string().regex(HF_MODEL_ID, 'a Hub model id, owner/name, optionally :provider'),
    label: z.string().trim().min(1).max(80).optional(),
    tools: z.boolean().default(true),
  }),
  z.object({
    provider: z.literal('space'),
    id: z.string().regex(SPACE_ID, 'a Space id, owner/name'),
    label: z.string().trim().min(1).max(80).optional(),
    apiName: z.string().regex(API_NAME_PATTERN, 'a Gradio endpoint name, e.g. chat').default('chat'),
  }),
])

app.post('/api/models', async (c) => {
  const parsed = AddModel.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_model', message: parsed.error.issues.map((i) => i.message).join('; ') }, 400)
  const m = parsed.data
  const stored =
    m.provider === 'space'
      ? { provider: m.provider, id: m.id, label: m.label ?? `${m.id} · Space`, tools: false, apiName: m.apiName }
      : m.provider === 'workers-ai'
        ? { provider: m.provider, id: m.id, label: m.label ?? `${m.id.replace(/^@cf\//, '')} · Workers AI`, tools: m.tools }
        : { provider: m.provider, id: m.id, label: m.label ?? `${m.id} · Hugging Face`, tools: m.tools }
  try {
    await c.var.memory.addModel(stored)
  } catch (error) {
    return c.json({ ok: false, error: 'too_many_models', message: String((error as Error).message) }, 409)
  }
  const entry = (await models(c)).find((e) => e.key === modelKey(m.provider, m.id))
  return c.json({ ok: true, model: entry }, 201)
})

// Only a model added in the page can be removed there: the built-in ones are
// the code's, and HF_MODELS's are the secret's.
// A Workers AI id has three segments (@cf/owner/name), the others two.
app.delete('/api/models/:provider/:owner/:name', async (c) => {
  const { provider, owner, name } = c.req.param()
  const removed = await c.var.memory.removeModel(provider, `${owner}/${name}`)
  return removed ? c.json({ ok: true }) : c.json({ ok: false, error: 'not_found' }, 404)
})
app.delete('/api/models/:provider/:scope/:owner/:name', async (c) => {
  const { provider, scope, owner, name } = c.req.param()
  const removed = await c.var.memory.removeModel(provider, `${scope}/${owner}/${name}`)
  return removed ? c.json({ ok: true }) : c.json({ ok: false, error: 'not_found' }, 404)
})

const LOOKS_LIKE_SECRET = {
  ok: false,
  error: 'looks_like_secret',
  message: 'That looks like a password, key, card or ID number, and the agent never keeps one. A password manager is the place for it.',
}
const INVALID_SPACE = { ok: false, error: 'invalid_space', message: `a space is a name of 1-${MAX_SPACE_CHARS} characters` }

/** A space as a request sends it: absent is undefined (the default space), a bad one null. */
function spaceParam(space: unknown): string | undefined | null {
  if (space === undefined) return undefined
  if (typeof space !== 'string') return null
  const clean = space.trim()
  return clean && clean.length <= MAX_SPACE_CHARS ? clean : null
}

app.get('/api/memories', async (c) => {
  return c.json({ memories: await c.var.memory.listMemories(100) })
})

app.post('/api/memories', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; space?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text || text.length > MAX_MEMORY_CHARS) {
    return c.json({ ok: false, error: 'invalid_memory', message: `one fact of 1-${MAX_MEMORY_CHARS} characters` }, 400)
  }
  const space = spaceParam(body?.space)
  if (space === null) return c.json(INVALID_SPACE, 400)
  if (hasSecret(text) || hasSecret(space ?? '')) return c.json(LOOKS_LIKE_SECRET, 400)
  return c.json({ ok: true, memory: await c.var.memory.remember(text, space) }, 201)
})

// Moving a memory to another space — the page's graph does it.
app.patch('/api/memories/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id < 1) return c.json({ ok: false, error: 'not_found' }, 404)
  const body = (await c.req.json().catch(() => null)) as { space?: unknown } | null
  const space = spaceParam(body?.space)
  if (!space) return c.json(INVALID_SPACE, 400)
  if (hasSecret(space)) return c.json(LOOKS_LIKE_SECRET, 400)
  const memory = await c.var.memory.moveMemory(id, space)
  return memory ? c.json({ ok: true, memory }) : c.json({ ok: false, error: 'not_found' }, 404)
})

app.delete('/api/memories/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id < 1) return c.json({ ok: false, error: 'not_found' }, 404)
  return (await c.var.memory.forget(id)) ? c.json({ ok: true }) : c.json({ ok: false, error: 'not_found' }, 404)
})

// NOTES AND TO-DOS: the owner's lists, which the page shows and edits as the
// agent does — a note that looks like a secret is refused here too.
const INVALID_NOTE = { ok: false, error: 'invalid_note', message: `a note of 1-${MAX_NOTE_CHARS} characters, on a list of 1-${MAX_SPACE_CHARS}` }
const noteId = (raw: string) => {
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

app.get('/api/notes', async (c) => c.json({ ok: true, notes: await c.var.memory.listNotes() }))

app.post('/api/notes', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; list?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  const list = body?.list === undefined ? undefined : typeof body.list === 'string' ? body.list.trim() : null
  if (!text || text.length > MAX_NOTE_CHARS || list === null || (list !== undefined && list.length > MAX_SPACE_CHARS)) return c.json(INVALID_NOTE, 400)
  if (hasSecret(text) || hasSecret(list ?? '')) return c.json(LOOKS_LIKE_SECRET, 400)
  return c.json({ ok: true, note: await c.var.memory.addNote(text, list || undefined) }, 201)
})

app.patch('/api/notes/:id', async (c) => {
  const id = noteId(c.req.param('id'))
  if (!id) return c.json({ ok: false, error: 'not_found' }, 404)
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const change: NoteChange = {}
  if (typeof body?.done === 'boolean') change.done = body.done
  if (typeof body?.text === 'string' && body.text.trim() && body.text.length <= MAX_NOTE_CHARS) change.text = body.text
  if (typeof body?.list === 'string' && body.list.trim() && body.list.length <= MAX_SPACE_CHARS) change.list = body.list
  if (Object.keys(change).length === 0) return c.json(INVALID_NOTE, 400)
  if (hasSecret(`${change.text ?? ''} ${change.list ?? ''}`)) return c.json(LOOKS_LIKE_SECRET, 400)
  const note = await c.var.memory.updateNote(id, change)
  return note ? c.json({ ok: true, note }) : c.json({ ok: false, error: 'not_found' }, 404)
})

app.delete('/api/notes/:id', async (c) => {
  const id = noteId(c.req.param('id'))
  return id && (await c.var.memory.deleteNote(id)) ? c.json({ ok: true }) : c.json({ ok: false, error: 'not_found' }, 404)
})

// THE LIBRARY: the images the agent drew, and what the owner saved — behind
// the owner's key like the rest.
app.get('/api/images', async (c) => c.json({ ok: true, images: await c.var.memory.listImages() }))

app.get('/api/images/:id', async (c) => {
  const id = noteId(c.req.param('id'))
  const image = id ? await c.var.memory.getImage(id) : null
  if (!image) return c.json({ ok: false, error: 'not_found' }, 404)
  const bytes = Uint8Array.from(atob(image.base64), (ch) => ch.charCodeAt(0))
  return c.body(bytes, 200, { 'content-type': imageType(image.base64), 'cache-control': 'private, max-age=31536000, immutable' })
})

app.delete('/api/images/:id', async (c) => {
  const id = noteId(c.req.param('id'))
  return id && (await c.var.memory.deleteImage(id)) ? c.json({ ok: true }) : c.json({ ok: false, error: 'not_found' }, 404)
})

app.get('/api/saved', async (c) => c.json({ ok: true, saved: await c.var.memory.listSaved() }))

app.post('/api/saved', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { text?: unknown; source?: unknown } | null
  const text = typeof body?.text === 'string' ? body.text.trim() : ''
  if (!text || text.length > MAX_SAVED_CHARS) return c.json({ ok: false, error: 'invalid_saved', message: `1-${MAX_SAVED_CHARS} characters` }, 400)
  if (hasSecret(text)) return c.json(LOOKS_LIKE_SECRET, 400)
  const source = typeof body?.source === 'string' ? body.source : ''
  return c.json({ ok: true, saved: await c.var.memory.saveItem(text, source) }, 201)
})

app.delete('/api/saved/:id', async (c) => {
  const id = noteId(c.req.param('id'))
  return id && (await c.var.memory.deleteSaved(id)) ? c.json({ ok: true }) : c.json({ ok: false, error: 'not_found' }, 404)
})

// SKILLS: the built-in ones and the owner's own (skills.ts). PUT writes one
// (a built-in's name replaces it); DELETE removes the owner's — a built-in
// comes back as it was.
app.get('/api/skills', async (c) => c.json({ ok: true, skills: skillsOnOffer(await c.var.memory.listSkills()) }))

app.put('/api/skills/:name', async (c) => {
  const name = c.req.param('name')
  const body = (await c.req.json().catch(() => null)) as { description?: unknown; instructions?: unknown } | null
  const description = typeof body?.description === 'string' ? body.description.trim() : ''
  const instructions = typeof body?.instructions === 'string' ? body.instructions.trim() : ''
  if (!SKILL_NAME.test(name) || !description || description.length > MAX_SKILL_DESCRIPTION || !instructions || instructions.length > MAX_SKILL_INSTRUCTIONS) {
    return c.json(
      {
        ok: false,
        error: 'invalid_skill',
        message: `a name of lowercase letters, digits and dashes (2-40), a description of 1-${MAX_SKILL_DESCRIPTION} characters and instructions of 1-${MAX_SKILL_INSTRUCTIONS}`,
      },
      400,
    )
  }
  if (hasSecret(`${description}\n${instructions}`)) return c.json(LOOKS_LIKE_SECRET, 400)
  try {
    return c.json({ ok: true, skill: await c.var.memory.saveSkill({ name, description, instructions }) })
  } catch (error) {
    return c.json({ ok: false, error: 'too_many_skills', message: String((error as Error).message) }, 409)
  }
})

app.delete('/api/skills/:name', async (c) => {
  const name = c.req.param('name')
  if (!(await c.var.memory.deleteSkill(name))) {
    const builtIn = BUILT_IN_SKILLS.some((s) => s.name === name)
    return c.json({ ok: false, error: builtIn ? 'built_in' : 'not_found', ...(builtIn ? { message: 'a built-in skill cannot be deleted; write one with its name to replace it' } : {}) }, builtIn ? 409 : 404)
  }
  return c.json({ ok: true })
})

// The activity log: every tool the agent called, allowed or blocked.
app.get('/api/activity', async (c) => c.json({ ok: true, activity: await c.var.memory.listActivity(100) }))

// The agent's state: the pause (the owner's kill switch in the page) and
// which model draws its images. GET reads it; PUT {paused?, imageModel?}
// changes either.
const state = async (memory: MemoryStore) => ({
  ok: true,
  paused: await memory.isPaused(),
  imageModel: imageModel(await memory.getSetting('imageModel')).id,
})

app.get('/api/state', async (c) => c.json(await state(c.var.memory)))

app.put('/api/state', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { paused?: unknown; imageModel?: unknown } | null
  const paused = body?.paused
  const image = body?.imageModel
  const validImage = typeof image === 'string' && IMAGE_MODELS.some((m) => m.id === image)
  if ((paused !== undefined && typeof paused !== 'boolean') || (image !== undefined && !validImage) || (paused === undefined && image === undefined)) {
    return c.json({ ok: false, error: 'invalid_state', message: 'send {"paused": true|false} and/or {"imageModel": one of the image models}' }, 400)
  }
  if (typeof paused === 'boolean') await c.var.memory.setPaused(paused)
  if (validImage) await c.var.memory.setSetting('imageModel', image)
  return c.json(await state(c.var.memory))
})

app.post('/api/chat', async (c) => {
  if (await c.var.memory.isPaused()) return c.json(PAUSED, 503)
  const parsed = ChatRequest.safeParse(await c.req.json().catch(() => null))
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_chat', message: parsed.error.issues.map((i) => i.message).join('; ') }, 400)
  const { model = modelKey('workers-ai', DEFAULT_MODEL), messages } = parsed.data
  if (messages[messages.length - 1]?.role !== 'user') {
    return c.json({ ok: false, error: 'invalid_chat', message: 'the last message must be the owner’s' }, 400)
  }

  const entry = (await models(c)).find((e) => e.key === model)
  if (!entry) return c.json({ ok: false, error: 'unknown_model', message: `${model} is not one of this agent’s models` }, 400)
  if (entry.provider === 'huggingface' && !huggingfaceConnected(c.env)) return c.json(HF_NOT_CONNECTED, 409)

  try {
    return c.json({ ok: true, ...(await runAgent({ env: c.env, entry, messages, memory: c.var.memory })) })
  } catch (error) {
    // The model's provider failed, not this Worker: say which. The message
    // is the provider's own; it carries no key of ours.
    console.error('model call failed', entry.key, error)
    const message = error instanceof SpaceError ? error.message : `${entry.label} failed: ${String((error as Error)?.message ?? error).slice(0, 300)}`
    return c.json({ ok: false, error: 'model_failed', message }, 502)
  }
})

// The agent's page: the chat, its models and its memories. Static; it shows
// nothing of the owner's until the access key is entered, which it keeps in
// the browser and sends as a bearer token.
app.get('/', (c) => c.html(page(API_NAME)))

// The operational contract: what the deploy's smoke and the bootstrap's probe
// read. It names the agent and the environment whose config the Worker runs,
// so a 200 here is this agent, deployed to that environment — not any page
// that happens to answer — and says what it is configured with, by NAME,
// never a value: whether it is unlocked, whether Hugging Face is connected,
// how many models its config offers, which tools.
app.get('/health', (c) => {
  const env = c.env
  return c.json({
    status: 'ok',
    name: API_NAME,
    environment: env?.ENVIRONMENT ?? 'unknown',
    access: accessConfigured(env) ? 'configured' : 'not configured',
    killSwitch: killSwitchOn(env) ? 'on' : 'off',
    huggingface: huggingfaceConnected(env) ? 'connected' : 'not connected',
    webSearch: webSearchConnected(env) ? 'connected' : 'not connected',
    models: {
      default: modelKey('workers-ai', DEFAULT_MODEL),
      'workers-ai': WORKERS_AI_MODELS.length,
      configured: parseHfModels(env?.HF_MODELS).length,
    },
    tools: toolNames(env),
    endpoints: { chat: '/api/chat', models: '/api/models', memories: '/api/memories', notes: '/api/notes', images: '/api/images', saved: '/api/saved', skills: '/api/skills', state: '/api/state', activity: '/api/activity', health: '/health' },
  })
})

export default app

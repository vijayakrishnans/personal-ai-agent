import { Hono, type Context } from 'hono'
import { z } from 'zod'
import { runAgent, ChatRequest, toolNames } from './agent'
import { bearer, keyMatches } from './auth'
import { accessConfigured, huggingfaceConnected, killSwitchOn, type Env } from './env'
import { API_NAME } from './identity'
import { memoryOf, MAX_MEMORY_CHARS, MAX_SPACE_CHARS, type MemoryStore } from './memory'
import { API_NAME_PATTERN, catalog, DEFAULT_MODEL, HF_MODEL_ID, modelKey, parseHfModels, SPACE_ID, WORKERS_AI_MODELS } from './models'
import { SpaceError } from './spaces'
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
  return c.json({ default: modelKey('workers-ai', DEFAULT_MODEL), huggingface: huggingfaceConnected(c.env), models: await models(c) })
})

const AddModel = z.discriminatedUnion('provider', [
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
app.delete('/api/models/:provider/:owner/:name', async (c) => {
  const { provider, owner, name } = c.req.param()
  const removed = await c.var.memory.removeModel(provider, `${owner}/${name}`)
  return removed ? c.json({ ok: true }) : c.json({ ok: false, error: 'not_found' }, 404)
})

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
  return c.json({ ok: true, memory: await c.var.memory.remember(text, space) }, 201)
})

// Moving a memory to another space — the page's graph does it.
app.patch('/api/memories/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id < 1) return c.json({ ok: false, error: 'not_found' }, 404)
  const body = (await c.req.json().catch(() => null)) as { space?: unknown } | null
  const space = spaceParam(body?.space)
  if (!space) return c.json(INVALID_SPACE, 400)
  const memory = await c.var.memory.moveMemory(id, space)
  return memory ? c.json({ ok: true, memory }) : c.json({ ok: false, error: 'not_found' }, 404)
})

app.delete('/api/memories/:id', async (c) => {
  const id = Number(c.req.param('id'))
  if (!Number.isInteger(id) || id < 1) return c.json({ ok: false, error: 'not_found' }, 404)
  return (await c.var.memory.forget(id)) ? c.json({ ok: true }) : c.json({ ok: false, error: 'not_found' }, 404)
})

// The pause — the owner's kill switch in the page. GET says whether it is on,
// PUT {paused} flips it.
app.get('/api/state', async (c) => c.json({ ok: true, paused: await c.var.memory.isPaused() }))

app.put('/api/state', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { paused?: unknown } | null
  if (typeof body?.paused !== 'boolean') return c.json({ ok: false, error: 'invalid_state', message: 'send {"paused": true} or {"paused": false}' }, 400)
  return c.json({ ok: true, paused: await c.var.memory.setPaused(body.paused) })
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
    endpoints: { chat: '/api/chat', models: '/api/models', memories: '/api/memories', state: '/api/state', health: '/health' },
  })
})

export default app

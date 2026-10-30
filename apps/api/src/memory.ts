import { DurableObject } from 'cloudflare:workers'

// THE AGENT'S MEMORY: one SQLite-backed Durable Object per environment, named
// `owner` (memoryOf below). It keeps what outlives a chat — the facts the
// agent was asked to remember, and the models its owner added in the page —
// and nothing else: a conversation lives in the owner's browser, so the
// Worker never stores what was said. Reached over RPC, so every method here
// is the whole of what the Worker can ask of it.

// Every memory belongs to one space — a topic its owner can name, such as
// Work or Health. The page draws the spaces as a graph; the agent files a
// fact under one when it remembers it.
export type Memory = { id: number; text: string; space: string; createdAt: string }

export type StoredModel = {
  provider: 'huggingface' | 'space'
  id: string
  label: string
  tools: boolean
  apiName?: string
}

// What the agent's routes need of the store. The Durable Object implements
// it; the tests implement it in memory.
export interface MemoryStore {
  remember(text: string, space?: string): Promise<Memory>
  recall(query: string, limit?: number): Promise<Memory[]>
  forget(id: number): Promise<boolean>
  moveMemory(id: number, space: string): Promise<Memory | null>
  listMemories(limit?: number): Promise<Memory[]>
  addModel(model: StoredModel): Promise<StoredModel>
  removeModel(provider: string, id: string): Promise<boolean>
  listModels(): Promise<StoredModel[]>
}

// A fact or a model the owner can see in full on one screen.
export const MAX_MEMORY_CHARS = 500
export const MAX_MEMORIES = 500
export const MAX_MODELS = 50
export const MAX_SPACE_CHARS = 40
export const DEFAULT_SPACE = 'General'

/** A space's name as stored: trimmed, one line, short; empty is the default space. */
export function spaceName(space: string | undefined): string {
  const clean = (space ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SPACE_CHARS)
  return clean || DEFAULT_SPACE
}

export class AgentMemory extends DurableObject implements MemoryStore {
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS models (
          provider TEXT NOT NULL,
          id TEXT NOT NULL,
          label TEXT NOT NULL,
          tools INTEGER NOT NULL,
          api_name TEXT,
          created_at TEXT NOT NULL,
          PRIMARY KEY (provider, id)
        );
      `)
      // Memories kept before spaces existed have none: they join the default.
      const columns = ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(memories)').toArray()
      if (!columns.some((c) => c.name === 'space')) {
        ctx.storage.sql.exec(`ALTER TABLE memories ADD COLUMN space TEXT NOT NULL DEFAULT '${DEFAULT_SPACE}'`)
      }
    })
  }

  async remember(text: string, space?: string): Promise<Memory> {
    const sql = this.ctx.storage.sql
    const clean = text.trim().slice(0, MAX_MEMORY_CHARS)
    const filed = spaceName(space)
    const createdAt = new Date().toISOString()
    const row = sql.exec<{ id: number }>('INSERT INTO memories (text, space, created_at) VALUES (?, ?, ?) RETURNING id', clean, filed, createdAt).one()
    // The oldest go first once the store is full, so it never grows unbounded.
    sql.exec('DELETE FROM memories WHERE id NOT IN (SELECT id FROM memories ORDER BY id DESC LIMIT ?)', MAX_MEMORIES)
    return { id: row.id, text: clean, space: filed, createdAt }
  }

  async recall(query: string, limit = 10): Promise<Memory[]> {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 8)
    if (words.length === 0) return this.listMemories(limit)
    // A word matches a memory's text or the name of its space.
    const where = words.map(() => "lower(text || ' ' || space) LIKE ? ESCAPE '\\'").join(' OR ')
    const args = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    return this.rows(`SELECT id, text, space, created_at FROM memories WHERE ${where} ORDER BY id DESC LIMIT ?`, ...args, limit)
  }

  async forget(id: number): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM memories WHERE id = ?', id).rowsWritten > 0
  }

  async moveMemory(id: number, space: string): Promise<Memory | null> {
    const moved = this.rows('UPDATE memories SET space = ? WHERE id = ? RETURNING id, text, space, created_at', spaceName(space), id)
    return moved[0] ?? null
  }

  async listMemories(limit = 50): Promise<Memory[]> {
    return this.rows('SELECT id, text, space, created_at FROM memories ORDER BY id DESC LIMIT ?', limit)
  }

  async addModel(model: StoredModel): Promise<StoredModel> {
    const sql = this.ctx.storage.sql
    const count = sql.exec<{ n: number }>('SELECT count(*) AS n FROM models').one().n
    const exists = sql.exec('SELECT 1 FROM models WHERE provider = ? AND id = ?', model.provider, model.id).toArray().length > 0
    if (!exists && count >= MAX_MODELS) throw new Error(`at most ${MAX_MODELS} models can be added`)
    sql.exec(
      `INSERT INTO models (provider, id, label, tools, api_name, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (provider, id) DO UPDATE SET label = excluded.label, tools = excluded.tools, api_name = excluded.api_name`,
      model.provider,
      model.id,
      model.label,
      model.tools ? 1 : 0,
      model.apiName ?? null,
      new Date().toISOString(),
    )
    return model
  }

  async removeModel(provider: string, id: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM models WHERE provider = ? AND id = ?', provider, id).rowsWritten > 0
  }

  async listModels(): Promise<StoredModel[]> {
    return this.ctx.storage.sql
      .exec<{ provider: string; id: string; label: string; tools: number; api_name: string | null }>(
        'SELECT provider, id, label, tools, api_name FROM models ORDER BY created_at, id',
      )
      .toArray()
      .map((r) => ({
        provider: r.provider as StoredModel['provider'],
        id: r.id,
        label: r.label,
        tools: r.tools === 1,
        ...(r.api_name ? { apiName: r.api_name } : {}),
      }))
  }

  private rows(query: string, ...args: (string | number)[]): Memory[] {
    return this.ctx.storage.sql
      .exec<{ id: number; text: string; space: string; created_at: string }>(query, ...args)
      .toArray()
      .map((r) => ({ id: r.id, text: r.text, space: r.space, createdAt: r.created_at }))
  }
}

/** The owner's store: one Durable Object per environment, by name. */
export function memoryOf(ns: DurableObjectNamespace<AgentMemory>): MemoryStore {
  return ns.get(ns.idFromName('owner')) as unknown as MemoryStore
}

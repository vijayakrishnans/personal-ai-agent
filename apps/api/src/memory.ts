import { DurableObject } from 'cloudflare:workers'

// THE AGENT'S MEMORY: one SQLite-backed Durable Object per environment, named
// `owner` (memoryOf below). It keeps what outlives a chat — the facts the
// agent was asked to remember, its owner's notes and to-dos, its owner's
// library (the images it drew, the answers they saved), the models its owner
// added in the page, its settings (paused? which image model?), and a log of
// the tools it called — and nothing else: a conversation lives in the owner's browser, so the
// Worker never stores what was said. Reached over RPC, so every method here
// is the whole of what the Worker can ask of it.

// Every memory belongs to one space — a topic its owner can name, such as
// Work or Health. The page draws the spaces as a graph; the agent files a
// fact under one when it remembers it.
export type Memory = { id: number; text: string; space: string; createdAt: string }

// One tool call, as the activity log keeps it: never a secret (the detail is
// redacted before it is written) and never more than a line.
export type Activity = { id: number; at: string; tool: string; detail: string; outcome: 'ok' | 'blocked' | 'error' }

// A note or a to-do on one of the owner's lists ("Notes" by default).
export type Note = { id: number; list: string; text: string; done: boolean; createdAt: string }
export type NoteChange = { text?: string; list?: string; done?: boolean }

// An image the agent drew: what was asked for, with which model, and when.
// Its bytes are fetched on their own (getImage), never handed to a model.
export type Image = { id: number; prompt: string; model: string; createdAt: string }

// An answer (or anything else) the owner saved to their library: kept whole,
// never put in a prompt.
export type Saved = { id: number; text: string; source: string; createdAt: string }

export type StoredModel = {
  provider: 'workers-ai' | 'huggingface' | 'space'
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
  isPaused(): Promise<boolean>
  setPaused(paused: boolean): Promise<boolean>
  logActivity(entry: Omit<Activity, 'id' | 'at'>): Promise<void>
  listActivity(limit?: number): Promise<Activity[]>
  addNote(text: string, list?: string): Promise<Note>
  listNotes(list?: string): Promise<Note[]>
  updateNote(id: number, change: NoteChange): Promise<Note | null>
  deleteNote(id: number): Promise<boolean>
  saveImage(prompt: string, model: string, base64: string): Promise<Image>
  getImage(id: number): Promise<(Image & { base64: string }) | null>
  listImages(): Promise<Image[]>
  deleteImage(id: number): Promise<boolean>
  saveItem(text: string, source: string): Promise<Saved>
  listSaved(): Promise<Saved[]>
  deleteSaved(id: number): Promise<boolean>
  getSetting(key: SettingKey): Promise<string | null>
  setSetting(key: SettingKey, value: string): Promise<void>
}

export type SettingKey = 'imageModel'

// A fact or a model the owner can see in full on one screen.
export const MAX_MEMORY_CHARS = 500
export const MAX_MEMORIES = 500
export const MAX_MODELS = 50
export const MAX_ACTIVITY = 500
export const MAX_NOTE_CHARS = 1000
export const MAX_NOTES = 500
export const MAX_IMAGES = 200
export const MAX_SAVED = 500
export const MAX_SAVED_CHARS = 20_000
export const DEFAULT_LIST = 'Notes'

/** A list's name as stored: trimmed, one line, short; empty is the default list. */
export function listName(list: string | undefined): string {
  const clean = (list ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SPACE_CHARS)
  return clean || DEFAULT_LIST
}
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
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          list TEXT NOT NULL,
          text TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS images (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt TEXT NOT NULL,
          data TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS saved (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          text TEXT NOT NULL,
          source TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS activity (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at TEXT NOT NULL,
          tool TEXT NOT NULL,
          detail TEXT NOT NULL,
          outcome TEXT NOT NULL
        );
      `)
      // Images drawn before the model was kept were all FLUX.1 [schnell].
      if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(images)').toArray().some((c) => c.name === 'model')) {
        ctx.storage.sql.exec("ALTER TABLE images ADD COLUMN model TEXT NOT NULL DEFAULT '@cf/black-forest-labs/flux-1-schnell'")
      }
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

  // THE PAUSE: the owner's everyday kill switch, flipped in the page. While
  // it is on the agent calls no model; what it remembers stays readable.
  async isPaused(): Promise<boolean> {
    return (await this.getSetting('paused')) === '1'
  }

  async setPaused(paused: boolean): Promise<boolean> {
    await this.setSetting('paused', paused ? '1' : '0')
    return paused
  }

  async getSetting(key: SettingKey | 'paused'): Promise<string | null> {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM settings WHERE key = ?', key).toArray()[0]?.value ?? null
  }

  async setSetting(key: SettingKey | 'paused', value: string): Promise<void> {
    this.ctx.storage.sql.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
  }

  // THE ACTIVITY LOG: every tool call the agent made, allowed or blocked —
  // what the owner reads in ☰ → Access. The newest MAX_ACTIVITY are kept.
  async logActivity(entry: Omit<Activity, 'id' | 'at'>): Promise<void> {
    const sql = this.ctx.storage.sql
    sql.exec('INSERT INTO activity (at, tool, detail, outcome) VALUES (?, ?, ?, ?)', new Date().toISOString(), entry.tool, entry.detail.slice(0, 300), entry.outcome)
    sql.exec('DELETE FROM activity WHERE id NOT IN (SELECT id FROM activity ORDER BY id DESC LIMIT ?)', MAX_ACTIVITY)
  }

  async listActivity(limit = 100): Promise<Activity[]> {
    return this.ctx.storage.sql
      .exec<Activity>('SELECT id, at, tool, detail, outcome FROM activity ORDER BY id DESC LIMIT ?', limit)
      .toArray()
      .map((r) => ({ ...r }))
  }

  // NOTES AND TO-DOS: the owner's lists. A list is just a name on its notes;
  // the oldest go first once there are MAX_NOTES.
  async addNote(text: string, list?: string): Promise<Note> {
    const sql = this.ctx.storage.sql
    const clean = text.trim().slice(0, MAX_NOTE_CHARS)
    const name = listName(list)
    const createdAt = new Date().toISOString()
    const { id } = sql.exec<{ id: number }>('INSERT INTO notes (list, text, done, created_at) VALUES (?, ?, 0, ?) RETURNING id', name, clean, createdAt).one()
    sql.exec('DELETE FROM notes WHERE id NOT IN (SELECT id FROM notes ORDER BY id DESC LIMIT ?)', MAX_NOTES)
    return { id, list: name, text: clean, done: false, createdAt }
  }

  /** Open notes before done ones, each list's oldest first. */
  async listNotes(list?: string): Promise<Note[]> {
    const where = list ? 'WHERE list = ?' : ''
    return this.notes(`SELECT id, list, text, done, created_at FROM notes ${where} ORDER BY done, list, id LIMIT 300`, ...(list ? [listName(list)] : []))
  }

  async updateNote(id: number, change: NoteChange): Promise<Note | null> {
    const sets: string[] = []
    const args: (string | number)[] = []
    if (change.text !== undefined) sets.push('text = ?'), args.push(change.text.trim().slice(0, MAX_NOTE_CHARS))
    if (change.list !== undefined) sets.push('list = ?'), args.push(listName(change.list))
    if (change.done !== undefined) sets.push('done = ?'), args.push(change.done ? 1 : 0)
    if (sets.length === 0) return this.notes('SELECT id, list, text, done, created_at FROM notes WHERE id = ?', id)[0] ?? null
    return this.notes(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? RETURNING id, list, text, done, created_at`, ...args, id)[0] ?? null
  }

  async deleteNote(id: number): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM notes WHERE id = ?', id).rowsWritten > 0
  }

  private notes(query: string, ...args: (string | number)[]): Note[] {
    return this.ctx.storage.sql
      .exec<{ id: number; list: string; text: string; done: number; created_at: string }>(query, ...args)
      .toArray()
      .map((r) => ({ id: r.id, list: r.list, text: r.text, done: r.done === 1, createdAt: r.created_at }))
  }

  // THE LIBRARY: images the agent drew (the newest MAX_IMAGES kept), and
  // what the owner saved (the newest MAX_SAVED).
  async saveImage(prompt: string, model: string, base64: string): Promise<Image> {
    const sql = this.ctx.storage.sql
    const createdAt = new Date().toISOString()
    const { id } = sql.exec<{ id: number }>('INSERT INTO images (prompt, model, data, created_at) VALUES (?, ?, ?, ?) RETURNING id', prompt, model, base64, createdAt).one()
    sql.exec('DELETE FROM images WHERE id NOT IN (SELECT id FROM images ORDER BY id DESC LIMIT ?)', MAX_IMAGES)
    return { id, prompt, model, createdAt }
  }

  async getImage(id: number): Promise<(Image & { base64: string }) | null> {
    const row = this.ctx.storage.sql
      .exec<{ id: number; prompt: string; model: string; data: string; created_at: string }>('SELECT id, prompt, model, data, created_at FROM images WHERE id = ?', id)
      .toArray()[0]
    return row ? { id: row.id, prompt: row.prompt, model: row.model, createdAt: row.created_at, base64: row.data } : null
  }

  async listImages(): Promise<Image[]> {
    return this.ctx.storage.sql
      .exec<{ id: number; prompt: string; model: string; created_at: string }>('SELECT id, prompt, model, created_at FROM images ORDER BY id DESC')
      .toArray()
      .map((r) => ({ id: r.id, prompt: r.prompt, model: r.model, createdAt: r.created_at }))
  }

  async deleteImage(id: number): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM images WHERE id = ?', id).rowsWritten > 0
  }

  async saveItem(text: string, source: string): Promise<Saved> {
    const sql = this.ctx.storage.sql
    const clean = text.trim().slice(0, MAX_SAVED_CHARS)
    const createdAt = new Date().toISOString()
    const { id } = sql.exec<{ id: number }>('INSERT INTO saved (text, source, created_at) VALUES (?, ?, ?) RETURNING id', clean, source.slice(0, 120), createdAt).one()
    sql.exec('DELETE FROM saved WHERE id NOT IN (SELECT id FROM saved ORDER BY id DESC LIMIT ?)', MAX_SAVED)
    return { id, text: clean, source: source.slice(0, 120), createdAt }
  }

  async listSaved(): Promise<Saved[]> {
    return this.ctx.storage.sql
      .exec<{ id: number; text: string; source: string; created_at: string }>('SELECT id, text, source, created_at FROM saved ORDER BY id DESC')
      .toArray()
      .map((r) => ({ id: r.id, text: r.text, source: r.source, createdAt: r.created_at }))
  }

  async deleteSaved(id: number): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM saved WHERE id = ?', id).rowsWritten > 0
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

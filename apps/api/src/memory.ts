import { DurableObject } from 'cloudflare:workers'
import { MAX_SKILLS, type Skill } from './skills'

// THE AGENT'S MEMORY: one SQLite-backed Durable Object per environment, named
// `owner` (memoryOf below). It keeps what outlives a chat — the facts the
// agent was asked to remember, its owner's notes and to-dos, its owner's
// library (the images it drew, the music it made, the answers they saved), the models its owner
// added in the page, the skills its owner wrote, its settings (paused? which
// image model?), a log of the tools it called, and the owner's conversations
// — each saved with every secret already taken out, so the sidebar can list
// and search them. Reached over RPC, so every method here is the whole of
// what the Worker can ask of it.

// Every memory belongs to one space — a topic its owner can name, such as
// Work or Health. The page draws the spaces as a graph; the agent files a
// fact under one when it remembers it.
// A memory is a fact ("Prefers tea"), or a question the owner asked and the
// answer they kept: `question` set, `text` the answer.
export type Memory = { id: number; text: string; space: string; question: string | null; createdAt: string }

// One tool call, as the activity log keeps it: never a secret (the detail is
// redacted before it is written) and never more than a line.
export type Activity = { id: number; at: string; tool: string; detail: string; outcome: 'ok' | 'blocked' | 'error' }

// A note or a to-do on one of the owner's lists ("Notes" by default). Notes
// are short-lived: one expires (is deleted) KEEP_DAYS after it was kept,
// unless the owner keeps it for longer, for good, or moves it to knowledge.
export type Note = { id: number; list: string; text: string; done: boolean; createdAt: string; expiresAt: string | null }
export type NoteChange = { text?: string; list?: string; done?: boolean; keepDays?: KeepDays }
/** How long a note is kept from now: a number of days, or null for good. */
export type KeepDays = 2 | 7 | null
export const KEEP_DAYS: KeepDays = 2

// A conversation as the page keeps it: its messages (role, words, and what
// was shown with them), titled by its first question.
export type ConversationMessage = { role: 'user' | 'assistant'; content: string; meta?: string; error?: boolean; images?: { id: number; prompt: string }[]; maps?: unknown[] }
export type ConversationSummary = { id: string; title: string; updatedAt: string; snippet?: string }
export type Conversation = ConversationSummary & { messages: ConversationMessage[] }

// An image the agent drew: what was asked for, with which model, and when.
// Its bytes are fetched on their own (getImage), never handed to a model.
export type Image = { id: number; prompt: string; model: string; createdAt: string }

// A track the agent made: the style asked for, its lyrics, with which model,
// how long, and when. Its audio is fetched on its own (getTrack).
export type TrackInfo = { id: number; style: string; lyrics: string; model: string; type: string; seconds: number; createdAt: string }

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
  remember(text: string, space?: string, question?: string): Promise<Memory>
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
  addNote(text: string, list?: string, keepDays?: KeepDays): Promise<Note>
  listNotes(list?: string): Promise<Note[]>
  updateNote(id: number, change: NoteChange): Promise<Note | null>
  deleteNote(id: number): Promise<boolean>
  saveImage(prompt: string, model: string, base64: string): Promise<Image>
  getImage(id: number): Promise<(Image & { base64: string }) | null>
  listImages(): Promise<Image[]>
  deleteImage(id: number): Promise<boolean>
  saveTrack(track: Omit<TrackInfo, 'id' | 'createdAt'>, base64: string): Promise<TrackInfo>
  getTrack(id: number): Promise<(TrackInfo & { base64: string }) | null>
  listTracks(): Promise<TrackInfo[]>
  deleteTrack(id: number): Promise<boolean>
  saveItem(text: string, source: string): Promise<Saved>
  listSaved(): Promise<Saved[]>
  deleteSaved(id: number): Promise<boolean>
  listSkills(): Promise<Skill[]>
  saveSkill(skill: Skill): Promise<Skill>
  deleteSkill(name: string): Promise<boolean>
  saveConversation(id: string, messages: ConversationMessage[], title?: string): Promise<ConversationSummary>
  getConversation(id: string): Promise<Conversation | null>
  listConversations(query?: string, limit?: number): Promise<ConversationSummary[]>
  deleteConversation(id: string): Promise<boolean>
  getSetting(key: SettingKey): Promise<string | null>
  setSetting(key: SettingKey, value: string): Promise<void>
  getVault(name: string): Promise<string | null>
  setVault(name: string, sealed: string | null): Promise<void>
}

export type SettingKey = 'imageModel' | 'musicModel'

// A fact or a model the owner can see in full on one screen.
export const MAX_MEMORY_CHARS = 500
// A kept answer may be longer than a fact; the prompt carries only its start.
export const MAX_ANSWER_CHARS = 4000
export const MAX_QUESTION_CHARS = 1000
export const MAX_CONVERSATIONS = 300
export const MAX_CONVERSATION_BYTES = 1_500_000
export const MAX_TITLE_CHARS = 80
export const MAX_MEMORIES = 500
export const MAX_MODELS = 50
export const MAX_ACTIVITY = 500
// A note can hold a whole saved answer.
export const MAX_NOTE_CHARS = 20_000
export const MAX_NOTES = 500
export const MAX_IMAGES = 200
export const MAX_SAVED = 500
// A track's audio is kept in parts, each well under a row's 2 MB.
export const MAX_TRACKS = 40
export const TRACK_PART_CHARS = 1_500_000
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

const NOTE_COLUMNS = 'id, list, text, done, created_at, expires_at'

/** When a note kept for `days` from now expires: null for good. */
function expiry(days: KeepDays): string | null {
  return days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString()
}

/** A conversation's title: its first question, on one line. */
export function titleOf(messages: ConversationMessage[]): string {
  const first = messages.find((m) => m.role === 'user')?.content ?? 'New conversation'
  const line = first.replace(/\s+/g, ' ').trim()
  return line.length > MAX_TITLE_CHARS ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…` : line
}

/** Where a search matched: some words either side of the first hit. */
export function snippetOf(messages: ConversationMessage[], words: string[]): string | undefined {
  for (const m of messages) {
    const text = m.content.replace(/\s+/g, ' ')
    const at = text.toLowerCase().indexOf(words[0] as string)
    if (at >= 0) return `${at > 40 ? '…' : ''}${text.slice(Math.max(0, at - 40), at + 80).trim()}${at + 80 < text.length ? '…' : ''}`
  }
  return undefined
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
        CREATE TABLE IF NOT EXISTS vault (
          name TEXT PRIMARY KEY,
          sealed TEXT NOT NULL
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
        CREATE TABLE IF NOT EXISTS skills (
          name TEXT PRIMARY KEY,
          description TEXT NOT NULL,
          instructions TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS tracks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          style TEXT NOT NULL,
          lyrics TEXT NOT NULL,
          model TEXT NOT NULL,
          type TEXT NOT NULL,
          seconds INTEGER NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS track_parts (
          track_id INTEGER NOT NULL,
          n INTEGER NOT NULL,
          data TEXT NOT NULL,
          PRIMARY KEY (track_id, n)
        );
        CREATE TABLE IF NOT EXISTS conversations (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          messages TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
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
      if (!columns.some((c) => c.name === 'question')) ctx.storage.sql.exec('ALTER TABLE memories ADD COLUMN question TEXT')
      // Notes kept before notes expired are kept for good.
      if (!ctx.storage.sql.exec<{ name: string }>('PRAGMA table_info(notes)').toArray().some((c) => c.name === 'expires_at')) {
        ctx.storage.sql.exec('ALTER TABLE notes ADD COLUMN expires_at TEXT')
      }
    })
  }

  async remember(text: string, space?: string, question?: string): Promise<Memory> {
    const sql = this.ctx.storage.sql
    const asked = question?.trim().slice(0, MAX_QUESTION_CHARS) || null
    const clean = text.trim().slice(0, asked ? MAX_ANSWER_CHARS : MAX_MEMORY_CHARS)
    const filed = spaceName(space)
    const createdAt = new Date().toISOString()
    const row = sql.exec<{ id: number }>('INSERT INTO memories (text, space, question, created_at) VALUES (?, ?, ?, ?) RETURNING id', clean, filed, asked, createdAt).one()
    // The oldest go first once the store is full, so it never grows unbounded.
    sql.exec('DELETE FROM memories WHERE id NOT IN (SELECT id FROM memories ORDER BY id DESC LIMIT ?)', MAX_MEMORIES)
    return { id: row.id, text: clean, space: filed, question: asked, createdAt }
  }

  async recall(query: string, limit = 10): Promise<Memory[]> {
    const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 1).slice(0, 8)
    if (words.length === 0) return this.listMemories(limit)
    // A word matches a memory's text or the name of its space.
    const where = words.map(() => "lower(text || ' ' || space || ' ' || coalesce(question, '')) LIKE ? ESCAPE '\\'").join(' OR ')
    const args = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    return this.rows(`SELECT id, text, space, question, created_at FROM memories WHERE ${where} ORDER BY id DESC LIMIT ?`, ...args, limit)
  }

  async forget(id: number): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM memories WHERE id = ?', id).rowsWritten > 0
  }

  async moveMemory(id: number, space: string): Promise<Memory | null> {
    const moved = this.rows('UPDATE memories SET space = ? WHERE id = ? RETURNING id, text, space, question, created_at', spaceName(space), id)
    return moved[0] ?? null
  }

  async listMemories(limit = 50): Promise<Memory[]> {
    return this.rows('SELECT id, text, space, question, created_at FROM memories ORDER BY id DESC LIMIT ?', limit)
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

  // SKILLS the owner wrote (skills.ts): one per name, at most MAX_SKILLS.
  async listSkills(): Promise<Skill[]> {
    return this.ctx.storage.sql.exec<Skill>('SELECT name, description, instructions FROM skills ORDER BY name').toArray().map((r) => ({ ...r }))
  }

  async saveSkill(skill: Skill): Promise<Skill> {
    const sql = this.ctx.storage.sql
    const exists = sql.exec('SELECT 1 FROM skills WHERE name = ?', skill.name).toArray().length > 0
    if (!exists && sql.exec<{ n: number }>('SELECT count(*) AS n FROM skills').one().n >= MAX_SKILLS) throw new Error(`at most ${MAX_SKILLS} skills`)
    sql.exec(
      `INSERT INTO skills (name, description, instructions, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET description = excluded.description, instructions = excluded.instructions, updated_at = excluded.updated_at`,
      skill.name,
      skill.description,
      skill.instructions,
      new Date().toISOString(),
    )
    return skill
  }

  async deleteSkill(name: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM skills WHERE name = ?', name).rowsWritten > 0
  }

  async getSetting(key: SettingKey | 'paused'): Promise<string | null> {
    return this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM settings WHERE key = ?', key).toArray()[0]?.value ?? null
  }

  async setSetting(key: SettingKey | 'paused', value: string): Promise<void> {
    this.ctx.storage.sql.exec('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value', key, value)
  }

  // THE VAULT: secrets the owner pasted in the page, already sealed by
  // vault.ts. They are never listed and never leave the Worker.
  async getVault(name: string): Promise<string | null> {
    return this.ctx.storage.sql.exec<{ sealed: string }>('SELECT sealed FROM vault WHERE name = ?', name).toArray()[0]?.sealed ?? null
  }

  async setVault(name: string, sealed: string | null): Promise<void> {
    if (sealed === null) this.ctx.storage.sql.exec('DELETE FROM vault WHERE name = ?', name)
    else this.ctx.storage.sql.exec('INSERT INTO vault (name, sealed) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET sealed = excluded.sealed', name, sealed)
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
  async addNote(text: string, list?: string, keepDays: KeepDays = KEEP_DAYS): Promise<Note> {
    const sql = this.ctx.storage.sql
    this.dropExpired()
    const clean = text.trim().slice(0, MAX_NOTE_CHARS)
    const name = listName(list)
    const createdAt = new Date().toISOString()
    const expiresAt = expiry(keepDays)
    const { id } = sql.exec<{ id: number }>('INSERT INTO notes (list, text, done, created_at, expires_at) VALUES (?, ?, 0, ?, ?) RETURNING id', name, clean, createdAt, expiresAt).one()
    sql.exec('DELETE FROM notes WHERE id NOT IN (SELECT id FROM notes ORDER BY id DESC LIMIT ?)', MAX_NOTES)
    await this.wakeForExpiry()
    return { id, list: name, text: clean, done: false, createdAt, expiresAt }
  }

  /** Open notes before done ones, each list's oldest first. Expired ones are gone. */
  async listNotes(list?: string): Promise<Note[]> {
    this.dropExpired()
    const where = list ? 'WHERE list = ?' : ''
    return this.notes(`SELECT ${NOTE_COLUMNS} FROM notes ${where} ORDER BY done, list, id LIMIT 300`, ...(list ? [listName(list)] : []))
  }

  async updateNote(id: number, change: NoteChange): Promise<Note | null> {
    this.dropExpired()
    const sets: string[] = []
    const args: (string | number | null)[] = []
    if (change.text !== undefined) sets.push('text = ?'), args.push(change.text.trim().slice(0, MAX_NOTE_CHARS))
    if (change.list !== undefined) sets.push('list = ?'), args.push(listName(change.list))
    if (change.done !== undefined) sets.push('done = ?'), args.push(change.done ? 1 : 0)
    if (change.keepDays !== undefined) sets.push('expires_at = ?'), args.push(expiry(change.keepDays))
    if (sets.length === 0) return this.notes(`SELECT ${NOTE_COLUMNS} FROM notes WHERE id = ?`, id)[0] ?? null
    const note = this.notes(`UPDATE notes SET ${sets.join(', ')} WHERE id = ? RETURNING ${NOTE_COLUMNS}`, ...args, id)[0] ?? null
    if (change.keepDays !== undefined) await this.wakeForExpiry()
    return note
  }

  // EXPIRY: a note past its time is deleted — when the notes are next read
  // or written, and by the object's alarm, set for the next note to expire,
  // so one is gone on time even if nobody looks.
  private dropExpired(): void {
    this.ctx.storage.sql.exec('DELETE FROM notes WHERE expires_at IS NOT NULL AND expires_at <= ?', new Date().toISOString())
  }

  private async wakeForExpiry(): Promise<void> {
    const next = this.ctx.storage.sql.exec<{ at: string | null }>('SELECT min(expires_at) AS at FROM notes WHERE expires_at IS NOT NULL').toArray()[0]?.at
    // The tests' storage has no alarm; the runtime's always does.
    const storage = this.ctx.storage as Partial<DurableObjectStorage>
    if (next && storage.setAlarm) await storage.setAlarm(new Date(next).getTime() + 1000)
  }

  async alarm(): Promise<void> {
    this.dropExpired()
    await this.wakeForExpiry()
  }

  async deleteNote(id: number): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM notes WHERE id = ?', id).rowsWritten > 0
  }

  private notes(query: string, ...args: (string | number | null)[]): Note[] {
    return this.ctx.storage.sql
      .exec<{ id: number; list: string; text: string; done: number; created_at: string; expires_at: string | null }>(query, ...args)
      .toArray()
      .map((r) => ({ id: r.id, list: r.list, text: r.text, done: r.done === 1, createdAt: r.created_at, expiresAt: r.expires_at }))
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

  // MUSIC: the newest MAX_TRACKS, each track's audio (base64) in parts.
  async saveTrack(track: Omit<TrackInfo, 'id' | 'createdAt'>, base64: string): Promise<TrackInfo> {
    const sql = this.ctx.storage.sql
    const createdAt = new Date().toISOString()
    const { id } = sql
      .exec<{ id: number }>('INSERT INTO tracks (style, lyrics, model, type, seconds, created_at) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', track.style, track.lyrics, track.model, track.type, track.seconds, createdAt)
      .one()
    for (let n = 0; n * TRACK_PART_CHARS < base64.length; n++) {
      sql.exec('INSERT INTO track_parts (track_id, n, data) VALUES (?, ?, ?)', id, n, base64.slice(n * TRACK_PART_CHARS, (n + 1) * TRACK_PART_CHARS))
    }
    sql.exec('DELETE FROM tracks WHERE id NOT IN (SELECT id FROM tracks ORDER BY id DESC LIMIT ?)', MAX_TRACKS)
    sql.exec('DELETE FROM track_parts WHERE track_id NOT IN (SELECT id FROM tracks)')
    return { id, ...track, createdAt }
  }

  async getTrack(id: number): Promise<(TrackInfo & { base64: string }) | null> {
    const info = this.tracks('SELECT id, style, lyrics, model, type, seconds, created_at FROM tracks WHERE id = ?', id)[0]
    if (!info) return null
    const parts = this.ctx.storage.sql.exec<{ data: string }>('SELECT data FROM track_parts WHERE track_id = ? ORDER BY n', id).toArray()
    return { ...info, base64: parts.map((p) => p.data).join('') }
  }

  async listTracks(): Promise<TrackInfo[]> {
    return this.tracks('SELECT id, style, lyrics, model, type, seconds, created_at FROM tracks ORDER BY id DESC')
  }

  async deleteTrack(id: number): Promise<boolean> {
    const sql = this.ctx.storage.sql
    sql.exec('DELETE FROM track_parts WHERE track_id = ?', id)
    return sql.exec('DELETE FROM tracks WHERE id = ?', id).rowsWritten > 0
  }

  private tracks(query: string, ...args: number[]): TrackInfo[] {
    return this.ctx.storage.sql
      .exec<{ id: number; style: string; lyrics: string; model: string; type: string; seconds: number; created_at: string }>(query, ...args)
      .toArray()
      .map((r) => ({ id: r.id, style: r.style, lyrics: r.lyrics, model: r.model, type: r.type, seconds: r.seconds, createdAt: r.created_at }))
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

  // CONVERSATIONS: the newest MAX_CONVERSATIONS, each saved whole on every
  // turn (the page sends it after each answer). One too big to keep sheds its
  // oldest messages.
  async saveConversation(id: string, messages: ConversationMessage[], title?: string): Promise<ConversationSummary> {
    const sql = this.ctx.storage.sql
    let kept = messages
    let body = JSON.stringify(kept)
    while (body.length > MAX_CONVERSATION_BYTES && kept.length > 1) {
      kept = kept.slice(Math.ceil(kept.length / 10))
      body = JSON.stringify(kept)
    }
    const named = (title ?? '').trim() || titleOf(messages)
    const now = new Date().toISOString()
    sql.exec(
      `INSERT INTO conversations (id, title, messages, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET title = excluded.title, messages = excluded.messages, updated_at = excluded.updated_at`,
      id,
      named,
      body,
      now,
      now,
    )
    sql.exec('DELETE FROM conversations WHERE id NOT IN (SELECT id FROM conversations ORDER BY updated_at DESC LIMIT ?)', MAX_CONVERSATIONS)
    return { id, title: named, updatedAt: now }
  }

  async getConversation(id: string): Promise<Conversation | null> {
    const row = this.ctx.storage.sql
      .exec<{ id: string; title: string; messages: string; updated_at: string }>('SELECT id, title, messages, updated_at FROM conversations WHERE id = ?', id)
      .toArray()[0]
    return row ? { id: row.id, title: row.title, updatedAt: row.updated_at, messages: JSON.parse(row.messages) as ConversationMessage[] } : null
  }

  /** The newest first; with a query, those whose title or words hold every word of it, each with where it matched. */
  async listConversations(query = '', limit = 20): Promise<ConversationSummary[]> {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6)
    if (!words.length) {
      return this.ctx.storage.sql
        .exec<{ id: string; title: string; updated_at: string }>('SELECT id, title, updated_at FROM conversations ORDER BY updated_at DESC LIMIT ?', limit)
        .toArray()
        .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }))
    }
    const where = words.map(() => "lower(title || ' ' || messages) LIKE ? ESCAPE '\\'").join(' AND ')
    const args = words.map((w) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
    return this.ctx.storage.sql
      .exec<{ id: string; title: string; messages: string; updated_at: string }>(`SELECT id, title, messages, updated_at FROM conversations WHERE ${where} ORDER BY updated_at DESC LIMIT ?`, ...args, limit)
      .toArray()
      .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at, snippet: snippetOf(JSON.parse(r.messages) as ConversationMessage[], words) }))
  }

  async deleteConversation(id: string): Promise<boolean> {
    return this.ctx.storage.sql.exec('DELETE FROM conversations WHERE id = ?', id).rowsWritten > 0
  }

  private rows(query: string, ...args: (string | number)[]): Memory[] {
    return this.ctx.storage.sql
      .exec<{ id: number; text: string; space: string; question: string | null; created_at: string }>(query, ...args)
      .toArray()
      .map((r) => ({ id: r.id, text: r.text, space: r.space, question: r.question ?? null, createdAt: r.created_at }))
  }
}

/** The owner's store: one Durable Object per environment, by name. */
export function memoryOf(ns: DurableObjectNamespace<AgentMemory>): MemoryStore {
  return ns.get(ns.idFromName('owner')) as unknown as MemoryStore
}

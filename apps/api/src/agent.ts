import { APICallError, generateText, stepCountIs, tool, type ModelMessage } from 'ai'
import { z } from 'zod'
import type { Env } from './env'
import { API_NAME } from './identity'
import { MAX_SPACE_CHARS, type Memory, type MemoryStore } from './memory'
import { languageModel, type ModelEntry } from './models'
import { callSpace } from './spaces'

// THE AGENT: one turn of a conversation the owner's browser keeps. Every
// model is told what the agent remembers about its owner; a model that calls
// tools can also remember, recall and forget. A Space is asked the owner's
// last message, as its API takes it.

export const TOOL_NAMES = ['remember', 'recall', 'forget', 'currentTime'] as const

export const ChatMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
})
export const ChatRequest = z.object({
  model: z.string().max(200).optional(),
  messages: z.array(ChatMessage).min(1).max(40),
})

export type AgentReply = { text: string; model: string; tools: string[] }

const PROMPT_MEMORIES = 30

export function systemPrompt(memories: Memory[], today: string, tools: boolean): string {
  const known = memories.length
    ? memories.map((m) => `- [${m.id}] (${m.space}) ${m.text}`).join('\n')
    : '- (nothing yet)'
  const spaces = [...new Set(memories.map((m) => m.space))]
  return [
    `You are ${API_NAME}, a personal AI agent working for one person: your owner. Be direct, warm and concise.`,
    `Today is ${today}.`,
    'What you remember about your owner (most recent first; the space each fact is filed under is in parentheses):',
    known,
    tools
      ? "When your owner tells you something worth keeping — a preference, a fact about them, a plan — call `remember` with one short sentence and the space it belongs in: a short topic such as Work, Health or Travel. Reuse an existing space when one fits" +
        (spaces.length ? ` (${spaces.join(', ')})` : '') +
        ". Use `recall` to look something up, and `forget` (with the number in brackets) when they ask you to. Never claim to have remembered something unless `remember` succeeded."
      : 'You cannot save new memories in this conversation; if asked to, say the owner should switch to a model that uses tools.',
    'Never invent facts about your owner.',
  ].join('\n')
}

export async function runAgent(opts: { env: Env; entry: ModelEntry; messages: ModelMessage[]; memory: MemoryStore }): Promise<AgentReply> {
  const { env, entry, messages, memory } = opts

  if (entry.provider === 'space') {
    const last = [...messages].reverse().find((m) => m.role === 'user')
    const text = await callSpace(env, entry.id, entry.apiName ?? 'chat', typeof last?.content === 'string' ? last.content : '')
    return { text, model: entry.key, tools: [] }
  }

  const memories = await memory.listMemories(PROMPT_MEMORIES)
  const today = new Date().toISOString().slice(0, 10)
  const model = languageModel(env, entry)
  const tools = {
    remember: tool({
      description: 'Save one short fact about the owner for future conversations.',
      inputSchema: z.object({
        fact: z.string().min(1).max(500).describe('One sentence, in the third person: "Prefers tea to coffee."'),
        space: z.string().max(MAX_SPACE_CHARS).optional().describe('The topic it belongs in, e.g. "Food". Reuse an existing space when one fits.'),
      }),
      execute: async ({ fact, space }) => memory.remember(fact, space),
    }),
    recall: tool({
      description: 'Search what you remember about the owner, by words in a fact or the name of its space.',
      inputSchema: z.object({ query: z.string().max(200).describe('Words to look for; empty lists the most recent.') }),
      execute: async ({ query }) => ({ memories: await memory.recall(query) }),
    }),
    forget: tool({
      description: 'Delete a memory by its number.',
      inputSchema: z.object({ id: z.number().int().positive() }),
      execute: async ({ id }) => ({ forgotten: await memory.forget(id) }),
    }),
    currentTime: tool({
      description: 'The current date and time in UTC.',
      inputSchema: z.object({}),
      execute: async () => ({ now: new Date().toISOString() }),
    }),
  }

  const ask = (withTools: boolean) =>
    generateText({
      model,
      system: systemPrompt(memories, today, withTools),
      messages,
      ...(withTools ? { tools, stopWhen: stepCountIs(6) } : {}),
    })

  let result
  try {
    result = await ask(entry.tools)
  } catch (error) {
    // A Hugging Face provider that does not take tools refuses the request
    // outright (a 400 or 422 before any output). Ask once more without them, rather
    // than make the owner know which provider supports what.
    if (!(entry.tools && entry.provider === 'huggingface' && APICallError.isInstance(error) && (error.statusCode === 400 || error.statusCode === 422))) {
      throw error
    }
    result = await ask(false)
  }
  const used = result.steps.flatMap((s) => s.toolCalls.map((c) => c.toolName))
  return { text: result.text, model: entry.key, tools: [...new Set(used)] }
}

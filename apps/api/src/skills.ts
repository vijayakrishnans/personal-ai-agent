// SKILLS: named instructions for a kind of task, loaded only when a request
// calls for one. The system prompt lists each skill's name and when to use
// it; the model calls `useSkill` and follows what it gets back. So the agent
// can know how to do many things well without carrying all of them in every
// prompt.
//
// A few come built in. The owner writes their own in the page (☰ → Skills),
// kept in MEMORY; one with a built-in's name replaces it. Skills are the
// owner's words, so they are instructions — unlike anything read on the web.

export type Skill = { name: string; description: string; instructions: string }

export const SKILL_NAME = /^[a-z0-9][a-z0-9-]{1,39}$/
export const MAX_SKILL_DESCRIPTION = 200
export const MAX_SKILL_INSTRUCTIONS = 8000
export const MAX_SKILLS = 50

export const BUILT_IN_SKILLS: Skill[] = [
  {
    name: 'research-brief',
    description: 'Answer a research question properly, from papers and sources, with citations.',
    instructions: `1. If the question is broad, say in one line how you will narrow it, then go on.
2. Search papers: \`papers\` sorted by relevance, then by citations for the classics. Use \`fromYear\` when recency matters.
3. Add context from \`wikipedia\` and, if you have it, \`webSearch\`.
4. Open the two to four papers that matter with \`paper\` (abstract, venue, who cites them).
5. Write: a direct answer first; then what the evidence says, each claim with its source (title, year, link); then where sources disagree; then what is still open.
6. Cite only works a tool returned. If you rely on general knowledge, say so. Never invent a reference.`,
  },
  {
    name: 'paper-summary',
    description: 'Summarise one paper from a title, DOI or link.',
    instructions: `1. Find it: \`paper\` with the DOI or OpenAlex id, or \`papers\` with the title and pick the exact match. If it isn't found, say so and stop.
2. If it has an open-access link, \`readPage\` it for more than the abstract.
3. Summarise under: The problem · What they did · What they found · Limits · Why it matters. Plain words, about 200 words.
4. End with the full reference and its link, and how often it has been cited.`,
  },
  {
    name: 'literature-review',
    description: 'Map what is known on a topic: the key papers, the themes, and the gaps.',
    instructions: `1. Run \`papers\` three ways: by relevance, by citations (the foundations) and by newest (the current work).
2. Group what you found into three to five themes.
3. Give a table: Paper (year) · Theme · Key finding · Citations.
4. Write a short review: how the field developed, where it agrees, where it doesn't.
5. Name the gaps: questions few or no papers address.
6. Every paper you mention must come from a tool result, with its link.`,
  },
  {
    name: 'citation-check',
    description: 'Check whether references exist and say what they claim — before trusting or citing them.',
    instructions: `For each reference given:
1. If it has a DOI, check it with \`paper\`. If not, search its title with \`papers\` and look for the same title, authors and year.
2. Mark it VERIFIED (found, details match), MISMATCH (found, but year, authors or venue differ: say which) or NOT FOUND.
3. Give a table: Reference · Status · Correct details and link.
4. Never "fix" a reference into one you did not find. Not found means not found.`,
  },
  {
    name: 'daily-briefing',
    description: 'A short morning briefing: weather, headlines, and what is on the to-do list.',
    instructions: `1. \`weather\` for the owner's city (from what you remember; ask if you don't know it), today and tomorrow.
2. \`news\` top stories for the owner's country: the five that matter, one line each, with links.
3. \`listNotes\`: the open to-dos, oldest first.
4. Keep it under 200 words, as: Weather · Headlines · To do. No preamble.`,
  },
  {
    name: 'trip-planner',
    description: 'Plan a trip: weather, places, costs in local currency, and a checklist.',
    instructions: `1. Ask for what is missing among: where, when, how long, budget. Then go on.
2. \`weather\` for the destination; \`wikipedia\` for the place and two or three sights; \`exchangeRate\` if the currency differs from the owner's.
3. Give a day-by-day plan, a rough budget worked out with \`calculate\`, and a packing and booking checklist.
4. Offer to save the checklist as notes. You cannot add notes in the same turn you read the web, so ask the owner to say "save it" and add them then.`,
  },
  {
    name: 'decision-helper',
    description: 'Compare options against what matters to the owner and recommend one.',
    instructions: `1. List the options and ask which criteria matter most if they are not clear; give each a weight out of 5.
2. Look up facts you need (prices, reviews, specs) rather than guessing, and cite them.
3. Score each option 1–5 per criterion in a table; compute weighted totals with \`calculate\`.
4. Recommend one, say why in two lines, and say what would change your answer.`,
  },
]

/** The skills on offer: built-ins, each replaced by the owner's of the same name, then the owner's own. */
export function skillsOnOffer(owner: Skill[]): (Skill & { source: 'built-in' | 'owner' | 'customised' })[] {
  const mine = new Map(owner.map((s) => [s.name, s]))
  const builtIns = BUILT_IN_SKILLS.map((b) => (mine.has(b.name) ? { ...(mine.get(b.name) as Skill), source: 'customised' as const } : { ...b, source: 'built-in' as const }))
  const builtInNames = new Set(BUILT_IN_SKILLS.map((b) => b.name))
  return [...builtIns, ...owner.filter((s) => !builtInNames.has(s.name)).map((s) => ({ ...s, source: 'owner' as const }))]
}

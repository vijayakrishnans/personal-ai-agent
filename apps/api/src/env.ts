import type { AgentMemory } from './memory'

// What the Worker is given. `AI` is the account's Workers AI and `MEMORY` the
// agent's own Durable Object (wrangler.jsonc); ENVIRONMENT is the `vars` of
// the environment the deploy targeted. Every other key is a Worker SECRET the
// owner stores after the build (README → "Unlock the agent", "Add Hugging
// Face models"); none is required for the Worker to deploy and answer
// /health, and the agent says what is missing instead of failing.
export type Env = {
  AI: Ai
  MEMORY: DurableObjectNamespace<AgentMemory>
  ENVIRONMENT?: string
  // The owner's key. Every /api route needs it as a bearer token; until it is
  // stored they all answer 503, so a fresh deployment spends nothing on
  // anyone's behalf.
  AGENT_ACCESS_KEY?: string
  // Hugging Face: the owner's access token (a fine-grained token with "Make
  // calls to Inference Providers"), and the models to offer from the start —
  // comma-separated, `space:<owner>/<name>` for a Space. Models added in the
  // page are kept in MEMORY beside these.
  HF_TOKEN?: string
  HF_MODELS?: string
  // The hard kill switch: `on` (or true, 1, yes) and every /api route answers
  // 503 — even to the right key — until it is removed and the Worker
  // redeployed. For when the key itself can no longer be trusted; the page's
  // pause (kept in MEMORY) is the everyday switch.
  AGENT_KILL_SWITCH?: string
  // TEST ONLY — where Hugging Face is. Unset, the router is
  // https://router.huggingface.co/v1 and a Space `<owner>/<name>` is
  // https://<owner>-<name>.hf.space; the e2e points both at a local stand-in.
  HF_ROUTER_URL?: string
  HF_SPACES_URL?: string
}

/** The agent is unlocked once its owner has stored an access key. */
export const accessConfigured = (env: Env) => Boolean(env.AGENT_ACCESS_KEY)

/** The hard kill switch is on: AGENT_KILL_SWITCH is on, true, 1 or yes. */
export const killSwitchOn = (env: Env) => /^(on|true|1|yes)$/i.test(env.AGENT_KILL_SWITCH?.trim() ?? '')

/** Hugging Face is connected once a token is stored. */
export const huggingfaceConnected = (env: Env) => Boolean(env.HF_TOKEN)

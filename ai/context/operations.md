# personal-ai-agent — operating contract (for humans and agents)

This is the standing guide to how this personal AI agent is deployed and operated.
Instance facts (live URLs, workspace, the secrets it uses) live in
[deployment.md](deployment.md), rendered from probed reality by the
bootstrap's `02-docs` phase; this file is the contract that stays true
between deployments. It is written to give an agent with repository read
access enough context to reason about and operate the agent without any
other source.

## What this system is

A personal AI agent on Cloudflare alone, expressed as an Orun
component-native desired-state repo.

- **`apps/api`** — the agent: one Hono app, bundled by wrangler into one
  Cloudflare Worker (`cloudflare-worker-turbo`). `GET /` is its page (one
  self-contained document, `src/ui.ts`: the chat, a model picker, the models
  added in it and what it remembers). Every `/api` route is behind the
  owner's door FIRST (`src/auth.ts`): with no `AGENT_ACCESS_KEY` stored it
  answers `503 access_not_configured` and does nothing; a missing or wrong
  `Authorization: Bearer <key>` is a `401` (SHA-256 digests compared in
  constant time). Behind it: `POST /api/chat` (`{model?, messages}` →
  `{text, model, tools}`; an unknown model `400`, a Hugging Face model with
  no `HF_TOKEN` `409`, a provider failure `502` naming the model),
  `GET|POST /api/models` and `DELETE /api/models/<provider>/<owner>/<name>`
  (only models added in the page can be removed), `GET|POST /api/memories`,
  `PATCH /api/memories/<id>` (move to a space) and `DELETE /api/memories/<id>`. `GET /health` answers
  `{"status":"ok","name":…,"environment":…,"access":…,"huggingface":…,"models":…,"tools":[…],"endpoints":…}`
  — names and counts only, never a value; anything else is a 404.
- **The models** (`src/models.ts`) — three kinds, and `/api/chat` refuses
  any model not in the list: **Workers AI** through the Worker's `AI`
  binding, no key (`@cf/moonshotai/kimi-k2.6`, the default, and
  `@cf/meta/llama-3.3-70b-instruct-fp8-fast`); **Hugging Face Inference
  Providers** models — the models HuggingChat runs included — through the
  router's OpenAI-compatible API (`https://router.huggingface.co/v1`,
  `@ai-sdk/openai-compatible`) with the owner's `HF_TOKEN`, an id optionally
  suffixed `:fastest`, `:cheapest` or a provider's name; and **Gradio
  Spaces** (`src/spaces.ts`), called through Gradio 5's
  `/gradio_api/call/<endpoint>` and its event stream at
  `https://<owner>-<name>.hf.space` — derived from the id, never given, so
  the token only ever goes to Hugging Face. Hugging Face models come from the
  `HF_MODELS` secret (offered from the first deploy) and from the page (kept
  in the Durable Object).
- **The agent** (`src/agent.ts`) — the AI SDK's `generateText` (no
  streaming), up to 6 steps, with the tools `remember`, `recall`, `forget`
  and `currentTime` for a model marked as calling tools. Every model is told
  the 30 most recent memories in its system prompt. A Hugging Face provider
  that refuses tools (a `400` or `422`) is asked once more without them. A
  Space is sent the owner's last message and its first output is the answer.
- **The memory** (`src/memory.ts`) — one SQLite-backed Durable Object per
  environment (`AgentMemory`, binding `MEMORY`, named `owner`), created by
  the `v1` migration in `wrangler.jsonc` on the first deploy. It keeps the
  facts the agent was told to remember (the newest 500, 500 characters
  each) and the models added in the page (at most 50). The conversation is
  NOT kept: it lives in the owner's browser (localStorage), with the key.
- **`tests/api`** — vitest: every route driven in-process with
  `app.request()`, the real `AgentMemory` over Node's own SQLite, Workers
  AI's binding stood in for, and Hugging Face's router and a Gradio Space
  stood in for over HTTP. A pull request's lanes do not run it (its
  `quick-check` lane on `dev` installs and checks the package; the Worker's
  lanes build, type-check and dry-deploy it): run `pnpm typecheck`,
  `pnpm lint` and `pnpm test` before you push.
- **`tooling/*`** — shared TypeScript and ESLint configuration, and the
  deploy-time wrangler renderer for workers that take wiring.

Environments: **`stage`** and **`prod`** are deployed; **`dev` is
verify-only by design** — lanes build, type-check and dry-run the deploy,
nothing deploys.

## Identity and tenancy

Every remote operation runs against ONE Orun workspace, declared in
`intent.yaml` under `execution.state.workspace` — committed, enforced, and
what CI uses. Do not remove it; headless credentials depend on it. If it
reads `ws_SET_ME`, the bootstrap had no workspace to write: set the real one
before anything else.

## How deployment works

1. Merge (or push) to `main`.
2. CI (`.github/workflows/ci.yml`) runs `orun plan --changed` — only
   components whose files changed are planned — then runs each planned lane
   with `orun run --remote-state`, authenticated by GitHub OIDC (the
   exchange resolves this repository's linked workspace server-side).
3. Each deploy lane installs the workspace, checks the Worker's structure
   (`package.json` and the committed `wrangler.jsonc`), builds and
   typechecks it, runs `wrangler deploy --env <env>` — the Worker is
   `personal-ai-agent-api-<env>` — pushes the keys the environment has stored to
   the Worker as Worker secrets (`secrets-live`: `wrangler secret bulk`, names
   only in the log; a key nobody stored is skipped), and smoke-tests it:
   `/health` on its workers.dev URL must answer `"status":"ok"` for that
   environment, and `POST /api/chat` without a key must be refused (`503`
   before an access key is stored, `401` after).
4. `prod` deploys after `stage` has converged on the same commit
   (`environments.prod.promotion` in intent.yaml).
5. **The convergence run is the deployment.** A green run means every
   planned lane applied. Failed lanes are retried with
   `gh run rerun --failed`, which resumes the same execution.

Caveats that matter:

- A push that touches no component files plans zero lanes — that run is
  green and deployed nothing. Never treat "latest run green" as "agent
  converged"; probe `/health` instead.
- A key stored after a deploy reaches the Worker on the NEXT deploy: store
  it, then deploy by hand (below). A deploy pushes the keys that exist and
  deletes none; removing one from the Worker is `wrangler secret delete`.
- `/api/chat` answers once the model has finished — no streaming — so a
  long multi-step answer is as slow as its slowest step, and a Space call
  gives up after 90 seconds. A sleeping Space wakes on its first call.
- The Durable Object's `v1` migration is history: never edit it. A class
  change is a new migration tag after it.
- A change to `intent.yaml`'s `environments` maps to no component and
  redeploys nothing on its own. Land it with a change under `apps/api`.

## Secrets model

- **Brokered provider secrets**: `CLOUDFLARE_API_TOKEN` (Workers deploy
  scope) and `CLOUDFLARE_ACCOUNT_ID` — pointers minted per run from the
  workspace's Cloudflare connection. No long-lived values at rest; nothing
  to rotate by hand.
- Inspect by NAME only: `orun secrets list --org <ws> --project` and
  `--env stage|prod`. No tooling in this repository prints a secret value,
  and no document in `ai/context/` may contain one.
- **The agent's own keys**, stored per environment by its owner and pushed
  to the Worker as Worker secrets on each deploy (`apps/api/component.yaml`:
  `optionalSecretEnv` + `runtimeSecrets`). None is required to deploy:
  - `AGENT_ACCESS_KEY` — the owner's key; every `/api` route answers `503`
    until it is stored;
  - `HF_TOKEN` — a Hugging Face fine-grained token with "Make calls to
    Inference Providers" (and read access for private Spaces); Inference
    Providers models answer `409` without it, public Spaces do not need it;
  - `HF_MODELS` — the Hugging Face models and Spaces to offer from the start,
    comma-separated, a Space as `space:<owner>/<name>[#<endpoint>]`;
  - `TAVILY_API_KEY` — web search: with it the agent is offered
    `webSearch` (Tavily); without it, `news` (Google News RSS) and
    `readPage` still work, keyless;
  - `AGENT_KILL_SWITCH` — the hard kill switch: `on` (true, 1, yes) and every
    `/api` route answers `503` to everyone, the owner too, until it is set
    `off` and the Worker redeployed.
  Set one with `orun secrets set <KEY> --org <ws> --env <env>`, then deploy.
  For local work they go in `apps/api/.dev.vars` (git-ignored).

## Verifying the system

```bash
# the agent on each environment (also recorded, probed, in deployment.md):
# its state by name, and the owner's door refusing a request without the key
curl -s https://personal-ai-agent-api-stage.vijayakrishnan12994.workers.dev/health
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://personal-ai-agent-api-prod.vijayakrishnan12994.workers.dev/api/chat -d '{}'
# the Worker's logs (a model or Space failure is logged by key, never a token)
pnpm --filter @app/api exec wrangler tail personal-ai-agent-api-prod

# workspace readiness (integrations + repository link)
orun integrations list --org <ws> --json && orun cloud check --org <ws>
```

## Common operations

| task | how |
|---|---|
| unlock the agent | store `AGENT_ACCESS_KEY` for the environment, deploy it, open `<worker URL>/` and enter the key (README, "Unlock the agent") |
| add Hugging Face models | store `HF_TOKEN` and deploy, then add models in the page's settings (☰ → Models) — or list them in `HF_MODELS` and deploy (README, "Add Hugging Face models") |
| add a tool | `tool()` in `apps/api/src/agent.ts`, its name in `TOOL_NAMES`, a test in `tests/api`, merge |
| change the built-in models | `WORKERS_AI_MODELS` (and `DEFAULT_MODEL`) in `apps/api/src/models.ts` — a model that calls tools |
| change the memory schema | a new migration tag in `wrangler.jsonc` and `CREATE … IF NOT EXISTS` / `ALTER` in `AgentMemory`'s constructor; never edit `v1` |
| deploy a change | merge to `main`; watch the run; failed lanes → `gh run rerun --failed` |
| deploy by hand | Orunbase's Deploy button, or `gh workflow run ci.yml --ref main -f environment=<env> [-f component=<a,b>]` — the named components (blank: every one) run in that environment as a merge runs them; started off `main` it is refused |
| redeploy without a change | edit the last line of `apps/api/component.yaml` (`# orun: redeploy <reason> <stamp>`) and merge — it is a deploy trigger, nothing reads it |
| rename the agent | `API_NAME` in `apps/api/src/identity.ts` — what its page, its system prompt and `/health` answer with |
| serve a custom domain | attach it to the Worker in Cloudflare (README, "Custom domain"), then replace the placeholder `personal-ai-agent.example.com` in `intent.yaml`'s `BASE_DOMAIN` (every environment) with it; the workers.dev URL keeps answering for the smoke |
| add a key | `orun secrets set <KEY> --org <ws> --env <env>` and deploy; a new key name is also declared in the component's `optionalSecretEnv` and named in `runtimeSecrets` |
| remove a key from the Worker | `pnpm exec wrangler secret delete <KEY> --env <env>` from `apps/api` — a deploy never deletes one |
| stop the agent now | pause it in the page (☰ → Access → Pause the agent): chat answers `503` and no model is called, no redeploy; Resume undoes it. If the key may have leaked: store `AGENT_KILL_SWITCH` = `on` and deploy, then rotate the key, set the switch `off` and deploy |
| turn on web search | store `TAVILY_API_KEY` and deploy; `/health` answers `"webSearch":"connected"` (README, "The news and the web") |
| add a lookup source | a function in `apps/api/src/lookup.ts` (keyless, answers with a `url`, `{ error }` on failure), its `tool()` in `agent.ts` via `look(…, { fromTheWeb })`, its name in `TOOL_NAMES`, a stand-in route under `/lookup/<service>` in `tests/api/src/helpers.ts`, a test |
| see what the agent did | ☰ → Access → What it did, or `GET /api/activity`: every tool call and whether a guard blocked it (README, "What keeps it safe") |
| rotate the access key | store a new `AGENT_ACCESS_KEY` and deploy; every browser holding the old one is asked again |
| headless credentials | `ORUN_TOKEN` (workspace-scoped) + `GITHUB_TOKEN` |

The deployment record is the bootstrap's `02-docs` phase. Re-running it (the
Orun console's Retry on that phase) re-probes the URLs and re-renders
[deployment.md](deployment.md); it is idempotent.

## Evolution

Structural changes (a second Worker, a vector store for memory beyond its
word match, a queue for answers longer than a request allows) follow the
same contract that deployed the agent: add a component under `apps/`, `infra/` or
`packages/` with a `component.yaml`, land it as a pull request, and the
convergence run applies it. A Worker that reads an infra component's wiring
declares `dependsOn` on it, `mode: enforced` on `github-push-main`, so one
convergence applies the infra first.

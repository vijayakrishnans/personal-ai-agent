# personal-ai-agent

[![Built with Orunbase](https://img.shields.io/badge/built%20with-Orunbase-3b5bdb)](https://orunbase.com) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](LICENSE)

Your own **AI agent** on one **Cloudflare Worker**. It answers in its own
chat page with **Workers AI**, through the Worker's own `AI` binding (no AI
key), and with **your Hugging Face models**: any model that Hugging Face's
[Inference Providers](https://huggingface.co/docs/inference-providers) serve,
including the open models [HuggingChat](https://huggingface.co/chat) runs, and
your own or public **Gradio Spaces**. It remembers what you tell it. Facts
are kept in a SQLite-backed **Durable Object** and given to every later
conversation, through `remember`, `recall` and `forget` tools the model can
call. It is locked until you store an access key, so nobody else spends your
models. A [Hono](https://hono.dev) app and the [AI SDK](https://ai-sdk.dev)
run it. Every merge to `main` deploys it to stage, then prod.

## Live deployment

<!-- 02-docs:begin -->
This agent is **live**: open `https://personal-ai-agent-api-prod.vijayakrishnan12994.workers.dev/` and enter its access key.
Verified URLs, identity and the secrets it uses are
recorded in [ai/context/deployment.md](ai/context/deployment.md) (re-rendered
by the `02-docs` phase); how it deploys and how to operate it:
[ai/context/operations.md](ai/context/operations.md).
<!-- 02-docs:end -->

## Unlock the agent

The agent is born **locked**. It deploys, `/` serves its page and `/health`
answers, but every `/api` route answers `503` until it has an access key. To
unlock it:

1. Choose a long random key, e.g. `openssl rand -base64 32`.
2. Store it as this environment's secret and redeploy, so the deploy hands it
   to the Worker:

   ```bash
   orun secrets set AGENT_ACCESS_KEY --org <ws> --env prod
   ```

   Then use Orunbase's **Deploy** on the `api` component, or **Run workflow**
   on the CI workflow with environment `prod`. `/health` now reports access
   `configured`.
3. Open `https://personal-ai-agent-api-prod.vijayakrishnan12994.workers.dev/`
   and enter the key. The page keeps it in your browser and sends it as a
   bearer token. A wrong key is a `401`.

Stage is a separate environment with its own key, memory and models.

## Add Hugging Face models

Workers AI works with no extra setup. To use Hugging Face as well, create a
[fine-grained access token](https://huggingface.co/settings/tokens) with
**Make calls to Inference Providers**. Add **Read access to contents of all
repos** if you want to reach your private Spaces. Store it, then redeploy:

```bash
orun secrets set HF_TOKEN --org <ws> --env prod
```

If the workspace already has the Hugging Face integration connected, use the
same token.

Then add models in either of two ways:

- **In the page.** Open the settings (☰), go to **Models** and use **Add a
  Hugging Face model**:
  - **Inference Providers model**: a Hub id such as `openai/gpt-oss-120b`,
    `meta-llama/Llama-3.3-70B-Instruct` or `Qwen/Qwen3-Coder-480B-A35B-Instruct`.
    These are the models HuggingChat lists. Add `:fastest`, `:cheapest` or a
    provider's name (`:groq`, `:together`, …) to choose how the router picks a
    provider. Leave **Let it use the agent's tools** on for models that call
    tools. If a provider refuses tools, the agent asks again without them.
  - **Gradio Space**: `<owner>/<space>`, such as your own Space. The agent
    calls its `chat` endpoint (what `gr.ChatInterface` exposes), or the
    endpoint you name. It sends your last message and shows the endpoint's
    first output as the answer.

  Added models are kept in the agent's Durable Object. Remove them in the
  same panel.
- **As a secret**, so they are offered from the first deploy:

  ```bash
  orun secrets set HF_MODELS --org <ws> --env prod
  # e.g.  openai/gpt-oss-120b, Qwen/Qwen3-Coder-480B-A35B-Instruct:fastest, space:you/your-chat-space
  ```

  The value is a comma-separated list. Write a Space as `space:<owner>/<name>`,
  with `#<endpoint>` when its endpoint is not `chat`. An entry that does not
  parse is skipped.

Inference Providers calls are billed to your Hugging Face account (with a
free monthly allowance). A Space runs on whatever hardware its owner gave it,
and a sleeping Space wakes on the first call, which can take a while.

## What it remembers

| Tool | What it does |
|---|---|
| `remember` | saves one short fact about you, in a space such as Work or Health |
| `recall` | searches what it remembers, by words in a fact or its space |
| `forget` | deletes a fact by its number |
| `currentTime` | the date and time in UTC |

Every model, tools or not, is told the 30 most recent facts in its system
prompt. Only a model that calls tools can save new ones. Spaces see your
message alone. The store keeps the newest 500.

Every fact is filed under a **space**, a topic the agent picks when it
remembers (it reuses one that fits) and `General` when none is named. The
sidebar lists them by space and lets you delete one; its **‹ Collapse** at
the bottom folds it away. Settings (☰) → **Knowledge** draws them as a graph:
you in the centre, each space a hub, each fact around its hub. Click a fact to
move it to another space or remove it, click a space to rename it, or add a
fact yourself. **The conversation itself stays in your browser**
(localStorage), and the Worker stores nothing of what was said. **New chat**
clears it.

## Routes

| Route | Answers |
|---|---|
| `GET /` | the agent's page: chat, model picker, added models, memories |
| `POST /api/chat` | `{"model"?: key, "messages": [{role, content}…]}` → `{"text", "model", "tools"}`. Unknown model `400`; a Hugging Face model with no `HF_TOKEN` `409`; a provider failure `502`, naming the model |
| `GET /api/models`, `POST /api/models`, `DELETE /api/models/<provider>/<owner>/<name>` | the models it offers; add or remove a Hugging Face model or Space |
| `GET /api/memories`, `POST /api/memories` (`{text, space?}`), `PATCH /api/memories/<id>` (`{space}`), `DELETE /api/memories/<id>` | what it remembers, and the space each fact is in |
| `GET /health` | `{"status":"ok","name":…,"environment":…,"access":…,"huggingface":…,"models":…,"tools":[…],"endpoints":…}`. This is what the deploy's smoke and an operator's probe read. It shows names only, never a key |
| anything else | `404 Not Found` |

Every `/api` route needs `Authorization: Bearer <AGENT_ACCESS_KEY>`. Without
a key stored it answers `503`; with a missing or wrong key, `401`.

## What is here

| Surface | Where |
|---|---|
| The routes and the owner's door | `apps/api/src/index.ts`, `apps/api/src/auth.ts` |
| The page | `apps/api/src/ui.ts` |
| The agent: system prompt, tools, the no-tools retry | `apps/api/src/agent.ts` |
| The models: built in, `HF_MODELS`, the page's | `apps/api/src/models.ts` |
| Calling a Gradio Space | `apps/api/src/spaces.ts` |
| Memory and added models (the Durable Object) | `apps/api/src/memory.ts` |
| The agent's name (what its page, prompt and `/health` use) | `apps/api/src/identity.ts` |
| Worker config (name, Workers AI and Durable Object bindings, migration, per-environment vars) | `apps/api/wrangler.jsonc` |
| Deploy contract (and the secrets it pushes) | `apps/api/component.yaml` (`cloudflare-worker-turbo`) |
| Tests | `tests/api` (vitest: every route in-process, the Durable Object's SQL on SQLite, Hugging Face's router and a Space stood in for over HTTP) |

## Getting started

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build            # wrangler deploy --dry-run → apps/api/dist (the bundle, no upload)
```

To run it locally under workerd: Workers AI has no local mode, so `wrangler
dev` needs `wrangler login` for the `AI` binding. The Durable Object runs
locally. Put the keys in `apps/api/.dev.vars`, which is git-ignored:

```bash
printf 'AGENT_ACCESS_KEY=dev-key\nHF_TOKEN=hf_…\nHF_MODELS=openai/gpt-oss-120b\n' > apps/api/.dev.vars
pnpm --filter @app/api dev                 # http://localhost:8787 — enter dev-key
curl http://localhost:8787/health          # {"status":"ok",…,"environment":"local","access":"configured",…}
```

To add a tool, use the AI SDK's `tool()` in `apps/api/src/agent.ts` and add
its name to `TOOL_NAMES`. To add a built-in Workers AI model, add an entry to
`WORKERS_AI_MODELS` in `apps/api/src/models.ts`, and choose one that calls
tools.

## How it deploys

Merges to `main` converge through [Orun](https://github.com/sourceplane/orun).
`.github/workflows/ci.yml` plans the changed components and runs each lane
against the workspace in `intent.yaml`. The agent deploys to `stage`, then to
`prod` once stage has converged on the same commit; `dev` only verifies. The
Worker is `personal-ai-agent-api-<env>` on your account's workers.dev subdomain.
Its Durable Object class is created by the first deploy, from the migration
in `wrangler.jsonc`.

After each deploy, the keys the environment has stored (`AGENT_ACCESS_KEY`,
`HF_TOKEN`, `HF_MODELS`) are pushed to the Worker as Worker secrets. A key
nobody stored is skipped, by name. Every deploy is smoke-tested over HTTP:
`/health` must answer `"status":"ok"` for that environment, and `/api/chat`
must refuse a request without the key.

A pull request runs the same pipeline's verify lanes: the Worker is built,
type-checked and dry-deployed for each environment, and nothing is deployed.
These lanes do not lint or run the tests, so run `pnpm typecheck`,
`pnpm lint` and `pnpm test` before you push. A push to `main` builds,
deploys and smoke-tests.

The pipeline holds one credential, GitHub's own `GITHUB_TOKEN`. The
Cloudflare token and account id are brokered per run from the workspace's
Cloudflare connection. The agent's keys are the owner's Orun secrets and are
never in the repository or in GitHub.

**Deploy by hand.** Orunbase's **Deploy** button on a component, or **Run
workflow** on the CI workflow in GitHub's Actions tab (on `main`), runs
`ci.yml` for the environment and components you pick. Each one deploys
exactly as a merge would. Leave the component blank to redeploy every
component in that environment with nothing changed, for example after
storing or rotating a key. A component with nothing to run in that
environment (a test suite in `prod`) is left out with a notice.

**Removing a key.** A deploy pushes the keys that exist and deletes none. To
take one off the Worker, run
`pnpm exec wrangler secret delete <KEY> --env <env>` from `apps/api`.

## Limits worth knowing

- **One owner.** One access key and one memory per environment. Anyone with
  the key is the owner. Rotate the key by storing a new one and redeploying.
- **Answers arrive whole.** `/api/chat` answers once the model has finished,
  without streaming. A long multi-step answer takes as long as its slowest
  step. A Space call gives up after 90 seconds.
- **Spaces keep no history.** A Space is sent your last message. Its own
  `chat` endpoint decides what it remembers.
- **Gradio 5.** Spaces are called through `/gradio_api/call/<endpoint>`.
  Older Gradio versions are not supported.

## License

Apache-2.0 — see [LICENSE](LICENSE). This agent was created with
[Orunbase](https://orunbase.com); [NOTICE](NOTICE) carries that attribution,
and section 4(d) of the License asks that it stay with any copy or derivative
you distribute. Your own changes are yours to license as you choose, alongside
it. List what you build on [openproduct](https://openproduct.live).

## Custom domain

The agent answers on workers.dev from its first deploy. To serve it on your
own domain, add the domain to the Cloudflare account the agent deploys into
and attach it to the Worker: dashboard → Workers & Pages →
`personal-ai-agent-api-prod` → Settings → Domains & Routes → Add → Custom
domain. The workers.dev URL keeps answering, and the deploy's smoke keeps
reading it unless the environment sets `DEPLOYED_URL` in `intent.yaml`, which
the smoke reads instead:

```yaml
environments:
  prod:
    env:
      DEPLOYED_URL: https://personal-ai-agent.example.com
```

The repository names the domain in one place, `BASE_DOMAIN` in `intent.yaml`
(one line per environment). The agent was born with the reserved placeholder
`personal-ai-agent.example.com`, which the example above also uses. Replace it
with your domain in the same change that attaches it.

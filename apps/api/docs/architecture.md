# api — architecture

Built by the turbo pipeline from `apps/api` and deployed with wrangler.

|                     |                           |
| ------------------- | ------------------------- |
| Worker config       | `apps/api/wrangler.jsonc` |
| Entry               | `src/index.ts`            |
| Compatibility date  | `2026-10-01`              |
| Compatibility flags | `nodejs_compat`           |

## Bindings

| Binding  | Kind           | Source                                  |
| -------- | -------------- | --------------------------------------- |
| `AI`     | Workers AI     | account-level; no resource to provision |
| `MEMORY` | Durable Object | class `AgentMemory`                     |

## Variables

`ENVIRONMENT` — overridden per environment (`dev`, `prod`, `stage`).

## Secrets resolved by the lane (names only)

- `AGENT_ACCESS_KEY` (optional)
- `HF_MODELS` (optional)
- `HF_TOKEN` (optional)

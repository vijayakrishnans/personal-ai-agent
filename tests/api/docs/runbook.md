# api-tests — runbook

## How it runs

Its lane runs on every pull request that changes it; it has no deployed surface.
CI plans what changed (`orun plan --changed`) and runs each lane with `orun run`;
the plan orders a component after everything it depends on.

## Local commands

```bash
pnpm --filter @app/api-tests build
pnpm --filter @app/api-tests test
pnpm --filter @app/api-tests typecheck
pnpm --filter @app/api-tests lint
```

## Rollback

Revert the commit on `main`. The next convergence applies the previous desired
state; nothing was changed out of band, so there is nothing else to undo.

## Common failures

- **A dependent fails to build after a change here**: run `pnpm typecheck`
  across the workspace before merging.

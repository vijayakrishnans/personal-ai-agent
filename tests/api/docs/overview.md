# api-tests

The agent's vitest suite (the page, /health, the owner's door, its models and Spaces, its memory, chat on Workers AI and Hugging Face), driven in-process with app.request() against the real Durable Object's SQL on SQLite and Hugging Face stood in for over HTTP, run with pnpm test

The test suite for **api**. It deploys nothing: its lane installs, builds and runs the tests.

|              |                      |
| ------------ | -------------------- |
| Type         | `turbo-package`      |
| Source       | `tests/api`          |
| Package      | `@app/api-tests`     |
| Environments | `dev`: `quick-check` |

## Depends on

- (none)

## Depended on by

- (none)

# Workflow durability onboarding E2E evidence

Date: 2026-08-29

## Environment

- Checkout: `/Users/tonystark/Documents/projects/atomic-dbos-onboarding`
- Branch: `feat/workflow-durability-backend-onboarding`
- Isolated agent directory: `/tmp/atomic-dbos-onboarding-e2e`
- CLI: `node packages/coding-agent/dist/cli.js` after `npm run build --workspace=@bastani/atomic`
- tmux sessions: `atomic-dbos-e2e`, `atomic-dbos-e2e-fresh`, and `atomic-dbos-e2e-invalid`

The connection URL was read directly from `/tmp/atomic-neon-connection.url` into a tmux paste buffer. It was never printed. Pane captures were produced only after the onboarding input disappeared and were passed through URL-userinfo redaction before being written.

## Retained Neon resources

These resources were used non-destructively and were not deleted:

- Organization: `org-empty-morning-31793217` (`bastani-inc`)
- Project: `Atomic` (`frosty-sunset-89823593`)
- Region: `aws-us-west-2`
- Database: `atomic_workflow_durability`
- Branch: `br-odd-breeze-arbqcm1p` (`main`)
- Host: `ep-dawn-pine-art6lrrk.c-4.us-west-2.aws.neon.tech`

`neonctl projects list --org-id org-empty-morning-31793217 --output json` confirmed the retained project id, name, and region.

## Onboarding and persistence

The returning-user isolated-agent-dir launch displayed the exact question `What durable backend would you like to use for workflows?` and the embedded/external help text. The development CLI accepted the Neon URL after a real connection probe. An in-process JSON inspection of `/tmp/atomic-dbos-onboarding-e2e/settings.json` confirmed:

```json
{"fieldPresent":true,"protocol":"postgresql:","host":"ep-dawn-pine-art6lrrk.c-4.us-west-2.aws.neon.tech","database":"/atomic_workflow_durability"}
```

A separate isolated launch submitted an HTTPS URL. `invalid-selection-pane.txt` shows the URL remained in the active input, a PostgreSQL-scheme error rendered, and no settings file was created.

## Remote durable workflow and fresh-process proof

The isolated agent directory contained a tiny `durability-proof` workflow whose only execution node was `ctx.tool("durability-proof-write", ...)`. The first CLI process ran it to completion with run id `7d6301fa-d105-47b8-9d2f-8c4a2fb0aa00`.

After that process exited, a fresh CLI process using the same isolated agent directory ran:

```text
/workflow status 7d6301fa-d105-47b8-9d2f-8c4a2fb0aa00
```

`fresh-process-pane.txt` shows authoritative hydration of the completed run and the `durability-proof-write` tool node as `cached`. This proves the workflow checkpoint remained available across a fresh process through the selected Neon-backed DBOS catalog.

## Files

- `invalid-selection-pane.txt` — redacted actual TUI rejection with input still active
- `fresh-process-pane.txt` — redacted fresh-process DBOS hydration and cached durable tool node

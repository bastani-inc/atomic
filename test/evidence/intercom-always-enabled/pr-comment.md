## Mandatory Intercom verification

Implemented ordinary bundled `intercom` as a mandatory Atomic runtime tool while leaving every other tool restriction unchanged. Supplied loaders, overrides, defer modes, reload, and same-name SDK/project/CLI collisions preserve the trusted bundled definition. `contact_supervisor` remains subagent-only, and broker/heavy initialization remains lazy.

Validation:
- `npm run check`, the coding-agent package suite, CI-contracts, all 716 unit files, and all 40 integration files passed.
- Focused real-owner tests cover SDK/resource-loader/workflow construction, collisions, mutation, reload, prompt metadata, actual execution, and group assignment.
- Fresh CLI built from `669129bcd6d95900afc866eb38eb885a7e26b16c`, real credentialed tmux E2E, isolated `/tmp/iaef` agent dir with `intercom/config.json` containing `enabled:false`:
  - `--no-tools --no-extensions` → `MAIN_NO_TOOLS_OK default`
  - `--tools read --exclude-tools intercom,bash --no-extensions` → `MAIN_ALLOWLIST_OK default`
  - Workflow stage with `noTools:"all"`, `tools:["read"]`, and `excludedTools` containing `intercom` → `WORKFLOW_INTERCOM_OK workflow:768d8480-cd27-4a75-ab19-f32a24598af7`

Exact commands and genuine pane captures: `test/evidence/intercom-always-enabled/`.

## 1. Must-read paths

- `packages/coding-agent/package.json` — published CLI/package boundary, bin entry, build scripts, runtime deps.
- `packages/coding-agent/src/cli.ts` — process/bootstrap entrypoint.
- `packages/coding-agent/src/main.ts` — top-level orchestration for modes, config, sessions, resources.
- `packages/coding-agent/src/core/sdk.ts` — `createAgentSession()`; main host/runtime seam.
- `packages/coding-agent/src/core/extensions/types.ts` — public extension ABI to preserve or replace.
- `packages/coding-agent/src/core/extensions/loader.ts` — dynamic TS/JS loading via `jiti`; biggest Rust compatibility issue.
- `packages/coding-agent/src/core/session-manager.ts` — session JSONL + branching persistence contract.
- `packages/coding-agent/src/core/model-registry.ts` — provider/auth/model resolution surface.
- `packages/coding-agent/src/core/tools/` — built-in tool semantics (`read`, `bash`, `edit`, `write`, etc.).
- `packages/coding-agent/src/modes/interactive/` — TUI/runtime interaction layer.
- `packages/coding-agent/src/modes/print-mode.ts` — headless output mode.
- `packages/coding-agent/src/modes/rpc/` — machine-facing automation protocol; likely easiest Rust port boundary.
- `packages/coding-agent/docs/{extensions,sdk,rpc,tui,packages,models,session-format}.md` — canonical compatibility docs.
- `docs/ci.md` — explains bundled companion packages and release shape.
- `scripts/build-binaries.sh` — current binary distribution model.
- `packages/workflows/package.json` — raw-TS companion package contract.
- `packages/workflows/src/extension/workflow-module-loader.ts` — user workflow `.ts` loading.
- `packages/workflows/src/workflows/define-workflow.ts` — workflow DSL/type surface.
- `packages/subagents/src/extension/index.ts` — subagent extension entrypoint.
- `packages/subagents/src/runs/shared/pi-spawn.ts` — child-process orchestration decision point.
- `packages/mcp/index.ts` — MCP extension entrypoint and tool registration.
- `packages/mcp/server-manager.ts` — MCP transport/lifecycle handling.
- `packages/web-access/index.ts` — web/search/fetch tool registration.
- `packages/web-access/{extract.ts,github-extract.ts,video-extract.ts}` — external extraction dependencies.
- `packages/intercom/index.ts` — intercom extension entrypoint.
- `packages/intercom/broker/` — IPC/framing protocol, strong candidate for Rust replacement.
- `package.json`, `bunfig.toml`, `tsconfig.json`, `tsconfig.base.json`, `prek.toml` — repo-wide runtime/build constraints.
- `.github/workflows/{test.yml,publish.yml}` — CI/release contract that migration will change.

## 2. Supporting paths

- `packages/coding-agent/src/cli/args.ts` — CLI parity surface.
- `packages/coding-agent/src/config.ts` — `.atomic`/`.pi` config and env compatibility.
- `packages/coding-agent/src/core/agent-session.ts` — session state/runtime wrapper.
- `packages/coding-agent/src/core/resource-loader.ts` — package/resource discovery.
- `packages/coding-agent/src/core/package-manager.ts` — manifest/discovery compatibility.
- `packages/coding-agent/src/core/skills.ts`, `packages/coding-agent/src/core/prompt-templates.ts` — prompt/skill loading.
- `packages/coding-agent/src/core/compaction/` — context management behavior.
- `packages/coding-agent/src/core/export-html/` — export/share surface.
- `packages/coding-agent/src/core/tools/{edit.ts,write.ts,bash.ts}` — file mutation and process execution details.
- `packages/workflows/src/runs/` — workflow runtime lifecycle and persistence.
- `packages/workflows/src/tui/` — workflow UI overlay.
- `packages/workflows/builtin/` — built-in workflow semantics.
- `packages/subagents/src/agents/` — built-in agent definitions.
- `packages/subagents/src/runs/{foreground,background}/` — async execution model.
- `packages/subagents/src/runs/shared/worktree.ts` — git worktree isolation.
- `packages/mcp/{config.ts,README.md,OAUTH.md}` — configuration and auth expectations.
- `packages/web-access/{curator-server.ts,storage.ts,summary-review.ts}` — browsing/curation persistence.
- `test/unit`, `test/integration`, `packages/coding-agent/test/` — behavior coverage map.

## 3. Entry points / symbols

- `createAgentSession()` in `packages/coding-agent/src/core/sdk.ts`
- `main()` in `packages/coding-agent/src/main.ts`
- CLI bootstrap in `packages/coding-agent/src/cli.ts`
- `loadExtension()` / extension loader path in `packages/coding-agent/src/core/extensions/loader.ts`
- Extension ABI types in `packages/coding-agent/src/core/extensions/types.ts`
- Session persistence APIs in `packages/coding-agent/src/core/session-manager.ts`
- Workflow loader APIs in `packages/workflows/src/extension/workflow-module-loader.ts`
- Workflow DSL helpers in `packages/workflows/src/workflows/define-workflow.ts`
- MCP server lifecycle in `packages/mcp/server-manager.ts`
- Intercom broker protocol in `packages/intercom/broker/`
- Subagent process boundary in `packages/subagents/src/runs/shared/pi-spawn.ts`

## 4. Gaps or uncertainty

- No verified Rust codebase exists here: no `Cargo.toml`, no `*.rs` files.
- The main unresolved question is plugin strategy: keep executing TS/JS, replace with a new ABI, or shell out to JS services.
- External `pi-*` dependencies are not in-repo, so their exact replaceability from Rust is unverified.
- CI coverage for package-local tests (`packages/coding-agent/test/`) is uncertain.
- Some specs under `specs/` are design history and may not match current implementation exactly.
## 1. Executive orientation

This repository is currently a **Bun/TypeScript monorepo with no Rust implementation present**: a repo search found no `Cargo.toml` or `*.rs` files. The practical migration question is therefore not “translate TS to Rust file-by-file,” but **choose which compatibility contracts survive**:

- **Core CLI/runtime:** `packages/coding-agent` publishes `@bastani/atomic`; CLI bin is `atomic -> dist/cli.js` in `packages/coding-agent/package.json`.
- **Bundled raw-TS extensions:** `packages/workflows`, `packages/subagents`, `packages/mcp`, `packages/web-access`, and `packages/intercom` are private workspace packages copied into `@bastani/atomic` at build time (`docs/ci.md`, `packages/coding-agent/scripts/copy-builtin-packages.ts`).
- **Hardest Rust boundary:** dynamic TypeScript extension/workflow loading via `jiti` and the public extension API (`packages/coding-agent/src/core/extensions/loader.ts`, `packages/coding-agent/src/core/extensions/types.ts`).
- **External runtime dependencies:** core agent/model/TUI behavior comes from `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`, and `@earendil-works/pi-tui` (`packages/coding-agent/package.json`, `packages/coding-agent/src/core/sdk.ts`, `packages/coding-agent/src/main.ts`).
- **Existing design docs already frame a rewrite:** `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md`, `specs/2026-05-11-pi-workflows-extension.md`, and `research/docs/2026-05-11-atomic-codebase-inventory.md` are high-value, but some are historical/speculative and may not match the current tree exactly.

A Rust migration should be scouted as **subsystem replacement + compatibility strategy**, especially for:
1. CLI/process/config/session runtime.
2. TUI/event rendering.
3. AI provider streaming.
4. Tool execution and filesystem mutation.
5. Extension/workflow/subagent/MCP/web/intercom ecosystems.

## 2. Key paths and why they matter

| Path | Why it matters for TS → Rust migration |
|---|---|
| `package.json` | Root Bun workspace, scripts: `bun run typecheck`, `bun run test:unit`, `bun run test:integration`, `bun run test:all`. |
| `bunfig.toml` | Bun runtime/install behavior; current repo is Bun-first. |
| `tsconfig.json`, `tsconfig.base.json` | TS module/emit assumptions, `.js` import discipline, raw-TS package aliases. |
| `prek.toml` | Hook gates: `bun run lint`, `bun run test:unit`. |
| `.github/workflows/test.yml`, `.github/workflows/publish.yml` | CI/release shape; Rust migration would need new build/test/release lanes. |
| `docs/ci.md` | Explains single publishable package and bundled companion packages under `dist/builtin/`. |
| `scripts/build-binaries.sh` | Current binary distribution uses `bun build --compile` for six targets plus runtime `node_modules`. |
| `scripts/bump-version.ts` | Version sync across every `packages/*/package.json`. |
| `packages/coding-agent/package.json` | Published package, bin/main/types/exports, runtime dependencies, build scripts. |
| `packages/coding-agent/src/cli.ts` | Process entrypoint; sets `process.title`, env marker, HTTP dispatcher, then calls `main()`. |
| `packages/coding-agent/src/main.ts` | CLI orchestration: args, modes, config/package commands, sessions, resource loading, runtime creation. |
| `packages/coding-agent/src/cli/args.ts` | CLI argument model; Rust CLI parity starts here. |
| `packages/coding-agent/src/config.ts` | Rebrand/env/path core: `APP_NAME`, `.atomic`, `ATOMIC_*`, legacy `.pi` compatibility. |
| `packages/coding-agent/src/core/sdk.ts` | `createAgentSession()`; central SDK boundary around model/auth/session/tools/extensions. |
| `packages/coding-agent/src/core/agent-session.ts` | Main stateful runtime wrapper: sessions, events, compaction, tools, extensions, bash state. |
| `packages/coding-agent/src/core/session-manager.ts` | JSONL sessions/branching/labels; important persistence contract. |
| `packages/coding-agent/src/core/model-registry.ts` | Provider/model/auth registry; Rust port needs equivalent or bridge. |
| `packages/coding-agent/src/core/tools/` | Built-in tools: `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `ask_user_question`, `todo`. |
| `packages/coding-agent/src/core/extensions/types.ts` | Public extension ABI: tools, commands, events, UI, providers, message renderers. |
| `packages/coding-agent/src/core/extensions/loader.ts` | Dynamic TS/JS loader via `jiti/static`; most important compatibility problem. |
| `packages/coding-agent/src/core/resource-loader.ts` | Merges CLI/package/builtin/discovered resources. |
| `packages/coding-agent/src/core/package-manager.ts` | Package manifests, resource discovery, `pi`/app manifest compatibility. |
| `packages/coding-agent/src/modes/interactive/` | Interactive TUI mode and components. |
| `packages/coding-agent/src/modes/print-mode.ts` | Headless print/JSON mode. |
| `packages/coding-agent/src/modes/rpc/` | JSONL RPC protocol; likely easiest Rust-compatible automation surface. |
| `packages/coding-agent/docs/{extensions,sdk,rpc,tui,packages,models,session-format}.md` | Canonical contracts to preserve or intentionally break. |
| `packages/coding-agent/test/` | Core package Vitest tests; verify whether CI currently runs all of these. |
| `packages/workflows/package.json` | Private raw-TS package; `main: ./src/index.ts`, bundled into Atomic. |
| `packages/workflows/src/workflows/define-workflow.ts` | Workflow DSL and TypeBox type inference. |
| `packages/workflows/src/extension/workflow-module-loader.ts` | User workflow `.ts` loading via `jiti` virtual modules. |
| `packages/workflows/src/runs/` | Workflow execution, foreground/background, worktrees, validation. |
| `packages/workflows/src/tui/` | Workflow graph/widget/overlay UI. |
| `packages/workflows/builtin/` | Builtin workflows: `deep-research-codebase`, `goal`, `ralph`, `open-claude-design`. |
| `packages/subagents/src/extension/index.ts` | `subagent` tool extension entrypoint. |
| `packages/subagents/src/runs/shared/pi-spawn.ts` | Spawns child Atomic/Pi processes; Rust port must decide subprocess vs in-process. |
| `packages/subagents/src/runs/shared/worktree.ts` | Git worktree isolation. |
| `packages/mcp/index.ts` | MCP extension entrypoint, direct tools, proxy tool, lifecycle hooks. |
| `packages/mcp/server-manager.ts` | MCP transports: stdio, streamable HTTP, SSE, OAuth handling. |
| `packages/web-access/index.ts` | Registers web/search/fetch tools; config, curator, provider fallback. |
| `packages/web-access/extract.ts`, `github-extract.ts`, `video-extract.ts` | HTML/PDF/GitHub/video extraction dependencies and process calls. |
| `packages/intercom/index.ts` | Intercom extension and subagent-supervisor routing. |
| `packages/intercom/broker/` | Local IPC broker/client/framing; strong Rust candidate subsystem. |
| `test/unit`, `test/integration` | Root Bun tests, especially workflows/subagents/MCP integration coverage. |
| `specs/2026-05-11-atomic-pi-coding-agent-rewrite.md` | Historical/rewrite direction; useful for seams and non-goals. |
| `research/docs/2026-05-11-atomic-codebase-inventory.md` | Prior inventory of portable vs removable concepts. |

## 3. Suggested partitions

1. **Rust migration strategy / compatibility matrix** — decide full rewrite vs Rust host + embedded JS vs hybrid Rust services. Inputs: `specs/2026-05-11-*`, `docs/ci.md`, package manifests.
2. **Root build/test/release system** — `package.json`, `bunfig.toml`, `prek.toml`, `.github/workflows/*`, `scripts/build-binaries.sh`.
3. **CLI argument and mode parity** — `packages/coding-agent/src/cli.ts`, `src/main.ts`, `src/cli/args.ts`.
4. **Config/env/path compatibility** — `packages/coding-agent/src/config.ts`, `docs/settings.md`, `docs/development.md`.
5. **SDK/session creation boundary** — `packages/coding-agent/src/core/sdk.ts`, `agent-session-runtime.ts`, `agent-session-services.ts`.
6. **Session JSONL and branching persistence** — `session-manager.ts`, `docs/session-format.md`, session-related tests.
7. **Model/provider/auth registry** — `model-registry.ts`, `auth-storage.ts`, `model-resolver.ts`, `docs/models.md`, `docs/custom-provider.md`.
8. **Provider streaming hooks** — `core/sdk.ts` provider request/response hooks, `@earendil-works/pi-ai` usage.
9. **Built-in tool ABI** — `core/tools/index.ts` and individual tools under `core/tools/`.
10. **Filesystem mutation safety** — `edit.ts`, `write.ts`, `file-mutation-queue.ts`, path utils.
11. **Bash/process execution** — `bash-executor.ts`, `core/tools/bash.ts`, `core/exec.ts`, process tests.
12. **Extension public API** — `core/extensions/types.ts`, `docs/extensions.md`.
13. **Extension loading implementation** — `core/extensions/loader.ts`, `jiti` virtual modules, aliases.
14. **Resource/package discovery** — `core/resource-loader.ts`, `core/package-manager.ts`, `docs/packages.md`.
15. **Interactive TUI shell** — `modes/interactive/**`, `docs/tui.md`, themes/keybindings docs.
16. **Print/JSON/RPC headless modes** — `modes/print-mode.ts`, `modes/rpc/**`, `docs/rpc.md`.
17. **Skills/prompt templates/context files** — `core/skills.ts`, `core/prompt-templates.ts`, `docs/skills.md`, `docs/prompt-templates.md`.
18. **Compaction/tree/navigation** — `core/compaction/**`, `agent-session.ts`, relevant tests/docs.
19. **HTML export/share/version/update** — `core/export-html/**`, `utils/changelog.ts`, `utils/version-check.ts`.
20. **Builtin package bundling** — `scripts/copy-builtin-packages.ts`, `copy-runtime-dependencies.ts`, `docs/ci.md`.
21. **Workflow authoring DSL** — `packages/workflows/src/workflows/**`, `src/shared/types.ts`, unit tests.
22. **Workflow dynamic module loading** — `workflow-module-loader.ts`, `discovery.ts`, `config-loader.ts`.
23. **Workflow runtime foreground execution** — `runs/foreground/**`, `stage-runner.ts`, `executor.ts`.
24. **Workflow background/resume/cancel** — `runs/background/**`, status/cancellation/job tracker tests.
25. **Workflow graph/store/persistence** — `shared/store.ts`, persistence files, `status-writer.ts`.
26. **Workflow TUI overlay/widget** — `packages/workflows/src/tui/**`.
27. **Builtin workflows** — `packages/workflows/builtin/*.ts`; identify reusable orchestration semantics.
28. **Workflow integrations** — `packages/workflows/src/intercom/**`, `extension/mcp.ts`, lifecycle/HIL notifications.
29. **Subagent agent/chain discovery** — `packages/subagents/src/agents/**`, builtin agent markdown.
30. **Subagent foreground execution** — `runs/foreground/**`, `subagent-executor.ts`.
31. **Subagent background/async execution** — `runs/background/**`, result watcher, status, resume.
32. **Subagent process spawning/session isolation** — `runs/shared/pi-spawn.ts`, `fork-context.ts`, nested events.
33. **Subagent worktree/acceptance gates** — `worktree.ts`, `acceptance.ts`, completion guard.
34. **MCP config/import surface** — `packages/mcp/config.ts`, `README.md`, `OAUTH.md`.
35. **MCP server manager/transports** — `server-manager.ts`, OAuth files, lifecycle.
36. **MCP tool registration/proxy/direct tools** — `index.ts`, `direct-tools.ts`, `proxy-modes.ts`, `tool-registrar.ts`.
37. **MCP UI resources/sampling/security** — `ui-resource-handler.ts`, `ui-server.ts`, `sampling-handler.ts`, `consent-manager.ts`.
38. **Web search providers** — `web-access/{exa,perplexity,gemini-*}.ts`, `code-search.ts`.
39. **Web content extraction** — `extract.ts`, `github-extract.ts`, `pdf-extract.ts`, `video-extract.ts`, `youtube-extract.ts`.
40. **Web curator/storage/session persistence** — `curator-server.ts`, `curator-page.ts`, `storage.ts`, `summary-review.ts`.
41. **Intercom broker/client protocol** — `packages/intercom/broker/**`, `types.ts`.
42. **Intercom extension UI and supervisor flows** — `intercom/index.ts`, `ui/**`, `reply-tracker.ts`.
43. **Cross-platform/native dependency audit** — clipboard, Photon WASM, `ffmpeg`/`yt-dlp`, `gh`, browser cookies, Windows paths.
44. **Test coverage map** — root `test/unit`, `test/integration`, `packages/coding-agent/test`, package-specific test commands.
45. **Security/trust model audit** — arbitrary TS extensions/workflows, MCP subprocesses, web fetching, intercom IPC, tool permissions.

## 4. Known unknowns / risks

- **No Rust baseline exists.** There is no `Cargo.toml`; specialists must first define the Rust crate/workspace shape.
- **Dynamic TS compatibility is the central risk.** Extensions and workflows are trusted executable TS/JS loaded with `jiti`; a pure Rust host breaks this unless it embeds JS, shells out, or defines a new plugin ABI.
- **External `pi-*` libraries are load-bearing.** `@earendil-works/pi-agent-core`, `pi-ai`, and `pi-tui` are not in this repo; Rust migration requires replacing or binding their behavior.
- **Docs/specs conflict with current reality.** Some specs describe clean-slate or upstream-package models, while current repo bundles private companion packages. Treat specs as design history, not truth.
- **Raw TypeScript distribution is intentional.** Companion packages use `.ts` entrypoints and no build step; Rust migration may break workflow authoring and package ergonomics.
- **Test gate uncertainty.** Root CI appears to run root Bun unit/integration tests and build `packages/coding-agent`; confirm whether `packages/coding-agent/test` Vitest coverage is run in CI.
- **TUI parity may be expensive.** Extension UI supports custom components, overlays, widgets, headers/footers, themes, keybindings, and RPC-mode UI requests.
- **MCP/web dependencies are Node-heavy.** MCP SDK, browser-cookie access, `jiti`, `linkedom`, `turndown`, `unpdf`, `ffmpeg`, `yt-dlp`, and `gh` all need Rust equivalents or subprocess bridges.
- **Backwards compatibility surface is large:** `.atomic` and legacy `.pi` configs, session JSONL, package manifests, skills/prompts/themes, workflow files, subagent definitions.
- **Security model changes need explicit decisions.** Today trusted local TS code runs with full system permissions; a Rust port could preserve, restrict, or sandbox that model, but each choice affects users.
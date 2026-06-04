# Executive answer

Your repo is **not currently a Rust project**; it’s a Bun/TypeScript monorepo with one publishable CLI and several bundled TS companion packages. So the migration question is really:

**What should become Rust, what should stay as TS/plugin content, and what compatibility contracts must survive?**

Best-supported conclusion from the research:

- **Do not start with a file-by-file TS→Rust rewrite.**
- Start with a **subsystem migration plan**:
  1. CLI/runtime shell
  2. session/persistence
  3. tool execution (read/edit/write/bash)
  4. provider/auth/model layer
  5. plugin/extension boundary
  6. workflows/subagents/MCP/intercom as separate compatibility surfaces
  7. TUI/RPC last, unless you want a full UX rewrite

The biggest blocker is **dynamic TS/JS loading via `jiti`** for extensions and workflows. A Rust host can’t preserve current behavior without either:
- embedding JS/TS execution,
- introducing a new plugin ABI,
- or moving those extension ecosystems out of-process.

# Architecture / behavior findings

## 1) Current repo shape
Evidence shows the repo is a Bun workspace with:
- `packages/coding-agent` as the publishable CLI
- raw TS companion packages: `workflows`, `subagents`, `mcp`, `web-access`, `intercom`
- no Rust baseline (`Cargo.toml` / `*.rs`) present

## 2) Highest-value Rust migration seams
The research consistently points to these as the core seams:

- **CLI + mode dispatch**: `cli.ts`, `main.ts`, `cli/args.ts`
- **Session runtime**: `sdk.ts`, `agent-session.ts`, `session-manager.ts`
- **Model/provider/auth**: `model-registry.ts`, `auth-storage.ts`, `model-resolver.ts`
- **Tools**: built-in `read`, `bash`, `edit`, `write`
- **Extensions**: `core/extensions/types.ts`, `loader.ts`
- **Workflows**: `packages/workflows/src/**`
- **Subagents**: `packages/subagents/src/**`
- **MCP**: `packages/mcp/**`
- **Intercom**: `packages/intercom/broker/**`

## 3) Compatibility contracts you’ll likely need to preserve
From docs/tests/specs, these are not optional if you want parity:

- `.atomic` / legacy `.pi` config behavior
- session JSONL + branching format
- `--mode json` and RPC wire format
- skill/prompt/theme discovery
- extension tool/provider registration behavior
- workflow DSL + runtime semantics
- subagent worktree/acceptance/resume behavior
- MCP transport/auth/UI model
- intercom IPC framing and broker lifecycle

## 4) Hardest technical problem
The central incompatibility is:

- current extensions/workflows are **trusted local TS/JS**
- loaded dynamically with `jiti`
- and are deeply wired into runtime events, UI, providers, and tool registration

A Rust rewrite must choose one of:
- **keep JS as plugin language**
- **replace plugin system**
- **bridge to existing TS runtime via subprocess/RPC**

## 5) Likely migration order
Most feasible order:

1. **Rust CLI shell** for startup, flags, config, process management
2. **Rust session + persistence core**
3. **Rust tool execution core**
4. **Rust provider/auth/model core**
5. **Keep TS plugins temporarily via boundary/bridge**
6. **Port workflows/subagents/MCP/intercom selectively**
7. **Port TUI/RPC if needed**

# Evidence by partition

## Partition 1–3: repo shape, build, CI
- Root is Bun-first; CI/release assumes TS build/package flow.
- `docs/ci.md`, `scripts/build-binaries.sh`, `package.json`, `.github/workflows/*` define the current distribution model.
- Existing “rewrite” docs are **design history**, not current Rust plan.

## Partition 4–8: CLI, config, session/runtime
- `cli.ts`, `main.ts`, `cli/args.ts` define user-facing command parity.
- `config.ts` and `settings-manager.ts` define `.atomic`/`.pi` compatibility.
- `session-manager.ts` and `docs/session-format.md` define the persistence contract.
- These are among the best first Rust targets because they’re mostly deterministic and testable.

## Partition 9–10: model/auth/provider layer
- `model-registry.ts`, `auth-storage.ts`, `model-resolver.ts`, and `docs/models.md` are the provider contract.
- `sdk.ts` is the composition boundary.
- This layer depends on external `pi-ai` behavior, so Rust needs either reimplementation or a bridge.

## Partition 11–13: tools and process execution
- `read/write/edit` plus mutation queue are safety-critical.
- `bash.ts`, `bash-executor.ts`, child-process helpers, and Windows tests show cross-platform edge cases.
- Good Rust candidates, but they must preserve truncation, abort, path, and queue semantics.

## Partition 14–18: extensions, loader, TUI, RPC
- `extensions/types.ts` is the public ABI.
- `extensions/loader.ts` is the main Rust incompatibility.
- TUI and RPC are separate contracts; RPC is likely easier to preserve than full TUI parity.

## Partition 19–22: skills/resources/bundling
- Resource loading merges skills, prompts, themes, context files, packages, builtin resources.
- Bundling of companion packages into `dist/builtin/` is a current release-time mechanism, not a Rust assumption.
- This area matters if you want to preserve user content discovery.

## Partition 23–30: workflows
- `packages/workflows` is a full orchestration subsystem: DSL, dynamic loading, foreground/background execution, persistence, TUI overlay, builtins, intercom/MCP hooks.
- It’s a prime candidate for either:
  - a Rust-native orchestration engine, or
  - a plugin package kept in TS behind a stable boundary.
- Dynamic workflow loading is another `jiti`-style compatibility problem.

## Partition 31–35: subagents
- Subagents are similarly self-contained: agent discovery, foreground/background execution, spawn model, nested events, worktrees, acceptance gates.
- Much of this can be ported, but the child-process/session isolation model needs an explicit Rust design decision.

## Partition 36–39: MCP
- MCP has a large surface: config/import, transports, OAuth, proxy/direct tools, UI resources, consent, sampling.
- If Rust migration is “core host first,” MCP may be better kept as a separate adapter process initially.

## Partition 40–42: web access
- Web search/extraction depends heavily on external tools and provider-specific backends.
- This is more integration-heavy than algorithmic, so Rust gain is lower unless you want a native networking stack.

## Partition 43–44: intercom
- Broker/client/framing/path logic is relatively clean and looks like a strong Rust-native candidate.
- It’s more contained than workflows/MCP/TUI.

## Partition 45: native dependency audit
- Current runtime depends on clipboard addons, WASM image pipeline, `ffmpeg`, `yt-dlp`, `gh`, browser cookies, platform path behavior.
- Rust won’t remove these dependencies automatically; it only changes how you manage them.

## Partition 46–47: tests + trust model
- Root CI covers only part of the package suite; package-level tests are also important.
- Security/trust model is broad: arbitrary local TS, subprocess MCP, web fetching, IPC, tool permissions.
- Rust migration should explicitly decide whether to preserve or narrow this trust model.

## Partition 48–49: external package replacement + raw TS companions
- `pi-agent-core`, `pi-ai`, `pi-tui` are load-bearing external deps.
- Companion raw-TS packages are part of the current product model; Rust migration needs a replacement strategy for their authoring and distribution.

## Partition 50–51: historical rewrite docs
- Prior rewrite specs strongly favored a **clean-slate rebrand/rebuild** direction, but they are not Rust-specific.
- They also show that the repo already treats some systems as disposable/tunable, especially tmux-heavy orchestration.

# Risks and unknowns

- **No Rust target architecture exists yet** in-repo.
- **Plugin compatibility is the biggest unknown**: TS/JS extensions and workflows may not survive a pure Rust host.
- **External deps are load-bearing**: `pi-agent-core`, `pi-ai`, `pi-tui`.
- **Docs/specs are partially stale** versus current repo reality.
- **CI coverage is uneven** between root tests and package tests.
- **It is unclear whether you want**:
  - a full Rust rewrite,
  - a Rust CLI with TS plugins,
  - or only specific native subsystems.

# Recommended next steps

1. Decide the migration model:
   - **full Rust host**
   - **Rust core + TS plugin bridge**
   - **hybrid gradual migration**

2. Draw a compatibility matrix for:
   - CLI
   - session format
   - tools
   - provider/auth
   - extensions
   - workflows
   - subagents
   - MCP
   - intercom
   - TUI/RPC

3. Pick first Rust candidates:
   - session manager
   - config/path layer
   - intercom broker
   - file tools
   - bash runner

4. Decide the plugin story **before** porting core runtime.

5. Write a Rust workspace plan with explicit crates for each subsystem and a boundary for the TS remainder.
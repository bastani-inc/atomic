# Migrating the atomic TypeScript Monorepo to Rust

> Decision-grade research report. ~292k LOC TypeScript across `packages/*` (Bun workspace). Central published artifact: `@bastani/atomic` (the `coding-agent` package, a fork/extension of pi).
>
> **Methodology note.** Every crate-mapping and feasibility claim in the source dossier was passed through an adversarial verification step against crates.io, GitHub, and docs.rs (June 2026). Where a claim was **refuted** or **partly-true**, this report uses the corrected version and flags it inline as **[verified-correction]**. Unverified or self-reported figures are explicitly labeled.

---

## 1. Executive summary & overall verdict

**Verdict: A full big-bang rewrite to Rust is *not* advisable. An incremental strangler-fig migration of the leaf and orchestration packages is advisable and feasible-with-effort; migrating `coding-agent` itself is *hard-to-infeasible* on the current timeline and should be deferred or treated as a permanent hybrid.**

The atomic monorepo is not one migration problem — it is two. The outer ring (web-access, intercom, mcp, subagents, workflows, schema/validation, runtime/IO, build/test tooling) maps onto a mature Rust ecosystem with confirmed, well-maintained crates and is genuinely portable. The inner core (`coding-agent` + `atomic-sdk`) is bound to three mutually-reinforcing blockers that have **no clean Rust equivalent**:

1. **The pi SDK coupling** (`@earendil-works/pi-agent-core`, `pi-ai`, `pi-tui`) — ~161 imports, no official Rust port.
2. **Runtime TypeScript extension loading via `jiti`** — raw `.ts` skills/extensions loaded at runtime with no build step. There is no Rust crate that loads arbitrary `.ts` at runtime.
3. **The custom retained-mode TUI** (`pi-tui`). **[verified-correction]** — this is *not* React/Ink; it is a bespoke pi-tui component library. The blocker is real (immediate-mode ratatui vs. retained-mode pi-tui is a paradigm inversion), but it is a pi-tui replacement problem, not a React reconciler replacement problem.

**Dominant risk:** the `jiti` runtime-`.ts`-loading architectural pillar. Every other gap has a workaround; this one forces a community-breaking decision (recompile every skill to WASM, or embed a JS engine and keep a JS runtime dependency — which partly defeats the point of going native). **Until this is resolved at the repo level, no migration of `coding-agent` should begin.**

**Recommended strategy:** strangler-fig, leaf-first, with a `napi-rs` in-process FFI boundary so the existing Bun/TS host stays shippable at every step. Prove interop on **web-access** first, then **intercom + mcp**, then **subagents + workflows**. Treat the pi-coupled core as the last phase — and budget for the realistic possibility that the pragmatic endpoint is a *permanent hybrid* (Rust performance modules behind a TS host), not a full rewrite.

**Order-of-magnitude effort:** 18–36 person-months for Phases 0–2 (leaf + orchestration); 48–72 person-months for a full migration including the TUI and core. These assume 2–3 engineers with dedicated Rust ramp-up (2–4 months of reduced velocity per engineer is real and unavoidable).

---

## 2. Why pi-SDK coupling and runtime-TS extension loading are the make-or-break constraints

These two constraints are make-or-break because they are **not dependency swaps** — they are architectural pillars with no equivalent in a compiled-language ecosystem. Everything else in the codebase (HTTP, FS, process spawning, schema validation, diffing) has a confirmed, mature Rust crate. These two do not.

### 2.1 The pi SDK coupling (`difficulty: showstopper`)

`coding-agent` does not own its agent loop, model layer, or UI — it inherits them from three closed-source pi packages:

- `@earendil-works/pi-agent-core` — Agent, AgentSession, AgentTool, AgentEvent, lifecycle (create/run/branch/compact/export).
- `@earendil-works/pi-ai` — multi-provider LLM abstraction, model registry/resolver, OAuth.
- `@earendil-works/pi-tui` — the terminal UI component system.

There is **no official Rust pi SDK**. The closest reference, `pi_agent_rust` (Dicklesworthstone), *is* published to crates.io (v0.1.13, ~670 downloads) **[verified-correction — the dossier originally claimed it was unpublished]**, and it reimplements a surprisingly broad surface (a six-event EventBus equivalent, capability-gated hostcall dispatcher, Provider trait for model control, a 223-extension conformance corpus). **But it is a CLI-binary rewrite, not a consumable library** — all internal modules are `#[doc(hidden)]`, the only stable surface is a thin `sdk` module, and custom TUI rendering from extensions is an explicit non-goal. atomic cannot `cargo add` it as a drop-in replacement for its 161 pi imports.

Consequence: porting `coding-agent` means *either* keeping pi at the boundary in TypeScript forever (via napi-rs), *or* reimplementing the agent core, model registry, and TUI from scratch in Rust. The available building blocks (`rig-core`, `genai`, `ratatui`/`iocraft`, `keyring`) cover provider abstraction and rendering primitives but not session branching/compaction-as-a-library, dynamic model discovery in a unified way, or the ExtensionAPI facade.

### 2.2 Runtime TypeScript extension loading via `jiti` (`difficulty: high`, and the dominant risk)

`jiti` loads raw `.ts` skill and extension files at runtime with **no build step**. This is the architectural feature that makes atomic's extension ecosystem what it is: a user drops a `my-skill.ts` file and it just works. A compiled Rust binary fundamentally cannot do this. The three options, all of which break the current contract:

| Option | Mechanism | Cost |
|---|---|---|
| **Embed QuickJS** (`rquickjs` + `swc_ecma_parser`/`swc_ecma_transforms_typescript`) | Strip TS types in-process, run JS in an embedded engine | Preserves drop-a-`.ts` UX; ~210 KiB binary cost; single-threaded engine; must hand-bridge every virtual-module API surface as host functions. **[verified-correction: the relevant crates are the individual `swc_ecma_*` crates, not the `swc_core` umbrella]** |
| **Embed V8** (`deno_core` + `deno_ast`) | Full JS/TS runtime | ~11.7 MiB just for V8 (final binary 38–54 MB); Svix measured ~10x worse single-invocation latency than QuickJS; wrong fit for a CLI |
| **WASM plugins** (`extism`/`wasmtime`) | Compile skills to WASM | Best sandboxing/polyglot; **breaks the zero-build-step UX** — a dropped `.ts` file produces nothing; no event loop / no `child_process` inside the sandbox; community-breaking for existing skills |

The verified reference implementation (`pi_agent_rust`) chose the **rquickjs path** and reports sub-100ms cold load and sub-1ms warm load. **[verified-corrections on those numbers:]** (a) cold load is actually ~100–115ms P95 per the repo's own benchmark artifact, not strictly sub-100ms; (b) "warm-isolate reuse" is a *pre-transpiled source cache*, not live QuickJS-context pooling — the warm sub-1ms figure is real but reflects cache reuse; (c) `pi_agent_rust` documents shims for fs/path/os/crypto/child_process/url — *not* `http` or `Buffer` as the dossier claimed; (d) it does *not* require an external SWC/esbuild preprocessor — it runs `.ts` directly via an internal type-strip step.

**Why this is the dominant risk:** it is the only constraint that forces a decision affecting *every downstream consumer* (skill authors). It also transitively gates the schema system (extension tool schemas are evaluated at load time), the MCP adapter's dynamically-registered tools, and the TUI (skills render UI). A migration plan that does not resolve this up front will stall the moment the first skill fails to load.

---

## 3. Recommended migration strategy

### 3.1 Big-bang vs. strangler-fig

**Strangler-fig, decisively.** A 292k-LOC big-bang rewrite across a tri-blocker core, with a team ramping on Rust, is the canonical recipe for an 18-month death march that ships nothing. The strangler-fig works here precisely *because* the coupling is concentrated in one package: you route around it, migrate the leaves that pay off fastest, and keep `@bastani/atomic` shippable as a Bun binary the entire time.

Lesson from the industry ports below: **never replicate TypeScript's type checker in Rust, and never start at the coupled core.**

### 3.2 Interop boundary: napi-rs vs. neon vs. wasm vs. IPC

| Mechanism | When to use | Verified status |
|---|---|---|
| **napi-rs v3** | Primary in-process FFI for Node/Bun host. `#[napi]` auto-generates `.d.ts`; async fn → JS Promise; ThreadsafeFunction for Rust→JS. | Mature, v3.9.0 (May 2026), 36M downloads. Used by SWC, Biome, Rspack, Rolldown. **[verified-correction: WASM support shipped in the v2 era (2023), not "first-class new in v3"; it is "early stage," `wasm32-wasip1-threads` only — do not market it as seamless browser+Node parity]** |
| **wasm-bindgen** | CPU-bound logic that must run in *both* browser and Node | Mature, but exact CLI/lib version pinning trap; no Tokio in browser WASM. For pure-Node targets, prefer napi-rs. |
| **JSON-RPC over stdio** (`jsonrpsee`) | Clean *out-of-process* service boundaries (the Delta Chat pattern) | **[verified-correction: `jsonrpsee` ships HTTP + WebSocket transports only — there is no built-in stdio transport. The Delta Chat pattern uses a custom stdio RPC server. For stdio JSON-RPC, implement a custom transport via the `TransportSenderT`/`TransportReceiverT` traits, or use the LSP-style `tower-lsp`/`jsonrpc-stdio-server` path.]** Also note `v0.24.11` does not exist; current is v0.26.0. |
| **Neon** | — | Viable but clearly dominated by napi-rs (auto-TS-gen, N-API ABI stability). |

**Decision:** use **napi-rs in-process** for hot-path/low-latency modules (it is what Encore/SWC/Biome use), and reserve a *custom* stdio JSON-RPC boundary only for genuinely isolable services. Generate TypeScript types from Rust with **ts-rs** (`#[derive(TS)]`) so the existing `tsc` validates the contract end-to-end. **[verified-correction: ts-rs is ~5.1M cumulative downloads, not 8.7M; v12.0.1, MSRV 1.88 — all other claims accurate.]**

> A useful simplification surfaced in verification: `@silvia-odwyer/photon-node` is itself a napi/wasm wrapper around the Rust `photon-rs` crate — so the image-processing path in web-access is *already calling Rust under the hood*. Porting it is a direct upgrade, not a rewrite.

### 3.3 Lessons from real TS→Rust ports

- **codex-rs (OpenAI Codex CLI):** validated that a TS+Ink CLI can become native Rust. **[verified-correction: codex-rs uses `ratatui` and `keyring` but built its *own* LLM client layer — it does NOT use `rig-core` or `genai`. It therefore does not validate the rig+genai stack.]** Its architectural lessons stand: separate user-facing surfaces from a reusable `core` library crate; use an async submit/event model (tokio channels + `select!`).
- **Deno / SWC:** split transpilation (Rust) from type-checking (keep `tsc`). Do not rebuild the type checker.
- **Biome:** adopt existing API conventions to minimize ecosystem switching cost.
- **Delta Chat:** proven Rust-subprocess-over-stdio + auto-generated TS bindings — the reference for the out-of-process option.
- **`pi_agent_rust` / Claurst:** demonstrate that a Rust agent TUI is *generally* feasible. **[verified-correction: Claurst uses ratatui/rusqlite/tokio but NOT rig-core/genai/extism; it does not validate the specific Option-A stack. `rust-code` (fortunto2) has only ~168 downloads and is not a credible reference — cite only with heavy caveats.]**

---

## 4. Dependency → Rust crate mapping (by domain)

Maturity legend: **mature** (battle-tested, huge adoption) · **active** (maintained, healthy) · **early** (pre-1.0 / low adoption) · **none** (no equivalent). Rows marked **[corrected]** had a factual error in the dossier fixed during verification.

### 4.1 pi SDK coupling (showstopper)

| TS dependency | Rust crate | Maturity | Coverage / gap |
|---|---|---|---|
| `pi-agent-core` (Agent loop, sessions) | `rig-core` | active | **[corrected]** v0.38.1, ~247k DL/mo (not 340k). DOES ship session compaction (Compactor trait, added v0.37.0) and lifecycle hooks (PromptHook trait) — dossier wrongly listed these as gaps. Real gaps: no ThinkingLevel abstraction, no extension loading, no persistent ConversationMemory backend (in-memory only). |
| `pi-agent-core` (ReAct loop, state machine) | `autoagents` | active (pre-1.0) | Confirmed: ReAct executor, tool calling, sliding-window memory, WASM-sandboxed tools. ~122x lower adoption than rig. No session lifecycle / OAuth. |
| `pi-ai` (multi-provider LLM) | `genai` | active | **[corrected]** v0.6.4 (not 0.6.5). DOES support dynamic model discovery (`all_model_names()`, v0.6.0), a thinking-level abstraction (`ReasoningEffort` enum), and embeddings (`embed` module) — three "gaps" the dossier wrongly asserted. Real gap: no built-in OAuth/token-refresh (API-key/custom resolver only). |
| `pi-ai` (OpenAI-only component) | `async-openai` | mature | Confirmed OpenAI-only; use as a component, not a multi-provider replacement. |
| `pi-tui` (component system) | `ratatui` + `crossterm` | mature | v0.30.0; immediate-mode (no Component lifecycle/`invalidate()`) — full re-architecture required. **[corrected: ~3.76M DL/mo, not 4.3M.]** |
| `pi-tui` (React-like ergonomics) | `iocraft` | early | v0.8.3, ~9.2k DL/mo (not 11k), 14 dependents. **[corrected: iocraft is NOT built on ratatui — it uses crossterm + taffy directly; tuirealm and iocraft are not interchangeable.]** |
| `pi-ai/oauth` | `keyring` (+`oauth2`) | mature | Storage only; OAuth flow (Device Grant + PKCE) must be built. |
| `jiti` (user plugins) | `extism` | active | WASM plugins; **requires pre-compilation — breaks drop-a-`.ts` UX.** |
| `jiti` (native plugins) | `libloading` | mature | ABI-unstable across rustc versions — unsuitable for a public extension ecosystem. |

### 4.2 Runtime TS extension loading

| TS dependency | Rust crate | Maturity | Coverage / gap |
|---|---|---|---|
| `jiti` (raw `.ts` loader) | `rquickjs` + `swc_ecma_parser`/`swc_ecma_transforms_typescript` | active | **[corrected]** Closest functional equivalent (custom Loader/Resolver). The relevant crates are the individual `swc_ecma_*` crates, not `swc_core`. ~150–300 LOC of glue. ES2020 only. |
| `jiti` virtualModules map | rquickjs native module registration | active | Every virtual module (pi-agent-core, typebox, …) must be hand-bridged as ModuleDef/JsClass — no auto-gen from `.d.ts`. |
| node Node-API shims (fs/path/crypto/child_process) | `rquickjs-extra` + custom host ops | active | **[corrected]** `rquickjs-extra` only ships console/os/timers/url/sqlite. fs/path/crypto/buffer/stream/events live in **LLRT's own internals**, not in `rquickjs-extra`. `child_process`/`worker_threads` absent everywhere. Larger gap than dossier implied; LLRT itself is beta. |
| pi-* virtual modules | (none) | none | Must reimplement ExtensionAPI/EventBus/tool registry as Rust host functions. |
| MCP in plugins | `rmcp` | active | Bridge dynamically-registered JS tools to rmcp's typed handlers (no working reference exists). |
| extension discovery walk | `walkdir` / `globset` / `ignore` | mature | Full coverage — the easy part. |
| `proper-lockfile` | `fd-lock` / `fs4` | active | Advisory locks. **[corrected for fs4: methods renamed in 1.0 — use `lock()`/`try_lock()`, NOT `lock_exclusive()`/`try_lock_exclusive()`.]** |

### 4.3 TUI & rendering

| TS dependency | Rust crate | Maturity | Coverage / gap |
|---|---|---|---|
| `pi-tui` | `ratatui` 0.30 + `crossterm` 0.29 | mature | Immediate-mode; full presentation-layer rewrite. **[corrected metrics: ~3.76M DL/mo; 4,162 dependents.]** |
| `pi-tui` stateful components | `tuirealm` 4.1 | active | React+Elm on ratatui; closest stable match. **[corrected: ~8.5k DL/mo, 26 dependents.]** |
| `highlight.js` | `syntect` 5.3 | mature | **[corrected: syntect HAS native 24-bit ANSI terminal output — the "no direct terminal output" claim is false. `ansi-to-tui` is an optional layer for ratatui `Style` objects, not mandatory. ~710 dependents, not 1,443.]** |
| markdown pipeline | `tui-markdown` (experimental) + `ansi-to-tui` (stable) | early / mature | **[corrected: only tui-markdown is experimental; ansi-to-tui is v8.0.1, ratatui-org, stable.]** |
| `chalk` | `owo-colors` / `anstyle` | mature | Method-chaining, not template literals. |
| `@silvia-odwyer/photon-node` | `photon-rs` (or `image`/`fast_image_resize`) | active | Same upstream author; native = zero WASM boundary. **[corrected: photon-rs native build requires disabling default `enable_wasm` features — not strictly "zero-cost"; for pure resize prefer `fast_image_resize`.]** |
| `worker_threads` (image) | `tokio::spawn_blocking` + `rayon` | mature | Idiomatic; ownership replaces message-passing isolation. |
| image rendering | `ratatui-image` | active | **[corrected: v11 (not v8) as of June 2026.]** Kitty/Sixel/iTerm2/halfblock. |
| cell width | `unicode-width` + `ansi-width` | mature | Validate against pi-tui's `visibleWidth`. |

### 4.4 Schema & validation

| TS dependency | Rust crate | Maturity | Coverage / gap |
|---|---|---|---|
| `typebox` (hardcoded schemas) | `schemars` 1.2 | mature | **[corrected: `Type.Unsafe` DOES have a compile-time analog — `#[schemars(schema_with = "fn")]`; and `serde_json::Value` implements `JsonSchema` natively, so you don't "skip schemars entirely."]** |
| `typebox/compile` (validation) | `jsonschema` 0.46 | mature | Confirmed. Async `$ref` resolution is behind the `resolve-async` feature flag. |
| `zod` (config shape) | `serde` + `serde_json` | mature | **[corrected: field-name error messages yes, but structured JSON-path reporting needs `serde_path_to_error`.]** |
| `zod` (constraints) | `garde` 0.23 | active | Preferred over `validator`; synchronous only. |
| MCP passthrough (`Type.Unsafe`) | `serde_json::Value` + `jsonschema` | mature | Store raw, pre-compile validator, validate at call time. |
| MCP tool wiring | `rmcp` + `rmcp-macros` | active | **[corrected: rmcp does not "mandate" schemars — it's an optional dep behind the default `server` feature; and `validate_and_strip()` removes top-level `title`/`description` before the schema reaches the LLM (field-level descriptions survive).]** |

### 4.5 MCP integration

| TS dependency | Rust crate | Maturity | Coverage / gap |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | `rmcp` 1.7.0 | active | ~85% surface. **[corrected: no standalone SSE client (bundled in streamable-HTTP); no `UnauthorizedError` type (401 → `StreamableHttpError::AuthRequired`); release cadence ~1–2 wks, not 2–4; capabilities are a field on `peer_info()`, not "manual wiring."]** |
| `@modelcontextprotocol/ext-apps` (UiStream) | (none) | none | Confirmed zero Rust coverage; hand-port via `serde_json::Value` + `CustomNotification`. Largest single MCP gap. |
| `node:child_process` (stdio transport) | `rmcp` `transport-child-process` (`process-wrap`) | active | Full. |
| `open` (OAuth browser) | `webbrowser` | active | Full. |
| OAuth callback server | `axum` | mature | One-shot listener on random port. |
| config I/O / discovery | `dirs` + `serde_json` + `config` | mature | Per-app import paths (Cursor/Claude) must be hand-ported. |
| `which`/npx resolution | `which` 8.0.2 | mature | Already an optional rmcp dep; Windows `.cmd` shim logic still manual. |

### 4.6 Web/content extraction

| TS dependency | Rust crate | Maturity | Coverage / gap |
|---|---|---|---|
| `undici`/`fetch` | `reqwest` | mature | **[corrected: ~509M DL total (not 306M); disable HTTP/2 at runtime via `http1_only()`, not the `http2` Cargo feature; no AbortSignal — use `CancellationToken`.]** |
| `@mozilla/readability` | `dom_smoothie` | active | Not a line-for-line port; needs fallback tuning. **[corrected: 19 dependents (not 28); `readabilityrs` actually has *more* downloads, not "smaller ecosystem."]** |
| `turndown` | `htmd` | active | **[corrected: 60 dependents (not 91); benchmark page is Elon Musk Wikipedia not "Apple".]** |
| `linkedom` | `scraper` (+ `dom_query` for mutation) | mature | **[corrected: ~19.3M DL (not 13.5M); now v0.27.]** Limited mutation vs linkedom. |
| `unpdf` (pdfjs) | `pdf-extract` (fallback `lopdf`/`pdfium-render`) | mature | **[corrected: ~338k DL/mo (not 491.8k); metadata does NOT "map directly" — `print_metadata()` only debug-logs, structured Title/Author needs underlying `lopdf::Document`; 15+ open panic/crash issues on malformed PDFs; no OCR for scanned PDFs.]** |
| `p-limit` | `tokio::sync::Semaphore` | mature | `acquire_owned()`. |
| ffmpeg/yt-dlp/security/secret-tool | (spawn via `tokio::process`) | n/a | No Rust-native yt-dlp/ffmpeg; keep as subprocess shims. |

### 4.7 Runtime, IO & process orchestration

| TS dependency | Rust crate | Maturity | Coverage / gap |
|---|---|---|---|
| `node:child_process` + `cross-spawn` | `tokio::process` | mature | **[corrected: `process_group(0)` is a native method on `tokio::process::Command` since v1.40 (Unix-only) — no manual `CommandExt` needed.]** Windows `.cmd` shimming still manual. |
| `node:fs/promises` | `tokio::fs` | mature | **[corrected: io_uring is now available under `tokio_unstable` + `io-uring` (Linux), not purely "future"; stable API still uses `spawn_blocking` — batch with BufWriter.]** |
| `p-limit` | `tokio::sync::Semaphore` | mature | **[corrected: lower-level than p-limit (explicit acquire/release); `buffer_unordered` is the closest ergonomic match.]** |
| `proper-lockfile` | `fs4` 1.1 | active | **[corrected: API is `lock()`/`try_lock()` since 1.0, NOT `lock_exclusive()`.]** |
| `node:crypto` randomBytes | `rand`/`getrandom` (or `tempfile`) | mature | **[corrected: Windows backend is `BCryptGenRandom` (not CryptGenRandom); `OsRng` renamed `SysRng` in rand 0.10; `hex` crate unmaintained since 2021; `tempfile` uses `fastrand`, not OsRng.]** |
| `node:os` | `dirs` + `std::env` | mature | Full. |
| `worker_threads`/PID kill | `kill_tree` + `nix` | active | **[corrected: `kill_tree` no release since Feb 2024 — uncertain maintenance; prefer `nix::sys::signal::killpg` on Unix.]** |
| TTY detection | `std::io::IsTerminal` | mature | Full (`atty` deprecated). |
| glob/minimatch/ignore | `ignore` + `globset` + `walkdir` | mature | Full. |
| `process.env` mutation | (read-once Config struct) | n/a | **[corrected: `set_var` unsafe is *edition-gated to Rust 2024* (hard error); 2021 emits the `deprecated_safe_2024` lint; std signature is `pub unsafe fn` as of 1.96.]** |

### 4.8 Build / packaging / distribution

| TS dependency | Rust crate/tool | Maturity | Coverage / gap |
|---|---|---|---|
| `bun --compile` | `cargo build --release` + `cargo-dist` | mature | **[corrected: `-Z threads=8` parallel front-end is still nightly-only as of June 2026, not a stable "2025" feature; typical speedup ~23–30%, 50% is a ceiling.]** |
| cross-compile | `cargo-zigbuild` (fallback `cross`) | active | **[corrected: the OpenSSL "segfault" warning was not in zigbuild docs (confabulated); real gaps are missing headers / compiler_rt symbols / Darwin frameworks. `cross` is release-stalled (no crates.io release since Feb 2023, open Rust-2024 UB issue).]** |
| `npm publish --provenance` | optionalDependencies pattern + `cargo-dist` | active | **[corrected: `cargo-npm` is v0.1.2, 167 downloads, 2 stars — experimental, NOT production-ready; cargo-dist's own CI still uses classic `NPM_TOKEN`, OIDC needs manual wiring.]** |
| `shx` (cp/rm/mkdir) | `fs_extra` | mature-but-dormant | **[corrected: no `chmod` equivalent; 29 open issues incl. Windows data-loss; last release Feb 2023.]** |
| asset embedding | `rust-embed` / `include_bytes!` | mature | Confirmed v8.11.0, 35M DL. |
| version bump | `cargo-release` + `cargo-workspaces` | mature | README-badge replacement logic must be ported to a release hook. |

### 4.9 Testing & dev tooling

| TS dependency | Rust crate/tool | Maturity | Coverage / gap |
|---|---|---|---|
| `bun:test` | `cargo-nextest` + `rstest` | mature | **[corrected: nextest does NOT run doctests — run `cargo test --doc` separately; `rstest` has fixtures (≈beforeEach) but NO `afterEach` hook — teardown is via `Drop`.]** |
| `node:assert/strict` | `assert_eq!` + `pretty_assertions` | mature | **[corrected: NOT full parity — no equivalents for `throws`/`rejects`/`partialDeepStrictEqual`/regex `match`/`ifError`; `assert_ne!` shows no diff.]** |
| vitest module aliases | Cargo workspace path deps | mature | **[corrected: path deps go in each crate's `[dependencies]`, NOT in `[workspace.dependencies]` (Cargo forbids `path` there).]** |
| snapshots | `insta` + ratatui `TestBackend` | mature | **[corrected: ratatui+insta does NOT support color/ANSI snapshot assertions (open issue).]** |
| property testing | `proptest` | active (passive) | **[corrected: current v1.11.0 (not 1.9); ~133M DL.]** |
| CLI integration | `assert_cmd` + `predicates` + `assert_fs` | mature | **CRITICAL: binary crates need logic in `src/lib.rs` to be testable — likely a `coding-agent` entry-point refactor.** |
| env-var test mutation | `temp-env` + `serial_test` | active/mature | **[corrected: `temp-env` unmaintained since Sep 2023; `serial_test` healthy.]** |
| `tsc --noEmit` / eslint / prettier | `cargo check` / `clippy` / `rustfmt` | mature | Ship with rustup. |
| watch loop | `bacon` | active | **[corrected: `cargo-watch` is *archived* (Jan 2025), not merely "life-support"; `bacon` is AGPL-3.0 — license-check it; `watchexec` is the MIT alternative.]** |

---

## 5. Per-domain deep dives

### 5.1 pi SDK coupling — `hard`, 18–30 person-months (full Rust); 8–14 (hybrid sidecar)
**Approach.** Three options: (A) full Rust reimplementation on `rig-core` + `genai` + `ratatui`/`iocraft` + `keyring` + `rquickjs`; (B) hybrid — keep pi as a TS/Node sidecar behind a custom stdio JSON-RPC boundary while migrating everything else; (C) defer until an official Rust pi SDK exists. **Recommended: B for the 0–12 month horizon, A as a 12–36 month target.**
**Pitfalls.** No rig/genai/extism reference port validates the *combined* stack (codex-rs and Claurst each use only parts). Single-binary distribution is undermined by the hybrid's Node dependency.
**Open questions.** Is pi open-source/licensed for method-by-method porting? What fraction of the 161 imports are actually exercised vs. transitive? Is pi-tui used as a real component tree or as a thin terminal-I/O abstraction (shallow usage shrinks the TUI surface dramatically)?

### 5.2 Extension/skill loading — `hard`, 12–20 person-weeks (rquickjs path, excluding the rest of the port)
**Approach.** rquickjs + swc type-strip in a custom Loader; virtual modules as statically-registered native modules; ExtensionAPI facade as a Rust struct with an `Arc<Mutex<RegistrationQueue>>` preserving the two-phase (load → `bindCore` flush) semantics.
**Pitfalls.** QuickJS is single-threaded (concurrent extensions serialize → need multiple Runtimes, which can't share objects). EventBus must be Rust-side (tokio broadcast) bridged to JS callbacks. The `rquickjs-extra` shim gap (no fs/crypto/child_process there) is larger than first stated.
**Effort split.** Runtime itself 2–4 wks; ExtensionAPI bridge 4–8 wks; discovery/lifecycle 2–3 wks; integration against the existing extension zoo 2–4 wks.

### 5.3 TUI — `hard`, 18–30 person-months
**Approach.** ratatui + crossterm foundation; `tuirealm` for stateful components (NOT iocraft if staying in the ratatui ecosystem — they are not interchangeable); syntect + tui-markdown + ansi-to-tui for rendering; `ratatui-image` (v11) for images; external `App` state (immediate-mode), `tokio::select!` event loop.
**Pitfalls.** The retained→immediate paradigm inversion is a conceptual rewrite of all ~42 components, not a translation. Cache rendered `Text` per message and only re-render the viewport (upstream pi already hit this — commit `f0d30e2c`). syntect's Oniguruma backend breaks cross-compiles — use `fancy-regex`.

### 5.4 MCP — `hard`, 12–20 person-weeks (8–12 if ext-apps deferred)
**Approach.** rmcp as direct replacement; `TokioChildProcess` for stdio; streamable-HTTP client (SSE bundled inside it); axum OAuth callback; serde_json::Value + jsonschema for passthrough schemas.
**Pitfalls.** ext-apps/UiStream is the largest gap (zero Rust coverage). Legacy SSE-only servers need a shim/proxy. Token-refresh thundering-herd from the connection pool needs a single refresh lock. Schema draft mismatch (schemars emits 2020-12; many servers use draft-07).

### 5.5 Schema/validation — `feasible-with-effort`, 3–5 person-weeks
**Approach.** serde + schemars for owned types; jsonschema for runtime/MCP passthrough; garde for constraints. Mechanical but voluminous (58 files, 523 `Type.Optional`, 331 `Type.String`).
**Pitfalls.** `Static<T>` direction is reversed in Rust (type first, schema derived). schemars 0.8 vs 1.x API trap. Confirm the LLM API's expected JSON Schema draft.

### 5.6 Web/content extraction — `feasible-with-effort`, 3–6 wks core (6–10 with video/cookies)
**Approach.** reqwest + dom_smoothie + htmd + scraper + pdf-extract + Semaphore + CancellationToken threading. Phase: fetch+readability+html2md first, PDF next, video/cookie subsystems last (keep yt-dlp/ffmpeg as subprocess shims).
**Pitfalls.** dom_smoothie is not a drop-in for readability (needs fallback tuning). pdf-extract panics on malformed PDFs and has no OCR. Browser-cookie decryption (Keychain/secret-tool + AES) is the highest-risk subsystem.

### 5.7 Runtime/IO/process — `hard`, 20–36 person-weeks (excl. jiti)
**Approach.** tokio foundation; strict async-I/O vs. CPU (rayon-via-oneshot) separation; read env once at startup (Rust 2024 `set_var` unsafe).
**Pitfalls.** `tokio::fs` round-trips through `spawn_blocking` — BufWriter mandatory. Windows stdio-inheritance hang — use `wait_with_output()`. Never hold a `std::sync::MutexGuard` across `.await`. Async cancellation is drop-based — cleanup belongs in `Drop`, not async blocks.

### 5.8 Build/dist — `feasible-with-effort`, 8–16 person-weeks
**Approach.** cargo-dist + cargo-zigbuild; **optionalDependencies per-platform npm packages** (esbuild model) instead of cargo-dist's postinstall-download installer (the Axios March-2026 attack shows why postinstall download is a live vector); rust-embed for assets; min-size release profile.
**Pitfalls.** `cargo-npm` is experimental — budget for hand-rolled scaffolding. LTO + `codegen-units=1` triples build time (reserve for release CI). OIDC publishing requires GitHub-hosted runners.

### 5.9 Testing/tooling — `feasible-with-effort`, 12–20 person-weeks
**Approach.** nextest + rstest + insta + temp-env/serial_test; `cargo test --doc` as a separate CI step.
**Pitfalls.** The `src/lib.rs` refactor is a hard prerequisite for CLI integration tests. 54.9k LOC of bun:test cannot be mechanically transpiled. env-var isolation must be redesigned for Rust 2024.

---

## 6. Risk register (ranked)

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| **R1** | **`jiti` runtime `.ts` loading has no Rust equivalent** | **Showstopper** | Decide the extension model *before* any core work. Recommended: rquickjs + swc type-strip (preserves drop-a-`.ts` UX); fall back to WASM only if a build step is acceptable. |
| **R2** | **pi SDK coupling — no official Rust port; `pi_agent_rust` is a binary, not a library** | **Showstopper** | Keep pi at the boundary in TS (Option B hybrid). Audit the 161 imports to size real vs. transitive usage. Monitor for an official Rust pi SDK. |
| **R3** | **pi-tui retained-mode → ratatui immediate-mode paradigm inversion (~42 components)** | High | Full rewrite, not a port. Use tuirealm. Defer until leaves are done and the team has Rust fluency. Never tackle simultaneously with R2. |
| **R4** | **Team Rust ramp-up (2–4 months reduced velocity/engineer)** | High | Sequence easy wins first (web-access). Don't schedule deliverables during the borrow-checker phase. Double Phase-0 estimates if the team has zero Rust experience. |
| **R5** | **Single-binary distribution undermined by hybrid Node dependency or V8 embedding (~38–54MB)** | High | Prefer rquickjs (~210 KiB) over deno_core; size-optimize release profile; accept hybrid binary as a likely endpoint. |
| **R6** | **ext-apps/UiStream MCP extension: zero Rust coverage** | Medium-High | Hand-port via CustomNotification; or defer MCP-Apps UI for v1; or keep a thin TS sidecar for it. |
| **R7** | **Dossier crate facts contained version/metric/API errors** | Medium | This report applies the corrections; re-verify every crate against crates.io at implementation time (versions move weekly). |
| **R8** | **`set_var` unsafe (Rust 2024) breaks the GIT_* env-mutation test pattern** | Medium | Adopt `temp-env` + `serial_test` from day one; prefer `Command::env()` for subprocess scoping. |
| **R9** | **Tokio + Rayon misuse → p99 latency spikes** | Medium | `rayon::spawn` + oneshot bridge; size Tokio to N/2 cores, Rayon to N; add a Semaphore for backpressure. |
| **R10** | **pdf-extract panics on malformed PDFs; no OCR; serde_yaml deprecated; cross/cargo-npm/temp-env/fs_extra/kill_tree all maintenance-risky** | Medium | Pin and wrap risky crates; choose `serde_norway`/`yaml-rust2`; prefer `nix::killpg`, `watchexec`, hand-rolled npm scaffolding. |
| **R11** | **No-emit type-checker: do not rebuild `tsc` in Rust** | Low | Keep `tsc` for any remaining TS; let `cargo check` cover Rust (Deno's lesson). |

---

## 7. Recommended package sequencing

Sequencing routes around the coupling and front-loads payoff. **[verified-correction: web-access, subagents, and workflows are NOT "zero TUI coupling" — web-access imports pi-tui in `index.ts` (thin, separable); subagents has 29/70 files touching pi-tui; workflows has a dedicated `src/tui/` directory = ~40/100 files. Plan for a TUI-abstraction layer in Phases 1–2, not a TUI-free port.]**

| Order | Package | Files | Why here |
|---|---|---|---|
| **0** | **web-access** | 24 | Cleanest I/O boundary; photon-rs is already Rust under the hood; proves the napi-rs + ts-rs + cross-compile pipeline. *Caveat: thin pi-tui coupling in `index.ts` must be abstracted.* |
| **1** | **intercom**, then **mcp** | 12, 36 | IPC/protocol adapters; rmcp is the official SDK; reuse the Phase-0 pattern. |
| **2** | **subagents**, then **workflows** | 70, 100 | Orchestration logic. *Caveat: both carry substantial TUI code (~29 and ~40 files) that must be migrated or kept behind the host's TUI.* |
| **3a** | **atomic-sdk** | 106 | Bridges into the pi-coupled core; do not attempt before the extension-model decision (R1). |
| **3b** | **coding-agent + pi-SDK + TUI** | 838 | **Last.** Tri-blocker (R1+R2+R3). Likely endpoint is a permanent hybrid (Rust modules behind a TS host), not a full rewrite. |

**Hard rule:** never start with `coding-agent`. Keep `@bastani/atomic` shippable as a Bun binary throughout; every phase produces a deployable artifact.

---

## 8. Overall effort estimate & phased roadmap

| Phase | Scope | Effort | Cumulative outcome |
|---|---|---|---|
| **0 — Foundation** (mo 1–3) | web-access in Rust via napi-rs; cross-compile CI; ts-rs contracts | 2–3 pm | Hybrid binary ships; pipeline proven |
| **1 — Leaf packages** (mo 3–9) | intercom + mcp | 3–5 pm | Protocol layer native |
| **2 — Orchestration** (mo 9–18) | subagents + workflows (+ TUI-abstraction) | 6–10 pm | Logic layer native; TUI still TS |
| **3a — SDK bridge** (mo 18–24) | atomic-sdk; **extension-model decision (R1) executed** | scoped post-R1 | Extension runtime path chosen |
| **3b — Core/TUI** (mo 18–36+, optional) | coding-agent, pi replacement, ratatui rewrite, jiti→rquickjs | 18–30 pm (Option A) **or 0 pm (Option B hybrid endpoint)** | Full native *or* stable hybrid |

**Totals:** ~**18–36 person-months** for Phases 0–2 (the advisable scope); ~**48–72 person-months** for everything including the core/TUI. Assumes 2–3 engineers with dedicated ramp-up. A zero-Rust-experience team should add ~3–6 months before Phase-0 deliverables.

---

## 9. Open questions / what to prototype first to de-risk

**Prototype first (highest leverage, in order):**
1. **rquickjs + swc type-strip loading a real existing `.ts` skill end-to-end**, with one virtual module (e.g. typebox) bridged and one `pi.exec()` host call wired. This single spike resolves R1 — the dominant risk — for the cost of ~2 weeks.
2. **napi-rs web-access module called from the existing Bun host**, with ts-rs-generated types validated by `tsc`. Proves the entire Phase-0 interop story.
3. **A custom stdio JSON-RPC transport** (since `jsonrpsee` lacks one) carrying one subagents call, to validate the out-of-process option.

**Open questions that gate scope:**
- Is the pi SDK open-source / permissively licensed for method-by-method porting, or will it remain a permanent TS boundary?
- What fraction of skills are *executable* TypeScript vs. declarative Markdown/prompt descriptors? If most are declarative, the jiti problem shrinks dramatically.
- Is pi-tui used as a real retained-mode component tree, or as a thin terminal-I/O abstraction? (Determines whether the TUI surface is ~42 components or a thin shim.)
- Must existing `.ts` skills keep working unchanged (→ rquickjs is mandatory) or can authors recompile (→ WASM becomes viable)?
- Is single-binary distribution a hard requirement (rules out the V8/Node-sidecar paths)?
- Which async runtime is canonical (tokio assumed throughout)?
- Is it worth contributing to / adopting `pi_agent_rust` as the Phase-3 foundation rather than building from scratch? (Evaluate license, maintenance, API surface.)

---

## 10. Sources

**Migration & interop strategy**
- codex-rs architecture — https://codex.danielvaughan.com/2026/03/28/codex-rs-rust-rewrite-architecture/
- OpenAI Codex going native (GH #1174) — https://github.com/openai/codex/discussions/1174
- Migrating from TypeScript to Rust (corrode.dev) — https://corrode.dev/learn/migration-guides/typescript-to-rust/
- Encore: a Rust runtime for TypeScript — https://encore.dev/blog/rust-runtime
- Delta Chat — why JSON-RPC bindings exist — https://delta.chat/en/2025-02-11-why-jsonrpc-bindings-exist
- Porting 100k lines TS→Rust in a month (vjeux) — https://blog.vjeux.com/2026/analysis/porting-100k-lines-from-typescript-to-rust-using-claude-code-in-a-month.html
- JS is being rewritten in Rust (endform.dev) — https://endform.dev/blog/js-is-being-rewritten-in-rust

**pi SDK / agent frameworks**
- rig-core — https://crates.io/crates/rig-core · https://github.com/0xPlaygrounds/rig
- genai — https://crates.io/crates/genai · https://github.com/jeremychone/rust-genai
- async-openai — https://crates.io/crates/async-openai
- autoagents — https://crates.io/crates/autoagents · https://github.com/liquidos-ai/AutoAgents
- swiftide-agents — https://crates.io/crates/swiftide-agents
- keyring — https://crates.io/crates/keyring
- pi-tui (DeepWiki) — https://deepwiki.com/earendil-works/pi/4-terminal-ui-(pi-tui)
- pi_agent_rust — https://github.com/Dicklesworthstone/pi_agent_rust · https://lib.rs/crates/pi_agent_rust
- Claurst — https://github.com/Kuberwastaken/claurst/

**Extension loading / embedded JS**
- rquickjs — https://crates.io/crates/rquickjs · https://docs.rs/rquickjs/latest/rquickjs/
- swc_core / swc_ecma_parser — https://crates.io/crates/swc_core · https://crates.io/crates/swc_ecma_parser
- deno_core / deno_ast — https://crates.io/crates/deno_core · https://crates.io/crates/deno_ast
- Svix: rquickjs vs deno_core — https://www.svix.com/blog/improving-transformations/
- extism — https://crates.io/crates/extism · https://extism.org/docs/concepts/plug-in-system/
- extism/js-pdk — https://github.com/extism/js-pdk
- wasmtime component model — https://docs.wasmtime.dev/api/wasmtime/component/index.html
- rquickjs-extra — https://github.com/rquickjs/rquickjs-extra
- AWS LLRT — https://github.com/awslabs/llrt
- libloading — https://crates.io/crates/libloading
- abi_stable (unmaintained) — https://crates.io/crates/abi_stable
- Plugins in Rust (NullDeref) — https://nullderef.com/blog/plugin-tech/
- Jiti — https://github.com/unjs/jiti

**TUI / rendering**
- ratatui — https://lib.rs/crates/ratatui · https://ratatui.rs/concepts/rendering/
- ratatui async event stream — https://ratatui.rs/tutorials/counter-async-app/async-event-stream/
- crossterm — https://lib.rs/crates/crossterm
- tuirealm — https://lib.rs/crates/tuirealm · https://github.com/veeso/tui-realm
- iocraft — https://lib.rs/crates/iocraft · https://github.com/ccbrown/iocraft
- syntect — https://lib.rs/crates/syntect · https://github.com/trishume/syntect
- tui-markdown — https://docs.rs/tui-markdown
- ansi-to-tui — https://crates.io/crates/ansi-to-tui
- ratatui-image — https://lib.rs/crates/ratatui-image
- owo-colors — https://lib.rs/crates/owo-colors
- photon-rs — https://crates.io/crates/photon-rs · https://github.com/silvia-odwyer/photon
- fast_image_resize — https://lib.rs/crates/fast_image_resize
- unicode-width / ansi-width — https://crates.io/crates/unicode-width · https://crates.io/crates/ansi-width
- crokey — https://crates.io/crates/crokey

**Schema / validation**
- schemars — https://crates.io/crates/schemars · https://github.com/GREsau/schemars
- jsonschema — https://crates.io/crates/jsonschema · https://github.com/Stranger6667/jsonschema
- garde — https://crates.io/crates/garde · https://github.com/jprochazk/garde
- validator — https://crates.io/crates/validator
- typify — https://crates.io/crates/typify
- serde / serde_json — https://crates.io/crates/serde · https://crates.io/crates/serde_json
- config / figment — https://crates.io/crates/config · https://crates.io/crates/figment

**MCP**
- rmcp — https://crates.io/crates/rmcp · https://github.com/modelcontextprotocol/rust-sdk
- rmcp OAuth — https://github.com/modelcontextprotocol/rust-sdk/blob/main/docs/OAUTH_SUPPORT.md
- MCP transports spec (2025-03-26) — https://modelcontextprotocol.io/specification/2025-03-26/basic/transports
- ext-apps — https://github.com/modelcontextprotocol/ext-apps/ · https://blog.modelcontextprotocol.io/posts/2026-01-26-mcp-apps/
- webbrowser — https://crates.io/crates/webbrowser
- axum — https://crates.io/crates/axum
- which — https://crates.io/crates/which
- dirs — https://crates.io/crates/dirs
- fs4 — https://lib.rs/crates/fs4

**Web/content extraction**
- reqwest — https://crates.io/crates/reqwest
- dom_smoothie — https://crates.io/crates/dom_smoothie · https://github.com/niklak/dom_smoothie
- htmd — https://lib.rs/crates/htmd · https://github.com/letmutex/htmd
- scraper — https://crates.io/crates/scraper
- pdf-extract / lopdf / pdfium-render — https://lib.rs/crates/pdf-extract · https://crates.io/crates/lopdf · https://crates.io/crates/pdfium-render
- 13 Rust HTML-extraction crates compared — https://emschwartz.me/comparing-13-rust-crates-for-extracting-text-from-html/
- markup5ever_rcdom (production warning) — https://lib.rs/crates/markup5ever_rcdom

**Runtime / IO / process**
- tokio process / fs / Semaphore — https://docs.rs/tokio/latest/tokio/process/index.html · https://docs.rs/tokio/latest/tokio/fs/index.html · https://docs.rs/tokio/latest/tokio/sync/struct.Semaphore.html
- PostHog: untangling Tokio and Rayon — https://posthog.com/blog/untangling-rayon-and-tokio
- Alice Ryhl: what is blocking — https://ryhl.io/blog/async-what-is-blocking/
- kill_tree — https://crates.io/crates/kill_tree
- nix kill — https://docs.rs/nix/latest/nix/sys/signal/fn.kill.html
- rayon — https://crates.io/crates/rayon
- std::io::IsTerminal — https://doc.rust-lang.org/std/io/trait.IsTerminal.html
- tempfile — https://crates.io/crates/tempfile
- ignore — https://crates.io/crates/ignore
- Rust 2024 set_var unsafe — https://doc.rust-lang.org/edition-guide/rust-2024/newly-unsafe-functions.html · https://github.com/rust-lang/rust/issues/124866
- Windows bash detection bug (codex #3159) — https://github.com/openai/codex/issues/3159

**Build / dist**
- cargo-dist — https://axodotdev.github.io/cargo-dist/ · https://github.com/axodotdev/cargo-dist
- cargo-zigbuild — https://github.com/rust-cross/cargo-zigbuild
- cross — https://github.com/cross-rs/cross
- cargo-npm — https://github.com/abemedia/cargo-npm · https://crates.io/crates/cargo-npm
- esbuild optionalDependencies pattern — https://github.com/evanw/esbuild/issues/789
- Publishing binaries on npm (Sentry) — https://sentry.engineering/blog/publishing-binaries-on-npm
- rust-embed — https://crates.io/crates/rust-embed
- fs_extra — https://crates.io/crates/fs_extra
- cargo-auditable — https://github.com/rust-secure-code/cargo-auditable
- cargo-release / cargo-workspaces — https://crates.io/crates/cargo-release · https://crates.io/crates/cargo-workspaces
- npm Trusted Publishing (OIDC) — https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/
- Axios npm supply-chain attack (Microsoft) — https://www.microsoft.com/en-us/security/blog/2026/04/01/mitigating-the-axios-npm-supply-chain-compromise/
- min-sized-rust — https://github.com/johnthagen/min-sized-rust
- Bun single-file executables — https://bun.com/docs/bundler/executables

**Testing / dev tooling**
- cargo-nextest — https://nexte.st/ · https://nexte.st/docs/features/slow-tests/
- insta — https://insta.rs/ · https://lib.rs/crates/insta
- ratatui + insta snapshots — https://ratatui.rs/recipes/testing/snapshots/
- proptest — https://lib.rs/crates/proptest · https://github.com/proptest-rs/proptest
- rstest — https://github.com/la10736/rstest
- assert_cmd / assert_fs — https://crates.io/crates/assert_cmd · https://lib.rs/crates/assert_fs
- temp-env / serial_test — https://lib.rs/crates/temp-env · https://crates.io/crates/serial_test
- bacon — https://github.com/Canop/bacon
- cargo-watch (archived) — https://crates.io/crates/cargo-watch
- cargo-llvm-cov — https://lib.rs/crates/cargo-llvm-cov
- criterion / divan — https://crates.io/crates/criterion · https://lib.rs/crates/divan
- Test organization (Rust book) — https://doc.rust-lang.org/book/ch11-03-test-organization.html
- Cargo workspaces — https://doc.rust-lang.org/cargo/reference/workspaces.html

**Interop tooling**
- napi-rs v3 — https://napi.rs/blog/announce-v3 · https://crates.io/crates/napi
- ts-rs — https://crates.io/crates/ts-rs · https://github.com/Aleph-Alpha/ts-rs
- wasm-bindgen — https://rustwasm.github.io/docs/wasm-bindgen/ · https://crates.io/crates/wasm-bindgen
- jsonrpsee — https://crates.io/crates/jsonrpsee
- similar — https://crates.io/crates/similar

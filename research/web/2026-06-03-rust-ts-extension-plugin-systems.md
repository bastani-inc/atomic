---
source_url: multiple (see citations)
fetched_at: 2026-06-03
fetch_method: web-search + html-parse + api
topic: Rust plugin/extension system options to replace jiti-based runtime TS loading
---

# Rust Plugin/Extension Systems — Replacing jiti-based Runtime TS Loading

## Overview

The atomic-monorepo's extension/skill system uses jiti to load raw .ts files at runtime with no build step. Extensions and skills are user-dropped .ts files discovered from filesystem paths and executed with factory function semantics. Replacing this in a Rust binary is a major architectural challenge.

## Key Crate Versions (as of 2026-06-03)

| Crate | Version | Downloads | Last Updated |
|-------|---------|-----------|-------------|
| deno_core | 0.403.0 | 5.97M | 2026-06-03 |
| rquickjs | 0.12.0 | 2.15M | 2026-05-27 |
| boa_engine | 0.21.1 | 3.14M | 2026-03-29 |
| wasmtime | 44.0.2 | 24.97M | 2026-05-21 |
| extism | 1.21.0 | 459K | 2026-03-26 |
| rhai | 1.25.1 | 6.99M | 2026-05-29 |
| rune | 0.14.2 | 149K | 2026-05-22 |
| libloading | 0.9.0 | 390M | 2025-11-05 |
| abi_stable | 0.11.3 | 3.15M | 2023-10-12 |
| swc_core | 68.0.4 | 5.15M | 2026-06-02 |
| swc_ecma_parser | 41.0.0 | 30.07M | 2026-05-28 |
| deno_ast | 0.53.2 | 3.59M | 2026-05-02 |

## Option Analysis

### Option 1: Embedded JS Runtime (rquickjs — QuickJS)
- Best fit for the use case. Sub-300µs cold start per isolate.
- Custom Loader + Resolver traits enable path-based module discovery.
- TypeScript requires a pre-transpile step (SWC via swc_core) inside the Loader.
- No threading (single-threaded QuickJS) but AsyncRuntime available.
- Memory + timeout limits: set_memory_limit(), set_interrupt_handler() — easy.
- Binary size: ~210 KiB for QuickJS itself; total overhead minimal vs V8.
- Used in production: Svix (10x latency improvement), AWS LLRT.
- pi_agent_rust already implements this pattern.

### Option 2: Embedded JS Runtime (deno_core — V8)
- Full event loop, tokio-native async, ops macro for Rust↔JS FFI.
- TypeScript support via custom TsModuleLoader + deno_ast (154 lines of Rust).
- Binary size overhead: ~11.7 MiB for V8 alone; stripped Deno binary ~38 MB.
- Startup: V8 JIT optimization targets long-running code; most plugin calls are one-shot → overhead wasted.
- No native execution time limits; memory limits described as "pretty rough".
- Used in production by Deno, secutils.dev, many CLIs.

### Option 3: WASM Plugins (wasmtime + extism)
- extism v1.21.0 built on wasmtime; used in production by moonrepo.
- TypeScript plugins: extism-js compiler bundles QuickJS-ng into WASM via Wizer.
- User DX: requires xtp plugin build / extism-js compile step — not "drop a .ts file."
- No event loop, no async concurrency, no Node.js APIs inside WASM sandbox.
- Synchronous execution model only; async/await works only on pre-resolved values.
- Strong sandboxing by default. XTP Bindgen generates type-safe TS bindings.
- Component Model (wasmtime): WASI Preview 2 stable, cargo-component usable.
- TypeScript via Javy/jco: functional but experimental as of 2025.

### Option 4: Dynamic Libraries (libloading + abi_stable)
- libloading: v0.9.0, stable, 390M downloads — the industry standard for dlopen.
- abi_stable: v0.11.3, last release October 2023 — likely stagnant/semi-abandoned.
- ABI instability: Rust's ABI is not stable even within same compiler version; must use #[repr(C)] or stabby.
- stabby: v72.1.2-rc1, 4.07M downloads, updated 2026-01-18 — more active alternative to abi_stable.
- No TypeScript/JS support at all — plugins must be pre-compiled Rust/C.
- No sandboxing.
- Hot reload pattern: technically possible, highly unsafe due to vtable pointer staleness.

### Option 5: Rhai Scripting Language
- v1.25.1, 6.99M downloads, updated 2026-05-29 — actively maintained.
- Rust-like syntax; safe, sandboxed, no panics guarantee.
- Not TypeScript/JavaScript; existing .ts skills would need complete rewrite.
- ~2x slower than Python for typical workloads (AST walker, no JIT).
- Best for thin control-layer DSL patterns, not complex extension logic.
- Cannot run any existing extension ecosystem.

### Option 6: Rune Language
- v0.14.2, only 149K downloads, updated 2026-05-22.
- Async-first Rust-like dynamic language.
- Same problem as Rhai: incompatible with TS extension ecosystem.
- Small community, limited production adoption evidence.

### Option 7: Out-of-Process (gRPC/sockets via tonic)
- tonic v0.14.6, 291M downloads, 2026-05-07 — very active.
- Host spawns Node.js/Deno subprocess; communicates via gRPC or JSON-RPC over stdio/unix socket.
- Preserves exact TypeScript extension ecosystem with zero rewrite.
- Isolation: subprocess crash doesn't kill host.
- Latency: per-call IPC overhead; acceptable for agent tool registration (init-time).
- Used by: LSP servers, Pact Plugin Framework, VS Code extensions.
- User DX: user still drops .ts files; host spawns the right runtime.

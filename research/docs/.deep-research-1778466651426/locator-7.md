# Partition 7: rest-api/ (Telemetry Upload Backend)

## Overview

`rest-api/` is a minimal REST API service (1,168 LOC) built on Bun.serve with an in-memory item store. It is **agent-agnostic** with **zero external SDK dependencies** and **no tmux integration**.

## Implementation

- `rest-api/src/server.ts` — Bun.serve route handler; defines `/items` CRUD endpoints (GET, POST, PUT, DELETE). No environment configuration consumed.
- `rest-api/src/store.ts` — In-memory Map-based `ItemStore` class with CRUD methods (list, get, create, update, remove, clear). No persistence.
- `rest-api/src/index.ts` — Entry point; initializes `createServer()` and logs URL. Hardcoded port 3000 by default.
- `rest-api/src/types.ts` — Validation and type definitions: `Item`, `CreateItemInput`, `UpdateItemInput`. Dual-path validators: throwing `parseCreate/UpdateItemInput()` and result-style `validateCreate/UpdateItemInput()`.
- `rest-api/src/errors.ts` — HTTP error class hierarchy (`HttpError`, `NotFoundError`, `BadRequestError`) and response builders (`errorResponse()`, `jsonResponse()`).

## Tests

- `rest-api/src/server.test.ts` — E2E route tests for all five CRUD operations (GET /items, POST /items, GET /items/:id, PUT /items/:id, DELETE /items/:id). Uses bun:test and creates ephemeral servers on port 0.
- `rest-api/src/store.test.ts` — Unit tests for `ItemStore` CRUD, list snapshots, and timestamps. Covers create, get, update, remove, clear.
- `rest-api/src/types.test.ts` — Validation tests for `parseCreate/UpdateItemInput` and `validateCreate/UpdateItemInput`. Tests boundary conditions (empty, null, type mismatches, length limits).
- `rest-api/src/errors.test.ts` — Error class and response builder tests. Covers `HttpError`, `NotFoundError`, `BadRequestError`, `errorResponse()`, `jsonResponse()`.

## Types / Interfaces

- `Item` — `{ id: string (UUID), name: string, description: string | null, createdAt: ISO8601, updatedAt: ISO8601 }`
- `CreateItemInput` — `{ name: string (required), description?: string | null }`
- `UpdateItemInput` — `{ name?: string, description?: string | null }`
- `ErrorResponseBody` — `{ error: { status: number, message: string } }`
- `ItemStore` — In-memory store class with methods: `list()`, `get(id)`, `create(input)`, `update(id, input)`, `remove(id)`, `clear()`
- `HttpError`, `NotFoundError`, `BadRequestError` — Error subclasses with `status` property

## Configuration

- `rest-api/package.json` — Minimal config: `"scripts": { "start", "dev", "test" }`. `devDependencies`: only `@types/bun` and `typescript`. No runtime dependencies. No environment variable configuration.
- `rest-api/tsconfig.json` — ESNext target, strict mode, Bun-specific types, no emit.

## Documentation

- `rest-api/README.md` — Outlines requirements (Bun >= 1.1), install/run, all five endpoint signatures, request/response shapes, error format, curl examples.

## Notable Clusters

- `rest-api/src/` — 5 implementation files (server, store, types, errors, index) + 4 test files, totaling 9 files. All are pure TypeScript with zero external SDK imports.

## Dependency & Architecture Analysis

### External Dependencies
- **Zero external packages** in production. Runtime uses only native Bun APIs (`Bun.serve`, `crypto.randomUUID`, `Response`).
- `devDependencies`: `@types/bun` (types only), `typescript` (compiler only).

### Agent SDK Linkage
- **No imports** of `@anthropics/claude-agent-sdk-typescript`, `@github/copilot-sdk`, or `@anomalyco/opencode`.
- **No tmux integration** — pure HTTP server, no process spawning or terminal interaction.
- **No configuration files** tied to `.claude`, `.github`, or `.opencode` directories.

### Load-Bearing vs. Removable

**Load-bearing (essential to API function):**
- HTTP route definitions in `server.ts` (CRUD endpoints)
- `ItemStore` class (state management)
- Type validators in `types.ts` (input safety)
- Error class hierarchy (error handling)

**Removable (for pi-coding-agent rewrite):**
- The entire `rest-api/` package is **optionally includable**. It is not depended on by Atomic CLI core (`packages/atomic`). If telemetry collection is dropped or replaced with a simpler backend, this can be deleted or swapped with a pi-coding-agent compatible alternative.

### Platform Compatibility
- **Bun-native only.** No Node.js compatibility (`Bun.serve`, `crypto.randomUUID` are Bun builtins). If pi-coding-agent targets Node.js or a different runtime, this would require rewrite.
- **No database or persistence layer.** In-memory Map only. Production would require external store (PostgreSQL, Redis, S3, etc.) and environment config (`DB_URL`, etc.) — none currently present.

## HTTP Routes

| Method | Path | Input | Output | Status |
|--------|------|-------|--------|--------|
| GET | /items | — | Item[] | 200 |
| POST | /items | CreateItemInput | Item | 201 |
| GET | /items/:id | — | Item | 200 / 404 |
| PUT | /items/:id | UpdateItemInput | Item | 200 / 404 |
| DELETE | /items/:id | — | (empty) | 204 / 404 |

Error responses always return `{ error: { status, message } }` with appropriate HTTP status.

## Summary

`rest-api/` is a **completely decoupled, agent-agnostic REST API layer** with no external SDK dependencies, no tmux, and no configuration coupling to Claude/Copilot/OpenCode ecosystems. It can be removed, rewritten, or migrated independently as part of the pi-coding-agent rewrite. The in-memory store is suitable only for demo/testing; production use requires a persistent backend and environment variable configuration not yet present.

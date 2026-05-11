### Files Analysed

- `rest-api/src/index.ts` — entry point
- `rest-api/src/server.ts` — HTTP route handler and server factory
- `rest-api/src/store.ts` — in-memory item store
- `rest-api/src/types.ts` — type definitions and dual-path validators
- `rest-api/src/errors.ts` — HTTP error class hierarchy and response builders
- `rest-api/src/server.test.ts` — E2E route tests
- `rest-api/src/store.test.ts` — unit tests for ItemStore
- `rest-api/src/types.test.ts` — validation tests for both parse and validate paths
- `rest-api/src/errors.test.ts` — error class and response builder tests
- `rest-api/package.json` — package manifest and scripts
- `rest-api/tsconfig.json` — TypeScript compiler configuration

---

### Per-File Notes

#### `rest-api/src/index.ts`

- **Role:** Sole entry point. Calls `createServer()` and logs the bound URL.
- **Key symbols:** calls `createServer` (imported from `./server`) at line 3; logs `server.url` at line 4.
- **Control flow:** Linear — import, call, log. No arguments passed to `createServer`, so the server binds to the default port 3000 (`server.ts:24`).
- **Data flow:** `createServer()` returns a `Bun.Server` value; `server.url` is the string Bun assigns after binding.
- **Dependencies:** Only `./server`. No env vars read, no external packages.

---

#### `rest-api/src/server.ts`

- **Role:** Defines the `createServer` factory function that configures and starts a `Bun.serve` instance with five CRUD route handlers over two route patterns.
- **Key symbols:**
  - `ServerOptions` type (`server.ts:10-13`): optional `port` (default `3000`) and optional injected `store` (`ItemStore`).
  - `parseJsonBody` (`server.ts:15-21`): async helper that calls `req.json()`, throwing `BadRequestError("Invalid JSON body")` on parse failure.
  - `createServer` (`server.ts:23`): exported factory returning `ReturnType<typeof Bun.serve>`.
- **Control flow:**
  - `createServer` resolves the port (`options?.port ?? 3000`) and store (`options?.store ?? new ItemStore()`) at lines 24–25.
  - `Bun.serve` is called with a `routes` object (`server.ts:29-99`) mapping two URL patterns:
    - `/items` (`server.ts:30-53`): `GET` returns `store.list()` serialized as JSON with status 200; `POST` calls `parseJsonBody`, then `parseCreateItemInput`, then `store.create`, returning status 201.
    - `/items/:id` (`server.ts:54-98`): `GET` calls `store.get(id)` and throws `NotFoundError` if undefined; `PUT` parses body with `parseUpdateItemInput`, calls `store.update`, throws `NotFoundError` if undefined; `DELETE` calls `store.remove`, throws `NotFoundError` if `false`.
  - A top-level `fetch` fallback at `server.ts:100-102` returns `errorResponse(new NotFoundError("Route not found"))` for any unmatched path.
  - Every handler wraps its logic in try/catch, delegating all error serialization to `errorResponse`.
- **Data flow:** HTTP `Request` → `parseJsonBody` (for mutation routes) → `parseCreateItemInput` or `parseUpdateItemInput` → `ItemStore` method → `jsonResponse` or `errorResponse` → HTTP `Response`.
- **Dependencies:** `./store` (`ItemStore`), `./errors` (`BadRequestError`, `NotFoundError`, `errorResponse`, `jsonResponse`), `./types` (`parseCreateItemInput`, `parseUpdateItemInput`). Uses `Bun.serve` natively; no npm runtime deps.

---

#### `rest-api/src/store.ts`

- **Role:** Provides `ItemStore`, the sole in-memory persistence layer, backed by a private `Map<string, Item>`.
- **Key symbols:**
  - `ItemStore` class (`store.ts:3`): exported class.
  - `list()` (`store.ts:6-8`): returns `Array.from(this.items.values())`, a fresh array snapshot each call.
  - `get(id)` (`store.ts:10-12`): returns `Item | undefined`.
  - `create(input)` (`store.ts:14-25`): generates a UUID via `crypto.randomUUID()`, stamps both `createdAt` and `updatedAt` with `new Date().toISOString()`, stores and returns the new item.
  - `update(id, input)` (`store.ts:27-44`): spreads existing item, stamps new `updatedAt`. Conditionally applies `input.name` if present; applies `input.description` only when `"description" in input` (`store.ts:39`) to distinguish `undefined` (omitted) from `null` (explicit nullification). Returns `undefined` for unknown ids.
  - `remove(id)` (`store.ts:46-48`): delegates to `Map.delete`, returns boolean.
  - `clear()` (`store.ts:50-52`): empties the map; used in tests.
- **Control flow:** All methods are synchronous. No persistence; state lives in the `Map` for the lifetime of the process.
- **Data flow:** `CreateItemInput` → `create()` → `Item` (with generated fields). `UpdateItemInput` → `update()` → patched `Item` or `undefined`. `remove()` → `boolean`.
- **Dependencies:** `./types` (type imports only: `Item`, `CreateItemInput`, `UpdateItemInput`). No external runtime deps; uses Web-standard `crypto.randomUUID()`.

---

#### `rest-api/src/types.ts`

- **Role:** Defines the three domain types and exposes two distinct validation paths: a throw-on-error path (`parse*`) and a result-object path (`validate*`, kept for backward compatibility).
- **Key symbols:**
  - `Item` (`types.ts:1-7`): exported type with `id`, `name`, `description: string | null`, `createdAt`, `updatedAt`.
  - `CreateItemInput` (`types.ts:9-12`): `{ name: string; description?: string | null }`.
  - `UpdateItemInput` (`types.ts:14-17`): `{ name?: string; description?: string | null }`.
  - `parseCreateItemInput(value: unknown): CreateItemInput` (`types.ts:76-88`): throws on any validation failure. Enforces unknown-field rejection via `checkUnknownFields` (`types.ts:30-36`). Trims `name` to max 200 chars; `description` max 2000 chars.
  - `parseUpdateItemInput(value: unknown): UpdateItemInput` (`types.ts:90-105`): same throw-on-error approach; all fields optional, empty object is valid (no at-least-one enforcement in this path).
  - `validateCreateItemInput(body: unknown): ValidationResult<CreateItemInput>` (`types.ts:115-137`): result-object style; does not enforce field length limits or unknown-field rejection; trimmed name only.
  - `validateUpdateItemInput(body: unknown): ValidationResult<UpdateItemInput>` (`types.ts:139-172`): result-object style; enforces at-least-one field, but does not enforce length limits.
- **Control flow:** `isPlainObject` (`types.ts:23-25`) is the gate for all validators. `checkUnknownFields` loops over `Object.keys` against an allowed `Set` (`types.ts:27-36`). `validateName` is overloaded for required vs optional (`types.ts:38-54`).
- **Data flow:** Raw `unknown` JSON → structural guard → field-level validators → typed input object (or thrown error / `{ ok, error }` result).
- **Dependencies:** None. Pure TypeScript, no imports.

---

#### `rest-api/src/errors.ts`

- **Role:** HTTP error class hierarchy and two response-builder utilities used throughout `server.ts`.
- **Key symbols:**
  - `HttpError extends Error` (`errors.ts:1-9`): base class carrying `readonly status: number`.
  - `NotFoundError extends HttpError` (`errors.ts:11-16`): hard-coded status 404; default message `"Resource not found"`.
  - `BadRequestError extends HttpError` (`errors.ts:18-23`): hard-coded status 400.
  - `ErrorResponseBody` (`errors.ts:25-30`): exported type `{ error: { status: number; message: string } }`.
  - `errorResponse(err: unknown): Response` (`errors.ts:32-40`): inspects `err instanceof HttpError` to choose status (500 for non-`HttpError`), serializes `ErrorResponseBody` as JSON with matching status code and `content-type: application/json`.
  - `jsonResponse(data: unknown, init?: ResponseInit): Response` (`errors.ts:42-55`): wraps any value in JSON, merges caller-supplied headers (handling both plain-object and `Headers` instance forms at lines 43-46), and forces `content-type: application/json`.
- **Control flow:** `errorResponse` is a pure function with an instanceof branch. `jsonResponse` normalizes headers then spreads into `new Response`.
- **Data flow:** Error or data value → JSON string → `Response` with appropriate status and headers.
- **Dependencies:** None. Uses only `Response` (Web standard, provided by Bun).

---

#### `rest-api/src/server.test.ts`

- **Role:** E2E integration tests for all five route handlers, running against a live `Bun.serve` instance on port `0` (OS-assigned ephemeral port).
- **Key symbols:** Five `describe` blocks (`server.test.ts:21`, `56`, `144`, `184`, `263`) for `GET /items`, `POST /items`, `GET /items/:id`, `PUT /items/:id`, `DELETE /items/:id`.
- **Control flow:** Each `describe` block calls `createServer({ port: 0, store: new ItemStore() })` in `beforeAll` and `server.stop(true)` in `afterAll`. Tests use native `fetch` against `http://localhost:${server.port}${path}`. No mocking.
- **Data flow:** HTTP requests → live server → JSON responses parsed with `res.json()`.
- **Dependencies:** `bun:test`, `./server`, `./store`.

---

#### `rest-api/src/store.test.ts`

- **Role:** Unit tests for `ItemStore` covering all six methods (`create`, `list`, `get`, `update`, `remove`, `clear`).
- **Control flow:** Each test calls methods directly on a fresh `ItemStore` instance created in `beforeEach` (`store.test.ts:7`). No HTTP layer involved.
- **Dependencies:** `bun:test`, `./store`.

---

#### `rest-api/src/types.test.ts`

- **Role:** Validation tests covering both the `validate*` (result-object) and `parse*` (throw) exports for create and update inputs. Notably, `parseUpdateItemInput` with an empty object is accepted (returns `{}`), while `validateUpdateItemInput` with an empty object returns `{ ok: false, error: "at least one of name or description must be provided" }` — documenting the behavioral divergence between the two paths (`types.test.ts:90-94` vs `types.test.ts:259-262`).
- **Dependencies:** `bun:test`, `./types`.

---

#### `rest-api/src/errors.test.ts`

- **Role:** Unit tests for `HttpError`, `NotFoundError`, `BadRequestError`, `errorResponse`, and `jsonResponse`. Covers 500-fallback for non-`HttpError` throws, header merging in `jsonResponse`, and correct `ErrorResponseBody` shape.
- **Dependencies:** `bun:test`, `./errors`.

---

#### `rest-api/package.json`

- **Role:** Package manifest for the isolated `rest-api` workspace. Declares `"type": "module"`, scripts `start` (`bun run src/index.ts`), `dev` (`bun --hot src/index.ts`), and `test` (`bun test`). No runtime dependencies. Only `devDependencies`: `@types/bun: latest` and `typescript: ^5.0.0`.

---

#### `rest-api/tsconfig.json`

- **Role:** TypeScript compiler configuration. Targets ESNext with `moduleResolution: bundler`, strict mode enabled, `bun-types` injected via `types`, `noEmit: true` (type-check only, Bun handles transpilation), `allowImportingTsExtensions: true` for `.ts` imports.

---

### Cross-Cutting Synthesis

The `rest-api/` workspace is a self-contained, general-purpose JSON REST API with zero coupling to Claude Code, Copilot, OpenCode, or tmux. The entire system is six source files totalling roughly 400 lines of production code. `createServer` (`server.ts:23`) is the single public assembly point: it accepts dependency-injected `port` and `store` options, enabling tests to use ephemeral ports and isolated stores without any environment setup. The two validation paths in `types.ts` — the throwing `parse*` functions used by `server.ts` and the result-object `validate*` functions marked as "legacy backward compatibility" — have divergent behavior on some edge cases (empty-object update body). All error serialization funnels through `errorResponse` in `errors.ts`, producing a uniform `{ error: { status, message } }` envelope. The store is purely in-memory (`Map`), with no persistence between process restarts. There is no telemetry, authentication, logging, configuration file loading, or external I/O of any kind. The package is agent-agnostic and has no seams that need replacing for a pi-coding-agent rewrite; it can be adopted as-is or discarded entirely depending on whether pi-coding-agent needs a local REST backend.

---

### Out-of-Partition References

None. All imports in `rest-api/src/` resolve within the partition (relative `./` imports only). No references to `packages/atomic`, `packages/atomic-sdk`, or any other top-level workspace directory are present.

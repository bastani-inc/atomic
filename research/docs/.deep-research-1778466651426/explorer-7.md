# Partition 7 of 12 — Findings

## Scope
`rest-api/` (9 files, 1,168 LOC)

## Files in Scope
<!-- Source: codebase-locator sub-agent -->
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

## How It Works
<!-- Source: codebase-analyzer sub-agent -->
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

## Patterns
<!-- Source: codebase-pattern-finder sub-agent -->
# Pattern Research: rest-api/ (Partition 7 of 12)

## Overview
The rest-api telemetry backend is a minimal in-memory HTTP server built with Bun's native `Bun.serve()`. It has **zero agent-specific coupling** (no Claude SDK, Copilot SDK, OpenCode SDK, or tmux dependencies). The implementation uses pure TypeScript with Bun's native HTTP runtime.

---

## Patterns Found

#### Pattern: Bun.serve() Route Declaration with Method Handlers
**Where:** `rest-api/src/server.ts:27-103`
**What:** Declares HTTP routes using Bun's native `routes` object with HTTP method keys (GET, POST, PUT, DELETE) mapped to handler functions.
```typescript
export function createServer(options?: ServerOptions): ReturnType<typeof Bun.serve> {
  const port = options?.port ?? 3000;
  const store = options?.store ?? new ItemStore();

  return Bun.serve({
    port,
    routes: {
      "/items": {
        GET: (_req) => {
          try {
            return jsonResponse(store.list());
          } catch (err) {
            return errorResponse(err);
          }
        },
        POST: async (req) => {
          try {
            const body = await parseJsonBody(req);
            let input;
            try {
              input = parseCreateItemInput(body);
            } catch (err) {
              throw new BadRequestError(err instanceof Error ? err.message : String(err));
            }
            const created = store.create(input);
            return jsonResponse(created, { status: 201 });
          } catch (err) {
            return errorResponse(err);
          }
        },
      },
      "/items/:id": {
        GET: (req: Bun.BunRequest<"/items/:id">) => { /* ... */ },
        PUT: async (req: Bun.BunRequest<"/items/:id">) => { /* ... */ },
        DELETE: (req: Bun.BunRequest<"/items/:id">) => { /* ... */ },
      },
    },
    fetch: (_req) => {
      return errorResponse(new NotFoundError("Route not found"));
    },
  });
}
```
**Variations / call-sites:**
- Route structure used throughout `server.ts:29-99`
- Pattern covers CRUD endpoints: `/items` (GET/POST) and `/items/:id` (GET/PUT/DELETE)
- `fetch` fallback at `server.ts:100-102` handles unmapped routes

---

#### Pattern: Parametric Route Handler with Type-Safe req.params
**Where:** `rest-api/src/server.ts:55-66`
**What:** Uses Bun's `BunRequest<"/items/:id">` type annotation to enable typed access to route parameters via `req.params`.
```typescript
GET: (req: Bun.BunRequest<"/items/:id">) => {
  try {
    const { id } = req.params;
    const item = store.get(id);
    if (item === undefined) {
      throw new NotFoundError(`Item ${id} not found`);
    }
    return jsonResponse(item);
  } catch (err) {
    return errorResponse(err);
  }
},
```
**Variations / call-sites:**
- PUT handler at `server.ts:67-85`
- DELETE handler at `server.ts:86-97`
- All three parametric routes (GET, PUT, DELETE) use identical type annotation pattern

---

#### Pattern: Async JSON Body Parsing with Error Handling
**Where:** `rest-api/src/server.ts:15-21`
**What:** Extracts and parses JSON request body with try-catch; throws `BadRequestError` on malformed JSON.
```typescript
async function parseJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequestError("Invalid JSON body");
  }
}
```
**Variations / call-sites:**
- Used in POST `/items` handler at `server.ts:40`
- Used in PUT `/items/:id` handler at `server.ts:70`
- No variations in error handling strategy

---

#### Pattern: Two-Stage Input Validation: Parse Then Throw
**Where:** `rest-api/src/server.ts:38-51` (POST /items)
**What:** Outer try-catch wraps the entire request, inner try-catch wraps input parsing which throws exceptions that are re-caught and converted to `BadRequestError`.
```typescript
POST: async (req) => {
  try {
    const body = await parseJsonBody(req);
    let input;
    try {
      input = parseCreateItemInput(body);
    } catch (err) {
      throw new BadRequestError(err instanceof Error ? err.message : String(err));
    }
    const created = store.create(input);
    return jsonResponse(created, { status: 201 });
  } catch (err) {
    return errorResponse(err);
  }
},
```
**Variations / call-sites:**
- Same pattern in PUT `/items/:id` at `server.ts:67-85`
- No alternative validation patterns (e.g., Result types) used in routes

---

#### Pattern: HTTP Error Class Hierarchy
**Where:** `rest-api/src/errors.ts:1-23`
**What:** Base `HttpError` class with `status` property; subclasses (`NotFoundError`, `BadRequestError`) provide semantic meaning with fixed status codes.
```typescript
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export class NotFoundError extends HttpError {
  constructor(message: string = "Resource not found") {
    super(404, message);
    this.name = "NotFoundError";
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, message);
    this.name = "BadRequestError";
  }
}
```
**Variations / call-sites:**
- Used in route handlers: `server.ts:60`, `server.ts:45`, `server.ts:79`, `server.ts:91`, `server.ts:101`
- Error status detection at `errors.ts:33` via `instanceof HttpError`

---

#### Pattern: Standardized JSON Response Helpers
**Where:** `rest-api/src/errors.ts:32-55`
**What:** Two helper functions: `errorResponse()` detects error type and status code; `jsonResponse()` wraps data with JSON headers and optional ResponseInit overrides.
```typescript
export function errorResponse(err: unknown): Response {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof HttpError ? err.message : "Internal Server Error";
  const body: ErrorResponseBody = { error: { status, message } };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function jsonResponse(data: unknown, init?: ResponseInit): Response {
  const initHeaders =
    init?.headers instanceof Headers
      ? Object.fromEntries(init.headers.entries())
      : (init?.headers as Record<string, string> | undefined) ?? {};

  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...initHeaders,
      "content-type": "application/json",
    },
  });
}
```
**Variations / call-sites:**
- `jsonResponse()` called in: `server.ts:33`, `server.ts:48`, `server.ts:62`, `server.ts:81`
- `errorResponse()` called in: `server.ts:35`, `server.ts:50`, `server.ts:64`, `server.ts:83`, `server.ts:95`, `server.ts:101`

---

#### Pattern: Input Validation via Thrown Exceptions (parseX functions)
**Where:** `rest-api/src/types.ts:76-105`
**What:** `parseCreateItemInput()` and `parseUpdateItemInput()` validate and normalize input by throwing descriptive errors; unknown fields rejected via `checkUnknownFields()`.
```typescript
export function parseCreateItemInput(value: unknown): CreateItemInput {
  if (!isPlainObject(value)) {
    throw new Error("Invalid request body: body must be an object");
  }
  checkUnknownFields(value, ALLOWED_CREATE_FIELDS);
  const name = validateName(value["name"], true);
  const description = validateDescription(value["description"]);
  const result: CreateItemInput = { name };
  if (description !== undefined) {
    result.description = description;
  }
  return result;
}

export function parseUpdateItemInput(value: unknown): UpdateItemInput {
  if (!isPlainObject(value)) {
    throw new Error("Invalid request body: body must be an object");
  }
  checkUnknownFields(value, ALLOWED_UPDATE_FIELDS);
  const name = validateName(value["name"], false);
  const description = validateDescription(value["description"]);
  const result: UpdateItemInput = {};
  if (name !== undefined) {
    result.name = name;
  }
  if (description !== undefined) {
    result.description = description;
  }
  return result;
}
```
**Variations / call-sites:**
- Field validation helpers: `validateName()` at `types.ts:38-54`, `validateDescription()` at `types.ts:56-70`
- Field allowlist enforcement: `types.ts:27-28` (ALLOWED_CREATE_FIELDS, ALLOWED_UPDATE_FIELDS)
- Legacy Result-style validators also exist: `validateCreateItemInput()` at `types.ts:115-137`, `validateUpdateItemInput()` at `types.ts:139-172`

---

#### Pattern: In-Memory Map-Based Store with CRUD Methods
**Where:** `rest-api/src/store.ts:3-53`
**What:** `ItemStore` class uses a private `Map<string, Item>` and exposes public methods: `list()`, `get(id)`, `create(input)`, `update(id, input)`, `remove(id)`, `clear()`.
```typescript
export class ItemStore {
  private readonly items: Map<string, Item> = new Map();

  list(): Item[] {
    return Array.from(this.items.values());
  }

  get(id: string): Item | undefined {
    return this.items.get(id);
  }

  create(input: CreateItemInput): Item {
    const now = new Date().toISOString();
    const item: Item = {
      id: crypto.randomUUID(),
      name: input.name,
      description: input.description ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(item.id, item);
    return item;
  }

  update(id: string, input: UpdateItemInput): Item | undefined {
    const existing = this.items.get(id);
    if (existing === undefined) {
      return undefined;
    }
    const updated: Item = {
      ...existing,
      updatedAt: new Date().toISOString(),
    };
    if (input.name !== undefined) {
      updated.name = input.name;
    }
    if ("description" in input) {
      updated.description = input.description ?? null;
    }
    this.items.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
  }
}
```
**Variations / call-sites:**
- `create()` generates UUIDs at `store.ts:17` via `crypto.randomUUID()`
- Timestamps as ISO strings at `store.ts:15`, `store.ts:34`
- Null coalescing for optional fields at `store.ts:19`
- Update partial merge semantics at `store.ts:39` (checks `"description" in input`)

---

#### Pattern: Server Options Type with Optional Overrides
**Where:** `rest-api/src/server.ts:10-13`
**What:** `ServerOptions` type allows runtime configuration of port and store instance; defaults provided if not specified.
```typescript
type ServerOptions = {
  port?: number;
  store?: ItemStore;
};
```
**Variations / call-sites:**
- Used in `createServer()` parameter at `server.ts:23`
- Port defaulting logic at `server.ts:24`
- Store instantiation at `server.ts:25`

---

## Data Types & Schemas

#### Item Schema
**Where:** `rest-api/src/types.ts:1-7`
```typescript
export type Item = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string; // ISO timestamp
  updatedAt: string; // ISO timestamp
};
```

#### CreateItemInput Schema
**Where:** `rest-api/src/types.ts:9-12`
```typescript
export type CreateItemInput = {
  name: string;
  description?: string | null;
};
```

#### UpdateItemInput Schema
**Where:** `rest-api/src/types.ts:14-17`
```typescript
export type UpdateItemInput = {
  name?: string;
  description?: string | null;
};
```

#### ErrorResponseBody Schema
**Where:** `rest-api/src/errors.ts:25-30`
```typescript
export type ErrorResponseBody = {
  error: {
    status: number;
    message: string;
  };
};
```

---

## Environment Configuration

**Status:** ZERO environment variables used.

- No `process.env` references
- No `import.meta.env` references
- Port hardcoded default: `3000` (overridable via `ServerOptions`)
- No database connection strings, API keys, or external service config
- No tmux, Claude SDK, Copilot SDK, or OpenCode SDK usage

---

## HTTP Endpoints Summary

| Method | Path | Input | Output | Status |
|--------|------|-------|--------|--------|
| GET | `/items` | none | `Item[]` | 200 |
| POST | `/items` | `CreateItemInput` | `Item` | 201 |
| GET | `/items/:id` | `:id` param | `Item` | 200 |
| PUT | `/items/:id` | `:id` param + `UpdateItemInput` | `Item` | 200 |
| DELETE | `/items/:id` | `:id` param | none (empty body) | 204 |
| (unmapped) | `*` | any | `ErrorResponseBody` | 404 |

---

## Agent-Specific Coupling: NONE

- **Claude Code/Agent SDK:** No imports, no dependencies
- **GitHub Copilot CLI/SDK:** No imports, no dependencies
- **OpenCode/OpenCode SDK:** No imports, no dependencies
- **tmux:** No references, no usage
- **environment-specific configuration:** Zero env var usage

The entire codebase uses only:
- TypeScript
- Bun runtime (native `Bun.serve()`, `crypto.randomUUID()`)
- Standard ECMAScript APIs

---

## Test Structure

All tests use `bun:test` (Bun's native test runner):
- **server.test.ts** (306 LOC): Integration tests for all HTTP endpoints
- **store.test.ts** (115 LOC): Unit tests for `ItemStore` CRUD operations
- **types.test.ts** (264 LOC): Tests for both throwing (`parseX`) and result-style (`validateX`) validators
- **errors.test.ts** (99 LOC): Tests for error classes and response helpers

All tests are runnable via `bun test` with no external test dependencies.

## Out-of-Partition References
Look for the **Out-of-Partition References** subsection inside the
"How It Works" section above — that is where the analyzer flagged files
outside this partition that other partitions should examine.

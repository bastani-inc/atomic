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


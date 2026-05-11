(no external research applicable)

The `rest-api/` package has zero runtime dependencies: it uses only `Bun.serve` (a Bun built-in), the native Web API `Request`/`Response` types, and `crypto.randomUUID()` — all part of the Bun runtime itself. The only devDependencies are `@types/bun` (type declarations, no runtime behaviour) and `typescript` (compile-time only). There are no external HTTP frameworks, validation libraries, ORMs, or middleware packages whose documentation would be central to planning a rewrite of this partition.

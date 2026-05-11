# Partition 9 — `scripts/` external dependency research

Scope: `scripts/lint-offload-await.ts`, `scripts/lint-custom-workflows.ts`, `scripts/lint-offload-await.test.ts` (357 LOC total).

## Dependency inventory

| File | External import | Nature |
|------|----------------|--------|
| lint-offload-await.ts | `node:path` (`join`) | Node built-in, no doc needed |
| lint-offload-await.ts | `Bun.file(path).text()` | Bun-native API — central |
| lint-offload-await.ts | `new Bun.Glob(pattern).scanSync(root)` | Bun-native API — central |
| lint-offload-await.ts | `import.meta.dir`, `import.meta.main` | Bun module meta — central |
| lint-custom-workflows.ts | `fs` (`readFileSync`) | Node built-in, no doc needed |
| lint-custom-workflows.ts | `path` (`join`) | Node built-in, no doc needed |
| lint-offload-await.test.ts | `bun:test` (`test`, `expect`) | Bun-native test runner — central |

`lint-custom-workflows.ts` uses only Node built-ins and pure regex; it has no Bun-specific APIs and will port to any Node-compatible runtime unchanged.

---

#### Bun File I/O (`Bun.file` / `BunFile`)

**Docs:** https://bun.com/docs/runtime/file-io

**Relevant behaviour:**

- `Bun.file(path: string | number | URL, options?: { type?: string }): BunFile` — constructs a lazy file reference; no disk I/O occurs at construction time.
- `BunFile.text(): Promise<string>` — reads entire file as UTF-8 string. Async; must be awaited.
- `BunFile.exists(): Promise<boolean>` — non-throwing way to check existence (the scripts use try/catch instead).
- Additional read methods: `.json()`, `.arrayBuffer()`, `.bytes()`, `.stream()` — not used in these scripts.
- `BunFile` implements the `Blob` interface.
- `Bun.file` is **Bun-exclusive**; it has no direct Node.js equivalent. The closest Node substitute is `fs.promises.readFile(path, 'utf-8')`.

**Where used:** `scripts/lint-offload-await.ts:99`, `scripts/lint-offload-await.ts:119`

```
text = await Bun.file(EXECUTOR).text();   // line 99
text = await Bun.file(file).text();       // line 119
```

**Rewrite note:** If pi-coding-agent runs on Node, replace with `import { readFile } from 'node:fs/promises'; const text = await readFile(path, 'utf-8');`. If it stays on Bun, `Bun.file(path).text()` is idiomatic and preferred over `fs.promises.readFile`.

---

#### Bun Glob (`Bun.Glob`)

**Docs:** https://bun.com/docs/runtime/glob

**Relevant behaviour:**

- `new Bun.Glob(pattern: string)` — constructs a glob matcher.
- `glob.scanSync(root: string | ScanOptions): Iterable<string>` — synchronously walks from `root`, yields relative path strings matching the pattern.
- `glob.scan(root: string | ScanOptions): AsyncIterable<string>` — async variant.
- `glob.match(path: string): boolean` — test a single path string.
- `ScanOptions`: `{ cwd?: string, dot?: boolean, absolute?: boolean, followSymlinks?: boolean, onlyFiles?: boolean }`. `cwd` defaults to `process.cwd()`.
- Return values are **relative** paths unless `absolute: true` is passed. The scripts pass `REPO_ROOT` as the root and then manually join with `join(REPO_ROOT, p)` to get absolute paths (line 114).
- `Bun.Glob` is **Bun-exclusive**. Node.js substitute: `glob` npm package (e.g., `import { globSync } from 'glob';`) or `node:fs` + manual recursion.

**Where used:** `scripts/lint-offload-await.ts:113`, `scripts/lint-offload-await.ts:132`

```
new Bun.Glob(COMPONENTS_GLOB).scanSync(REPO_ROOT)   // line 113
new Bun.Glob(COMPONENTS_GLOB).scanSync(REPO_ROOT)   // line 132
```

Pattern used: `"packages/atomic-sdk/src/components/**/*.{ts,tsx}"` — a brace-expansion glob with `**` recursion. Both `glob` npm and Bun.Glob support this syntax identically.

---

#### `import.meta.dir` and `import.meta.main` (Bun module meta)

**Docs:** https://bun.com/docs/runtime/import-meta

**Relevant behaviour:**

- `import.meta.dir` — absolute directory path of the current source file (Bun extension; equivalent to Node's `path.dirname(new URL(import.meta.url).pathname)` or `__dirname` in CJS).
- `import.meta.main` — `true` when the current module is the entry-point script (Bun extension; equivalent to `import.meta.url === Bun.main` or checking `process.argv[1]`).

**Where used:** `scripts/lint-offload-await.ts:16` (`import.meta.dir`), `scripts/lint-offload-await.ts:92` (`import.meta.main`)

**Rewrite note for Node:** Replace `import.meta.dir` with `path.dirname(fileURLToPath(import.meta.url))`. Replace `import.meta.main` with `process.argv[1] === fileURLToPath(import.meta.url)`.

---

#### `bun:test` test runner

**Docs:** https://bun.com/docs/test/writing

**Relevant behaviour:**

- Import: `import { test, expect } from "bun:test";`
- `test(name: string, fn: () => void | Promise<void>, timeout?: number)` — register a test case.
- `expect(value).toHaveLength(n)` — asserts `.length === n`.
- `expect(value).toBe(primitive)` — strict equality (`===`).
- `expect(value[index]!.rule).toBe("...")` — non-null assertion on array element before property access.
- Default test timeout: 5000 ms.
- `bun:test` is **Bun-native**. It is Jest-compatible for the subset of matchers used here (`toBe`, `toHaveLength`). A Node port can use Jest or Vitest with identical test source.

**Where used:** `scripts/lint-offload-await.test.ts:1-133` (all 133 LOC are bun:test API)

---

## Summary for rewrite

The three scripts are self-contained linters with no agent SDK, tmux, Claude, Copilot, or OpenCode dependencies. The only rewrite risk is the three Bun-exclusive APIs:

1. `Bun.file(path).text()` — replace with `fs.promises.readFile(path, 'utf-8')` if moving off Bun.
2. `new Bun.Glob(pattern).scanSync(root)` — replace with `globSync(pattern, { cwd: root })` from the `glob` npm package.
3. `import.meta.dir` / `import.meta.main` — replace with `path.dirname(fileURLToPath(import.meta.url))` / argv check.

If pi-coding-agent continues to use Bun as its runtime, zero changes are required in `scripts/`.

## 1. Established patterns

- **Thin entrypoint, real work in `main()`**
  - `packages/coding-agent/src/cli.ts` only sets process-wide startup state (`process.title`, env marker, warning suppression), configures HTTP dispatch, then calls `main(process.argv.slice(2))`.
  - This is the stable CLI contract to preserve in Rust: a minimal launcher + shared orchestrator.

- **Hand-rolled argv parsing with explicit buckets**
  - `packages/coding-agent/src/cli/args.ts` parses into a structured `Args` object with:
    - known flags (`help`, `version`, `mode`, `print`, `continue`, `resume`, etc.)
    - positional `messages`
    - `@file` inputs in `fileArgs`
    - extension-owned `unknownFlags: Map<string, boolean | string>`
    - parser `diagnostics`
  - The parser is intentionally permissive and single-pass.

- **Mode dispatch is a small named decision layer**
  - `packages/coding-agent/src/main.ts` uses `resolveAppMode()` + `toPrintOutputMode()` and then branches into:
    - `runRpcMode(runtime)`
    - `InteractiveMode(...).run()`
    - `runPrintMode(runtime, ...)`
  - `rpc` is the most isolated path; `interactive` is the default; `print/json` are headless exits.

- **Pre-dispatch subcommands are handled before mode parsing**
  - `handlePackageCommand(args)` and `handleConfigCommand(args)` run before `parseArgs()`.
  - This means package/config commands are a separate CLI layer, not “modes”.

- **Startup/exit behavior is stdout/stderr-sensitive**
  - `takeOverStdout()` is enabled for non-interactive paths.
  - `stdout-cleanliness.test.ts` asserts non-interactive help stays off stdout and routes startup chatter to stderr.
  - `main.ts` also special-cases `--help`, `--version`, `--export`, and RPC stdin handling.

## 2. Variations / exceptions

- **`--mode json` is still a distinct app mode, not just print**
  - `resolveAppMode()` distinguishes `"json"` from `"print"`; both use headless output, but `json` preserves a different output contract via `toPrintOutputMode()`.

- **`--help` and `--version` are parsed first, but executed later**
  - `parseArgs()` records them alongside other args; `main()` decides when to exit.
  - This means parse order and execution order are intentionally decoupled.

- **`-p` has special token consumption**
  - In `parseArgs()`, `-p` can absorb the next token as a prompt unless it looks like a normal option.
  - Tests explicitly preserve the YAML-frontmatter edge case.

- **Unknown long flags are preserved, not rejected**
  - `--foo bar` becomes `unknownFlags.set("foo", "bar")`.
  - This is a compatibility hook for extension-provided CLI flags.

- **RPC mode rejects `@file` inputs**
  - `main.ts` explicitly errors on `--mode rpc` with `fileArgs`.
  - That’s a hard boundary worth preserving.

## 3. Anti-patterns or risks

- **High coupling to process globals**
  - `process.stdin.isTTY`, `process.stdout`, `process.env`, and `process.exit()` are all part of the contract.
  - Rust port needs an explicit policy for these side effects.

- **Behavior depends on dispatch order**
  - Package/config commands short-circuit before generic arg parsing.
  - Help/version/export also bypass later runtime setup.
  - Reordering can silently change behavior.

- **`parseArgs()` is permissive in ways that hide errors**
  - Some malformed inputs become warnings/unknown flags instead of hard failures.
  - That’s flexible, but easy to break when rewriting parser semantics.

- **Mode logic is split across parser, dispatcher, and runtime**
  - Some decisions happen in `parseArgs()`, some in `resolveAppMode()`, and some much later in `main()`.
  - This makes parity testing important during migration.

- **Headless vs interactive output is fragile**
  - stdout/stderr routing is a tested behavior, not an implementation detail.
  - Any Rust rewrite must preserve “quiet stdout” behavior for non-interactive commands.

## 4. Evidence index

- `packages/coding-agent/src/cli.ts`
  - thin entrypoint, startup side effects, `main(process.argv.slice(2))`

- `packages/coding-agent/src/cli/args.ts`
  - `Args`, `Mode`, `parseArgs()`, `printHelp()`, `unknownFlags`, `diagnostics`, `-p` behavior

- `packages/coding-agent/src/main.ts`
  - `resolveAppMode()`, `toPrintOutputMode()`, `handlePackageCommand()`, `handleConfigCommand()`, `runRpcMode()`, `InteractiveMode`, `runPrintMode()`, `takeOverStdout()`, `restoreStdout()`

- `packages/coding-agent/src/package-manager-cli.ts`
  - subcommand parsing/dispatch (`install`, `remove`, `update`, `list`, `uninstall` alias)

- `packages/coding-agent/src/modes/index.ts`
  - mode exports (`InteractiveMode`, `runPrintMode`, `runRpcMode`)

- `packages/coding-agent/test/args.test.ts`
  - parser parity coverage (`--help`, `--version`, `-p`, `--mode rpc`, `unknownFlags`, comma lists)

- `packages/coding-agent/test/stdout-cleanliness.test.ts`
  - stdout/stderr routing contract for non-interactive help paths
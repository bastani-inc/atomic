## Partition 4: CLI entrypoint, argument parsing, and mode dispatch parity

### Locator
## 1. Must-read paths

- `packages/coding-agent/src/cli.ts`  
  Top CLI entrypoint (`process.title`, env marker, HTTP dispatcher, then `main(process.argv.slice(2))`).

- `packages/coding-agent/src/main.ts`  
  Real dispatch layer: handles `--version`, `--help`, `--export`, `--mode rpc/json`, `--print`, stdin-driven mode switching, session/model/runtime setup, and routes into interactive/print/RPC.

- `packages/coding-agent/src/cli/args.ts`  
  Argument parser and help text. This is the main parity surface for Rust CLI flags/options.

- `packages/coding-agent/src/package-manager-cli.ts`  
  Early subcommand dispatcher for `install/remove/update/list/config` before normal mode parsing.

- `packages/coding-agent/README.md`  
  Canonical user-facing CLI reference (`modes`, `session options`, `package commands`, `--list-models`, `--export`, etc.).

- `packages/coding-agent/test/args.test.ts`  
  Direct parser contract for flag precedence, shorthands, unknown flags, file args, and mode-related parsing.

- `packages/coding-agent/test/print-mode.test.ts`  
  Headless output-mode behavior; useful for Rust `print`/`json` parity.

- `packages/coding-agent/test/rpc.test.ts`  
  RPC mode behavior and protocol expectations.

- `packages/coding-agent/test/interactive-mode-startup-banner.test.ts`  
  Interactive startup surface; useful if Rust changes startup routing/UI initialization.

## 2. Supporting paths

- `packages/coding-agent/src/modes/index.ts`  
  Mode exports (`InteractiveMode`, `runPrintMode`, `runRpcMode`) that `main.ts` dispatches to.

- `packages/coding-agent/src/modes/print-mode.ts`  
  Non-interactive execution path.

- `packages/coding-agent/src/modes/rpc/`  
  RPC runtime and transport surface.

- `packages/coding-agent/src/modes/interactive/`  
  Interactive TUI path that `main.ts` selects when no print/RPC mode applies.

- `packages/coding-agent/src/config.ts`  
  CLI/runtime constants: `APP_NAME`, `.atomic` vs `.pi`, env vars, version strings.

- `docs/ci.md`  
  Confirms `atomic` binary shape and what the shipped CLI must preserve.

- `packages/coding-agent/test/package-command-paths.test.ts`  
  Likely covers command routing/path handling for package subcommands.

- `packages/coding-agent/test/config.test.ts`  
  Likely covers config/env/path behavior that affects CLI startup and dispatch.

## 3. Entry points / symbols

- `cli.ts` → `main(process.argv.slice(2))`
- `main(args: string[], options?: MainOptions)`
- `parseArgs(args: string[]): Args`
- `printHelp(extensionFlags?: ExtensionFlag[]): void`
- `resolveAppMode(parsed, stdinIsTTY): AppMode`
- `resolveExcludedToolsForAppMode(appMode, excludedTools)`
- `handlePackageCommand(args: string[]): Promise<boolean>`
- `handleConfigCommand(args: string[]): Promise<boolean>`
- `runPrintMode(...)`
- `runRpcMode(...)`
- `InteractiveMode`
- `Args` / `Mode` / `AppMode`

## 4. Gaps or uncertainty

- I verified the main dispatch flow and parser, but not every `package-manager-cli.ts` subcommand branch in detail.
- `README.md` is helpful for intended CLI parity, but it may lag behind code in some edge cases.
- I did not fully verify whether `--mode json` is always treated as print-style headless execution in every code path, beyond `resolveAppMode` and `toPrintOutputMode`.
- I did not inspect all mode tests, so some CLI behavior may only be covered indirectly by integration fixtures.

### Pattern Finder
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

### Analyzer
# 1. Behavioral model

This partition is the **top-level CLI router**.

- `src/cli.ts` is the executable entrypoint:
  - sets `process.title`
  - sets an env marker (`<APP_NAME>_CODING_AGENT=true`)
  - disables `process.emitWarning`
  - configures the HTTP dispatcher
  - hands off to `main(process.argv.slice(2))`

- `src/main.ts` is the real dispatcher:
  1. applies offline env behavior
  2. intercepts **package commands** (`install/remove/update/list/uninstall`)
  3. intercepts **config**
  4. parses normal CLI args
  5. resolves mode: `interactive | print | json | rpc`
  6. creates session/runtime/services
  7. routes to `InteractiveMode`, `runPrintMode`, or `runRpcMode`

- `src/cli/args.ts` defines the user-facing flag grammar and precedence:
  - positional messages
  - `@file` inputs
  - unknown long flags preserved for extensions
  - shorthand flags for help/version/print/etc.

- `src/package-manager-cli.ts` is a separate early dispatcher for package operations, including self-update logic.

# 2. Key flows and invariants

## Dispatch order matters
The CLI does **not** parse everything first.

1. `handlePackageCommand(args)`
2. `handleConfigCommand(args)`
3. `parseArgs(args)`

So `atomic install ...` never reaches normal mode resolution.

## Mode selection
`resolveAppMode(parsed, stdinIsTTY)` behaves like:

- `--mode rpc` → `rpc`
- `--mode json` → `json`
- `--print` or piped stdin → `print`
- otherwise → `interactive`

Important invariant: **non-TTY stdin forces print mode**, unless RPC is explicitly selected.

## Output/tool gating
`resolveExcludedToolsForAppMode()` adds `ask_user_question` to excluded tools in `print/json` modes.

So headless modes are intentionally less interactive.

## Session creation is deferred until cwd/session is resolved
`createSessionManager()` handles:

- `--no-session`
- `--fork`
- `--session`
- `--resume`
- `--continue`

Edge behavior:
- `--fork` conflicts with `--session`, `--continue`, `--resume`, `--no-session`
- `--session` can resolve by path, local session ID prefix, or global session ID prefix
- a global session in another project may prompt interactively to fork into the current project

## Runtime creation depends on resolved session cwd
This is a key invariant:

- session/project-local settings, resources, models, and extensions are resolved **after** the target session cwd is known
- startup settings are only used to locate session storage

This matters for Rust parity because session selection and project-local config resolution are coupled.

## CLI model precedence
`buildSessionOptions()` applies model selection in this order:

1. explicit `--model` / `--provider --model`
2. saved default model if it’s in scope
3. first scoped model
4. explicit `--thinking` overrides thinking level
5. scoped models are preserved for ctrl+p cycling

So model selection is not just “pick one”; it also builds a cycling scope.

## Startup behavior by mode
- `interactive`: initializes TUI, may show deprecation warnings, may print model scope
- `print/json`: runs headless prompt execution
- `rpc`: uses stdin as JSON-RPC transport; `@file` args are rejected

## Error handling pattern
Most failures are handled by:
- printing a colored error
- setting `process.exitCode = 1` or calling `process.exit(1)`

Some paths exit immediately:
- invalid CLI combos
- missing session cwd in non-interactive mode
- unsupported RPC file args
- no models in non-interactive mode

# 3. Tests / validation

Current coverage is decent for parser and package commands, with some mode tests.

## Strongly covered
- `test/args.test.ts`
  - help/version/print parsing
  - `@file` args
  - unknown long flags
  - tool flags, extensions, skills, themes, models, etc.

- `test/package-command-paths.test.ts`
  - package command routing
  - local path handling
  - help/errors
  - update/self-update edge cases

- `test/print-mode.test.ts`
  - headless execution behavior
  - shutdown event emission
  - error propagation
  - stale-output suppression

- `test/rpc.test.ts`
  - RPC startup and session behavior
  - session file persistence
  - tool execution and state API

## Gaps
Not clearly covered here:
- `cli.ts` wrapper behavior itself
- exact precedence between `--print`, piped stdin, and `--mode`
- all session-selection branches
- interactive prompt to fork from another project
- full package-command matrix for invalid combinations

# 4. Risks, unknowns, and verification steps

## Main Rust migration risks
1. **Argument grammar drift**
   - parsing is hand-rolled, not declarative
   - Rust parser must preserve quirks like `-p` consuming a following prompt unless it looks like a normal flag

2. **Mode precedence coupling**
   - print mode can be triggered by stdin even without `--print`
   - RPC is special because stdin is reserved

3. **Session cwd resolution**
   - runtime cannot be created until session/project locality is known
   - this affects config, models, extensions, and resources

4. **Package subcommands are pre-parse**
   - `install/remove/update/list/config` are effectively separate CLIs

5. **Unknown long flags are preserved**
   - likely extension ABI surface; Rust needs an equivalent extensibility story

## Unknowns to verify
- Whether `--mode json` is always semantically identical to print mode except output formatting
- Exact behavior of `--continue` vs `--session`/`--fork` in all edge cases
- Whether all interactive-only prompts are fully bypassed in headless modes
- Whether every extension flag from `unknownFlags` is consumed later by extension loading

## Verification steps
- Reproduce parser outputs against `test/args.test.ts`
- Re-run package-command tests after any parser rewrite
- Validate `print`, `json`, and `rpc` startup paths separately
- Test stdin-driven print fallback and RPC stdin exclusivity
- Test cross-project session resolution/fork prompt behavior

### Online Researcher
## 1. Relevant external facts

- **Rust receives argv via `std::env::args()` / `args_os()`**. The first element is the executable path but should not be relied on; `args_os()` preserves raw OS strings better for file paths and non-UTF-8 input. Source: Rust std docs for `std::env::args` and `ArgsOs`.
- **`clap` 4 parses flags, values, positional args, and subcommands with explicit precedence rules.** In particular, `--help` / `--version` are built-in unless disabled, subcommands are first-class commands, and parsing stops into a matched subcommand. Source: `clap::Command` docs and `_concepts` docs.
- **`clap` can auto-handle help/version, but `try_get_matches*` returns errors instead of exiting** for help/version display. Source: `clap::Command::try_get_matches_from`.
- **`clap` has a `subcommand_precedence_over_arg` setting** for cases where an option with multiple values could otherwise greedily consume a subcommand. Source: `clap::Command` docs / changelog.
- **Builtin `--help`/`--version` behavior is configurable** via `disable_help_flag`, `disable_version_flag`, and custom actions. Source: `clap::Command` docs/changelog.

## 2. Local implications

- Your TS CLI does **manual dispatch before full parsing**:
  1. package commands (`install/remove/update/list`)
  2. config command
  3. global args parse
  4. mode resolution (`interactive` / `print` / `json` / `rpc`)
- The Rust version must preserve that **early command routing** or behavior will diverge.
- `--version`, `--help`, and `--export` are handled **after runtime setup** in current TS code, so the Rust port should confirm whether to keep that timing or intentionally move them earlier.
- Mode dispatch depends on **stdin TTY status**:
  - `--mode rpc` wins
  - `--mode json` wins
  - otherwise `--print` or piped stdin forces print mode
  - else interactive
- `@file` args are accepted in normal modes but **rejected in RPC mode**.
- Unknown long flags are currently collected into `unknownFlags` for extension consumption; short unknown flags become errors. Rust parsing should preserve that asymmetry.
- The parser currently has some **non-clap custom precedence**:
  - `--print` may consume the following token as a message unless it looks like a flag/file arg
  - `--list-models` optionally consumes a search term
  - `--thinking` validates against a fixed set and emits warnings instead of hard-failing
- `process.argv.slice(2)` means the TS CLI ignores argv[0]; Rust should similarly parse only user args.

## 3. Version/API assumptions

- I’m assuming **`clap` 4.x** if you choose it for the Rust rewrite.
- I’m assuming Rust CLI entry uses `std::env::args_os()` (or equivalent) plus explicit skipping of argv[0].
- I’m assuming you want **behavioral parity first**, not a redesign of the CLI contract.

## 4. Unverified or unnecessary research

- I did **not** verify which Rust CLI crate you’ll use (`clap`, `argh`, `bpaf`, custom parser, etc.).
- I did **not** inspect every subcommand branch in `package-manager-cli.ts`; the main parity surface is clear enough for this partition.
- I did **not** research shell-completion or Windows-specific argv quirks beyond what affects basic parsing parity.
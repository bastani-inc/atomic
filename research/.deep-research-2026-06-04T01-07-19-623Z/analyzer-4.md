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
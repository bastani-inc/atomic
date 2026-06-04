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
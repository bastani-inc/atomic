/**
 * Argv side-effect that auto-dispatches the SDK's internal sub-commands
 * (`_orchestrator-entry`, `_cc-debounce`).
 *
 * Imported at the top of `primitives/run.ts` so any host that calls
 * `runWorkflow` (directly or via a barrel re-export) loads this module
 * during its startup import chain. When `process.argv[2]` matches one
 * of the internal sub-command names, the side-effect runs the
 * sub-command and exits — before the host's CLI parser sees argv. This
 * is what lets compiled third-party hosts work with no boilerplate.
 *
 * Behavior:
 *   `_orchestrator-entry`
 *     - Try `runOrchestratorEntry(source, workflowName, agent, inputsB64)`.
 *     - On `InvalidWorkflowError`, fall through silently. Atomic's
 *       compiled binary collapses every bundled module's
 *       `import.meta.path` to the binary entry, so the SDK's
 *       source-path dynamic-import legitimately can't resolve atomic's
 *       builtin workflows. Atomic's hidden Commander handler picks up
 *       the dispatch via `createBuiltinRegistry().resolve(name, agent)`.
 *     - Any other failure is fatal — log to stderr and `exit 1`.
 *
 *   `_cc-debounce`
 *     - Run `runCcDebounce(paneId)` and exit with its return code.
 *
 * The token-gated `_emit-workflow-meta` and `_atomic-run` sub-commands
 * are handled by `hostWorkflows()` in `./host-workflows.ts`, which the
 * user calls explicitly AFTER their `compile()` calls so the workflow
 * registry is populated at dispatch time.
 *
 * Non-matching argv is a single string compare with no async cost. The
 * matching cases top-level-await the dispatch and exit.
 *
 * `validateDispatchToken`, `findSub`, `parseAtomicRunArgv`, and
 * `AtomicRunArgs` are exported for use by `host-workflows.ts` and for
 * unit testing.
 */

// ─── Token-gating helper ─────────────────────────────────────────────────────

/** Minimum length of a valid dispatch token (32 hex chars = 16 bytes). */
const MIN_TOKEN_HEX_LEN = 32;

/** Pattern matching a valid hex token (0-9 a-f only, case-insensitive). */
const HEX_RE = /^[0-9a-f]+$/i;

/**
 * Validate that the dispatch token is present and consistent between
 * `process.env` and `process.argv`.
 *
 * Rules (all must pass):
 *   1. `env.ATOMIC_HOST === "1"`
 *   2. `env.ATOMIC_DISPATCH_TOKEN` is a hex string >= 32 chars.
 *   3. `argv` contains `--dispatch-token=<hex>` where `<hex>` matches
 *      the env token (case-insensitive) and is >= 32 chars.
 *
 * Exported so it can be unit-tested without spawning a subprocess.
 */
export function validateDispatchToken(
  env: Record<string, string | undefined>,
  argv: readonly string[],
): boolean {
  if (env["ATOMIC_HOST"] !== "1") return false;

  const envToken = env["ATOMIC_DISPATCH_TOKEN"] ?? "";
  if (envToken.length < MIN_TOKEN_HEX_LEN || !HEX_RE.test(envToken)) {
    return false;
  }

  const prefix = "--dispatch-token=";
  const tokenArg = argv.find((a) => a.startsWith(prefix));
  if (!tokenArg) return false;

  const argToken = tokenArg.slice(prefix.length);
  if (argToken.length < MIN_TOKEN_HEX_LEN || !HEX_RE.test(argToken)) {
    return false;
  }

  return argToken.toLowerCase() === envToken.toLowerCase();
}

// ─── Subcommand scanning ─────────────────────────────────────────────────────

/**
 * Known internal sub-commands that auto-dispatch.ts handles.
 * A Set lookup is O(1) and avoids false matches on positional arguments that
 * happen to share a name with a sub-command token.
 */
const SUBS = new Set([
  "_orchestrator-entry",
  "_cc-debounce",
]);

/**
 * Scan `argv` starting at index 2 (the position after the runtime and script
 * tokens) for the first token that matches a known sub-command.
 *
 * Returns the sub-command string and its index, or `null` when none is found.
 *
 * Exported so tests can verify the scan logic directly without spawning a
 * subprocess.
 */
export function findSub(argv: readonly string[]): { sub: string; index: number } | null {
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i]!;
    if (SUBS.has(tok)) return { sub: tok, index: i };
  }
  return null;
}

// ─── Argv parser for _atomic-run ─────────────────────────────────────────────

/** Parsed result from `parseAtomicRunArgv`. */
export interface AtomicRunArgs {
  name: string | undefined;
  agent: string | undefined;
  detach: boolean;
  inputs: Record<string, string>;
}

/**
 * Parse the flags that follow the `_atomic-run` subcommand token.
 *
 * `argv` should be the slice of `process.argv` starting immediately after the
 * `_atomic-run` token (i.e. `process.argv.slice(subIndex + 1)`).
 *
 * Contract (mirrors atomic-side dispatcher):
 *   - `--name <value>` — workflow name (required by caller)
 *   - `--agent <value>` — agent name (required by caller)
 *   - `--detach` — boolean flag
 *   - `--dispatch-token=<hex>` — consumed by validateDispatchToken; skipped here
 *   - `--<key> <value>` — workflow input; value consumed unconditionally so that
 *     values starting with `--` (e.g. `--rev origin/main`) are preserved correctly.
 *
 * Reserved flags (`--name`, `--agent`, `--detach`, `--dispatch-token=`) are
 * matched in earlier branches, so the generic input branch only fires for
 * user-defined input names.
 *
 * Exported for unit testing.
 */
export function parseAtomicRunArgv(argv: readonly string[]): AtomicRunArgs {
  let name: string | undefined;
  let agent: string | undefined;
  let detach = false;
  const inputs: Record<string, string> = {};

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--name" && i + 1 < argv.length) {
      name = argv[++i];
    } else if (tok === "--agent" && i + 1 < argv.length) {
      agent = argv[++i];
    } else if (tok === "--detach") {
      detach = true;
    } else if (tok.startsWith("--dispatch-token=")) {
      // Already consumed by validateDispatchToken — skip.
    } else if (tok.startsWith("--") && i + 1 < argv.length) {
      // Atomic-side dispatcher always emits --<key> <value>; consume unconditionally.
      inputs[tok.slice(2)] = argv[++i]!;
    }
  }

  return { name, agent, detach, inputs };
}

// ─── Argv dispatch ────────────────────────────────────────────────────────────

const found = findSub(process.argv);

if (found?.sub === "_orchestrator-entry") {
  // Arguments follow immediately after the sub-command token, in the same
  // order the executor emits them: [workflowName, agent, inputsB64, source].
  const workflowName = process.argv[found.index + 1] ?? "";
  const agent = process.argv[found.index + 2] ?? "";
  const inputsB64 = process.argv[found.index + 3] ?? "";
  const source = process.argv[found.index + 4] ?? "";
  try {
    const { runOrchestratorEntry } = await import(
      "../runtime/orchestrator-entry.ts"
    );
    await runOrchestratorEntry(source, workflowName, agent, inputsB64);
    process.exit(0);
  } catch (err) {
    const { InvalidWorkflowError } = await import("../errors.ts");
    if (err instanceof InvalidWorkflowError) {
      // Source path didn't resolve to a workflow module. Typical when
      // the host's bundler collapsed `import.meta.path` to the binary
      // entry (atomic's own compiled CLI). Defer to the host's command
      // parser — it likely has a registry-aware fallback registered.
      if (process.env.ATOMIC_DEBUG === "1") {
        process.stderr.write(
          `[atomic-sdk:auto-dispatch] InvalidWorkflowError; deferring to host argv parser\n`,
        );
      }
    } else {
      const msg = err instanceof Error ? err.stack ?? err.message : String(err);
      process.stderr.write(`[atomic-sdk:_orchestrator-entry] ${msg}\n`);
      process.exit(1);
    }
  }
} else if (found?.sub === "_cc-debounce") {
  const paneId = process.argv[found.index + 1] ?? "";
  const { runCcDebounce } = await import("../runtime/cc-debounce.ts");
  process.exit(runCcDebounce(paneId));
}

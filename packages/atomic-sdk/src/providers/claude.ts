/**
 * Claude Code query abstraction.
 *
 * Sends a prompt to an interactive Claude Code session running in a tmux pane
 * using `tmux send-keys -l --` (literal text) + `C-m` (raw carriage return).
 * Verifies delivery by polling `capture-pane` and retries if needed.
 *
 * This is NOT headless — Claude runs as a full interactive TUI in the pane.
 * We're automating keyboard input and reading pane output.
 *
 * Reliability hardened from oh-my-codex's sendToWorker implementation:
 * - Pre-send readiness wait with exponential backoff
 * - CLI-specific submit plan (Claude: 1 C-m per round)
 * - Per-round capture verification (6 rounds)
 * - Adaptive retry with C-u clear + retype
 * - Post-submit active-task detection
 * - File-based idle detection via session JSONL watching
 */

import {
  getSessionMessages,
  query as sdkQuery,
  type SessionMessage,
  type SDKUserMessage,
  type Options as SDKOptions,
} from "@anthropic-ai/claude-agent-sdk";
import { respawnPane } from "../runtime/tmux.ts";
import { escBash } from "../runtime/executor.ts";
import { watch, unlink, mkdir, writeFile } from "node:fs/promises";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDevCliPkgRoot } from "../lib/workspace-paths.ts";
import { isInstalledPackage } from "../lib/runtime-env.ts";
import { randomUUID } from "node:crypto";
import { claudeHookDirs } from "./claude-stop-hook.ts";
import {
  clearInflightTracking,
  waitForInflightDrained,
} from "./claude-inflight-hook.ts";
import { resolveAdditionalInstructionsContent } from "../services/config/additional-instructions.ts";
import {
  atomicContentTempPath,
  atomicTempPath,
  withAtomicTempEnv,
} from "../lib/atomic-temp.ts";

// ---------------------------------------------------------------------------
// Session tracking — ensures createClaudeSession is called before claudeQuery
// ---------------------------------------------------------------------------

/** Per-pane state for Claude sessions. */
interface PaneState {
  /**
   * Claude Code's session ID. Pre-generated via `crypto.randomUUID()` in
   * `createClaudeSession` and passed to `claude --session-id <UUID>` on the
   * first query, so we know the JSONL filename without polling.
   */
  claudeSessionId: string;
  /** Whether the `claude` CLI has been spawned in this pane yet. */
  claudeStarted: boolean;
  /** CLI flags to pass to `claude` when it is spawned on the first query. */
  chatFlags: string[];
}

const initializedPanes = new Map<string, PaneState>();

/**
 * Remove a pane from the initialized map and signal the currently-blocked
 * Stop hook that the session is over, so Claude stops promptly instead of
 * waiting out the hook's safety timeout.
 *
 * Called by the runtime when a Claude stage is being torn down. Idempotent.
 *
 * After writing the release marker, this waits for the per-session in-flight
 * marker dir (`~/.atomic/claude-inflight/<session_id>/`) to drain. The
 * marker dir is populated by the SubagentStart/Stop and TaskCreated/Completed
 * hooks registered in {@link WORKFLOW_HOOK_SETTINGS}. This wait is the
 * synchronization barrier that prevents the executor from advancing to the
 * next stage while the previous stage's backgrounded subagents/tasks still
 * hold FDs/PTYs on the atomic tmux server — the failure mode that surfaced
 * intermittently as `tmux respawn-pane: fork failed: Device not configured`.
 *
 * The wait has its own bounded timeout (default 30 minutes) so a wedged
 * subagent can't permanently block the workflow; the in-hook stale-sweep
 * (~2 hours TTL) is the ultimate safety net.
 */
export async function clearClaudeSession(paneId: string): Promise<void> {
  const state = initializedPanes.get(paneId);
  if (state) {
    try {
      await releaseClaudeSession(state.claudeSessionId);
    } catch {
      // Best-effort — if release fails the hook will still exit on its
      // own safety timeout.
    }
    // Wait for in-flight subagents/tasks to finish before letting the
    // executor advance. Resolves immediately when the dir is empty/missing
    // (the common case, including any stage that didn't spawn subagents).
    try {
      await waitForInflightDrained(state.claudeSessionId);
    } catch {
      // Best-effort — the wait swallows internal errors and resolves on
      // timeout. A throw here would only happen on a path bug.
    }
    try {
      await unlinkAtomicPidFile(state.claudeSessionId);
    } catch {
      // Best-effort — stale pid file is inert; the next session writes a
      // fresh one under its own UUID.
    }
    try {
      await clearStaleReadyMarker(state.claudeSessionId);
    } catch {
      // Best-effort — stale ready marker is inert; the next session writes
      // a fresh one under its own UUID and clears any prior leftover in
      // `claudeQuery` before respawn.
    }
    try {
      await clearInflightTracking(state.claudeSessionId);
    } catch {
      // Best-effort — leftover marker files are reaped by the next session's
      // stale-sweep, and the .session-roots/ entries are tiny.
    }
  }
  initializedPanes.delete(paneId);
}

/** Default CLI flags passed to the `claude` command. */
const DEFAULT_CHAT_FLAGS = [
  "--allow-dangerously-skip-permissions",
  "--dangerously-skip-permissions",
];

/**
 * Build the shell command Claude Code runs from an injected workflow hook.
 *
 * - **Published install** (`node_modules` or `bun build --compile` binary):
 *   resolve `atomic` via the user's PATH. Robust across shells and platforms.
 * - **Dev** (source checkout): re-invoke THIS repo's `src/cli.ts` using the
 *   same Bun runtime that's executing us, so edits to the hook logic are
 *   picked up without rebuilding or re-linking. Mirrors the
 *   `spawnAttachedFooter` pattern in `src/sdk/runtime/executor.ts:293-303`.
 */
function buildWorkflowHookCommand(subcommand: string, extraArgs: readonly string[] = []): string {
  const onPath = ["atomic", subcommand, ...extraArgs].join(" ");

  if (isInstalledPackage(import.meta.dir)) return onPath;

  const devCliRoot = getDevCliPkgRoot();
  if (!devCliRoot) return onPath;

  const runtime = process.execPath;
  const cliPath = join(devCliRoot, "src", "cli.ts");
  if (process.platform === "win32") {
    const script = [
      quotePwshLiteral(runtime),
      quotePwshLiteral(cliPath),
      quotePwshLiteral(subcommand),
      ...extraArgs.map(quotePwshLiteral),
    ].join(" ");
    const encoded = Buffer.from(`& ${script}`, "utf16le").toString("base64");
    return `pwsh -NoProfile -EncodedCommand ${encoded}`;
  }
  return [
    `"${escBash(runtime)}"`,
    `"${escBash(cliPath)}"`,
    subcommand,
    ...extraArgs,
  ].join(" ");
}

function quotePwshLiteral(s: string): string {
  return `'${s
    .replace(/\x00/g, "")
    .replace(/[\n\r]+/g, " ")
    .replace(/'/g, "''")}'`;
}

/**
 * Effectively-unbounded timeout (in seconds) for the Stop hook command.
 *
 * Claude Code's Stop hook process runs three phases sequentially — the
 * initial Stop hooks, then TaskCompleted hooks (per in-progress task owned
 * by the teammate), then TeammateIdle hooks — and the per-hook `timeout`
 * applies to the entire lifecycle. Under Claude Code's default (10 min),
 * a turn that leaves tasks in-progress (e.g. via the TaskList/TodoWrite
 * tool) can blow the budget and get killed, which also severs our
 * `_claude-stop-hook`'s queue/release poll and strands the workflow.
 *
 * ~24 days — the max safe `setTimeout` value (2^31 - 1 ms) expressed in
 * seconds — removes the timeout in practical terms. `waitForIdle`'s
 * marker-file watch still fires as soon as our initial hook writes the
 * marker, so the workflow proceeds on real hook completion, not on timer
 * expiry.
 */
const STOP_HOOK_TIMEOUT_SECONDS = 2_147_483;

/**
 * Effectively-unbounded ms ceiling for `waitForReadyMarker`. Mirrors
 * {@link STOP_HOOK_TIMEOUT_SECONDS} but expressed in ms for `setTimeout`.
 *
 * The SessionStart hook fires well under a second on a working spawn, so in
 * practice this timer never expires. It only protects against failure modes
 * where the hook will never fire at all (claude binary missing, hook
 * command not resolvable, settings JSON rejected), where a clear error
 * beats a hung pane.
 */
const READY_HOOK_TIMEOUT_MS = 2_147_483_000;

/**
 * Inline settings injected via `claude --settings <json>` on every workflow
 * spawn. Registers the workflow-owned hooks without relying on
 * `.claude/settings.json` — so the hooks fire only for workflow-spawned
 * Claude sessions, not when a user runs `claude` manually.
 *
 * Registered hooks:
 *   - `Stop`: deliver queued follow-up prompts via `{decision:"block"}` and
 *     write an idle-marker file that `waitForIdle` watches. `timeout` is
 *     set to {@link STOP_HOOK_TIMEOUT_SECONDS} so the hook survives long
 *     TaskCompleted/TeammateIdle phases — see the constant's docstring.
 *   - `PreToolUse` matched on `AskUserQuestion`: write
 *     `~/.atomic/claude-hil/<session_id>` so `watchHILMarker` can fire
 *     `onHIL(true)` — the node card flips to the blue "awaiting_input" pulse.
 *   - `PostToolUse` / `PostToolUseFailure` matched on `AskUserQuestion`:
 *     remove the HIL marker. Claude Code fires exactly one of these per
 *     tool invocation (PostToolUse on success, PostToolUseFailure in the
 *     catch path — see `src/services/tools/toolExecution.ts` in the CLI
 *     source), so registering the same command on both guarantees the
 *     marker clears regardless of which completion path the tool takes.
 *   - `SubagentStart` / `SubagentStop`: maintain a per-root-session marker
 *     dir under `~/.atomic/claude-inflight/<root>/` so the Stop hook and
 *     `clearClaudeSession` can both gate on subagent completion before
 *     letting the stage advance. Without this gate, a stage that spawned
 *     `run_in_background: true` subagents would tear down its pane while
 *     children still hold FDs/PTYs on the atomic tmux server, intermittently
 *     surfacing as `tmux respawn-pane: fork failed: Device not configured`
 *     when the next stage tried to spawn.
 *   - `TeammateIdle`: same gating applied at agent-team teammate idle.
 *     Unlike Stop, this fires when a teammate (potentially a different
 *     `session_id` from the stage's root) goes idle, so we route it to a
 *     focused `_claude-inflight-hook wait` mode that only awaits in-flight
 *     drain — no claude-stop marker write (that would confuse `waitForIdle`)
 *     and no queue/release polling (those are keyed on the stage's root).
 *
 * Built once at module load. Contains no single quotes (JSON syntax doesn't
 * produce them and paths rarely do), so POSIX single-quoting at the spawn
 * site is sufficient shell escaping.
 */
const WORKFLOW_HOOK_SETTINGS = JSON.stringify({
  hooks: {
    SessionStart: [
      {
        matcher: "startup",
        hooks: [
          {
            type: "command",
            command: buildWorkflowHookCommand("_claude-session-start-hook"),
          },
        ],
      },
    ],
    Stop: [
      {
        hooks: [
          {
            type: "command",
            command: buildWorkflowHookCommand("_claude-stop-hook"),
            timeout: STOP_HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
    PreToolUse: [
      {
        matcher: "AskUserQuestion",
        hooks: [
          {
            type: "command",
            command: buildWorkflowHookCommand("_claude-ask-hook", ["enter"]),
          },
        ],
      },
    ],
    PostToolUse: [
      {
        matcher: "AskUserQuestion",
        hooks: [
          {
            type: "command",
            command: buildWorkflowHookCommand("_claude-ask-hook", ["exit"]),
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        matcher: "AskUserQuestion",
        hooks: [
          {
            type: "command",
            command: buildWorkflowHookCommand("_claude-ask-hook", ["exit"]),
          },
        ],
      },
    ],
    // SubagentStart/SubagentStop fire per Agent-tool dispatch (no matcher)
    // and route to a single subcommand that touches/removes one marker file
    // per `agent_id`. The handler is bulletproof — any error exits 0
    // silently — so a hook failure can't kill the stage.
    SubagentStart: [
      {
        hooks: [
          {
            type: "command",
            command: buildWorkflowHookCommand("_claude-inflight-hook", ["start"]),
          },
        ],
      },
    ],
    SubagentStop: [
      {
        hooks: [
          {
            type: "command",
            command: buildWorkflowHookCommand("_claude-inflight-hook", ["stop"]),
          },
        ],
      },
    ],
    // TeammateIdle gets a focused `wait` mode (gates on in-flight drain,
    // nothing else) — see the WORKFLOW_HOOK_SETTINGS docstring for why this
    // doesn't reuse the Stop hook handler. Timeout matches Stop's so the
    // wait can run for as long as the workflow holds onto teammates.
    TeammateIdle: [
      {
        hooks: [
          {
            type: "command",
            command: buildWorkflowHookCommand("_claude-inflight-hook", ["wait"]),
            timeout: STOP_HOOK_TIMEOUT_SECONDS,
          },
        ],
      },
    ],
  },
});

// ---------------------------------------------------------------------------
// createClaudeSession
// ---------------------------------------------------------------------------

export interface ClaudeSessionOptions {
  /** tmux pane ID where Claude should be started */
  paneId: string;
  /** CLI flags to pass to the `claude` command (default: ["--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"]) */
  chatFlags?: string[];
}

/**
 * Initialize per-pane Claude state. Does NOT spawn the `claude` CLI — the
 * pane is left as a bare shell. The CLI is spawned lazily on the first
 * `claudeQuery()` call, with the prompt baked into the spawn command:
 *
 *     claude [chatFlags] --session-id <UUID> 'Read the prompt in <tmpfile>'
 *
 * Pre-generating the session UUID here lets the first query pass it to the
 * CLI, so we know the JSONL filename up front and can skip discovery polling.
 *
 * Must be called before any `claudeQuery()` calls targeting the same pane.
 *
 * @example
 * ```typescript
 * import { createClaudeSession, claudeQuery } from "@bastani/atomic/workflows";
 *
 * await createClaudeSession({ paneId: ctx.paneId });
 * await claudeQuery({ paneId: ctx.paneId, prompt: "Describe this project" });
 * ```
 *
 * @example
 * ```typescript
 * // With custom flags
 * await createClaudeSession({
 *   paneId: ctx.paneId,
 *   chatFlags: ["--model", "opus", "--dangerously-skip-permissions"],
 * });
 * ```
 */
export async function createClaudeSession(options: ClaudeSessionOptions): Promise<string> {
  const { paneId, chatFlags = DEFAULT_CHAT_FLAGS } = options;

  const claudeSessionId = randomUUID();
  initializedPanes.set(paneId, {
    claudeSessionId,
    claudeStarted: false,
    chatFlags,
  });

  // Write our PID so the Stop hook can detect an orphaned session if we
  // crash/get SIGKILL'd without running teardown. Best-effort; failures just
  // mean the hook falls back to waiting out Claude's own hook timeout.
  await writeAtomicPidFile(claudeSessionId);

  return claudeSessionId;
}

/**
 * Build the short, single-line natural-language prompt we send to Claude
 * (either as spawn argv or as a follow-up message). Claude's first action
 * is then a Read tool call against `promptFile` — which sidesteps shell
 * escaping, ARG_MAX, and tmux paste-buffer flakiness for large prompts.
 *
 * The session dir and filename are slug-based (`prompt-<N>.txt` under
 * `~/.atomic/sessions/...`), so they never contain shell-special characters.
 */
function readPromptInstruction(promptFile: string): string {
  return `Read ${promptFile} and follow the instructions inside.`;
}

/**
 * Spawn `claude` in the pane with the prompt baked in via the Read tool.
 *
 * The prompt is already written to `promptFile` by the caller. The spawn
 * argv is `'Read the prompt in <path>'`, so Claude's first action is a Read
 * tool call against that file.
 */
async function spawnClaudeWithPrompt(
  paneId: string,
  promptFile: string,
  chatFlags: string[],
  sessionId: string,
): Promise<void> {
  const settingsPath = workflowHookSettingsPath();
  const argvPrompt = `"${escBash(readPromptInstruction(promptFile))}"`;
  const cmd = [
    "claude",
    ...chatFlags,
    // Workflow-owned hooks. Placed AFTER chatFlags so commander's last-wins
    // semantics shadow any user-provided --settings, making this
    // non-overridable by `.atomic/settings.json` chatFlags overrides. Passing
    // a path avoids Claude Code's content-hashed /tmp/claude-settings*.json.
    "--settings",
    `"${escBash(settingsPath)}"`,
    "--session-id",
    sessionId,
    argvPrompt,
  ].join(" ");

  // Replace the pane's shell with `claude` directly. tmux execs the command
  // itself, so there's no shell line editor to race with — the previous
  // approach keystroked into a zsh that hadn't finished ZLE init yet, and
  // zsh's TCSAFLUSH during startup would discard the buffered `\r`, leaving
  // the command typed at the prompt but never submitted.
  respawnPane(paneId, cmd);

  // Positive readiness signal: wait for Claude's SessionStart hook (matcher
  // `startup`) to write `~/.atomic/claude-ready/<session_id>`. This fires
  // before Claude writes the JSONL transcript, so it beats the old
  // transcript-file race and is deterministic.
  await waitForReadyMarker(sessionId);
}

function workflowHookSettingsPath(): string {
  const path = atomicContentTempPath(
    "claude-settings-atomic",
    ".json",
    WORKFLOW_HOOK_SETTINGS,
  );
  writeFileSync(path, WORKFLOW_HOOK_SETTINGS, {
    encoding: "utf-8",
    mode: 0o600,
  });
  return path;
}

/**
 * Wait for the SessionStart hook's ready marker at
 * `~/.atomic/claude-ready/<session_id>`.
 *
 * `atomic _claude-session-start-hook` is registered in
 * {@link WORKFLOW_HOOK_SETTINGS} with matcher `startup`; the Claude CLI
 * dispatches it during spawn, before the first API call and before the JSONL
 * transcript is created. Waiting on the resulting marker file gives us a
 * positive "Claude is alive" signal instead of racing the transcript writer.
 *
 * The timeout only fires on catastrophic startup failure (bad binary, exec
 * error) — under load, Claude's own session bootstrap runs well under the
 * limit because SessionStart is dispatched early in the startup sequence.
 */
async function waitForReadyMarker(sessionId: string): Promise<void> {
  const { ready: readyDir } = claudeHookDirs();
  await mkdir(readyDir, { recursive: true });
  const target = join(readyDir, sessionId);

  if (existsSync(target)) return;

  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), READY_HOOK_TIMEOUT_MS);

  try {
    await Promise.race([
      // fs.watch — instant OS-native notification when the hook writes the file
      (async (): Promise<void> => {
        try {
          for await (const _event of watch(readyDir, { signal: ac.signal })) {
            // Trust disk state, not event.filename (Linux can deliver
            // unexpected basenames under tmp+rename writes).
            if (existsSync(target)) return;
          }
        } catch (e: unknown) {
          if (e instanceof Error && e.name === "AbortError") throw e;
        }
        return new Promise<void>(() => {});
      })(),

      // Polling fallback — catches dropped inotify/FSEvent notifications
      (async (): Promise<void> => {
        while (!ac.signal.aborted) {
          if (existsSync(target)) return;
          await Bun.sleep(250);
        }
        throw new DOMException("Aborted", "AbortError");
      })(),
    ]);
  } catch (e: unknown) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(
        `Timed out waiting for Claude SessionStart hook to signal readiness ` +
        `at ${target}. Verify the \`claude\` command started successfully.`,
      );
    }
    throw e;
  } finally {
    clearTimeout(timeout);
    ac.abort();
  }
}

// ---------------------------------------------------------------------------
// HIL detection helpers
// ---------------------------------------------------------------------------

/**
 * Returns true when the most recent assistant message in the transcript
 * ended with `stop_reason: "tool_use"` — i.e. the agent stopped the current
 * API response to call a tool but has not yet produced its post-tool answer.
 *
 * Claude Code's Stop hook fires each time Claude "finishes responding",
 * which includes intermediate tool-use responses in a multi-step agent
 * loop (not just the final `end_turn`). If we return from `waitForIdle`
 * on the first Stop event, we capture the transcript mid-loop — the
 * final assistant text block is still being generated and won't be on
 * disk yet, so `inbox.md` drops the actual answer.
 *
 * We keep watching until we see an assistant message with a terminal
 * stop_reason (`end_turn`, `max_tokens`, `stop_sequence`, `refusal`),
 * which is the real end of the turn.
 *
 * Exported as `_isMidAgentLoop` for unit testing.
 */
export function _isMidAgentLoop(messages: SessionMessage[]): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.type !== "assistant") continue;
    const inner = msg.message as { stop_reason?: unknown } | null;
    const stopReason = inner?.stop_reason;
    return stopReason === "tool_use";
  }
  // No assistant message yet — treat as mid-loop so we wait for one.
  return true;
}

/**
 * Watch `~/.atomic/claude-hil/` for this session's marker file and fire
 * `onHIL(true|false)` on create/unlink. Returns when `signal` is aborted.
 *
 * The marker is written by the `_claude-ask-hook enter` subcommand from
 * Claude Code's `PreToolUse` hook (matched on `AskUserQuestion`) and removed
 * by `_claude-ask-hook exit` from `PostToolUse` / `PostToolUseFailure`. That
 * makes the signal deterministic and independent of Claude Code's batched
 * JSONL flush timing, which used to hide the HIL window entirely when
 * tool_use and tool_result landed in the same file write.
 *
 * @internal Exported for tests.
 */
export async function watchHILMarker(
  claudeSessionId: string,
  onHIL: (waiting: boolean) => void,
  signal: AbortSignal,
): Promise<void> {
  const { hil: dir } = claudeHookDirs();
  const target = join(dir, claudeSessionId);

  await mkdir(dir, { recursive: true });

  let wasHIL = false;
  const emit = (isHIL: boolean): void => {
    if (isHIL !== wasHIL) {
      onHIL(isHIL);
      wasHIL = isHIL;
    }
  };

  // Attach the watcher BEFORE the initial existsSync so any event that fires
  // during the check is buffered by the iterator instead of being dropped.
  const watcher = watch(dir, { signal });

  // Polling fallback: Bun/inotify can drop events under heavy fs load, which
  // would leave the UI stuck on (or off) the blue "awaiting_input" pulse.
  // A cheap periodic existsSync guarantees eventual consistency. `emit` is
  // guarded by `wasHIL` so the interval is idempotent w.r.t. the watcher.
  const poll = setInterval(() => emit(existsSync(target)), 250);

  // Initial existsSync: handles resumed sessions whose PreToolUse marker was
  // already on disk before the watcher attached.
  if (existsSync(target)) emit(true);

  try {
    for await (const _event of watcher) {
      // Don't trust event.filename — Bun/Linux deliver inconsistent basenames
      // across OSes and write patterns. Disk existence is authoritative.
      emit(existsSync(target));
    }
  } catch (e: unknown) {
    if (!(e instanceof Error && e.name === "AbortError")) {
      throw e;
    }
  } finally {
    clearInterval(poll);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Path of the directory where the claude-stop-hook writes marker files.
 * Each Claude turn creates `~/.atomic/claude-stop/<session_id>` which
 * triggers the `fs.watch` event in `waitForIdle`.
 *
 * @internal Exported for unit tests.
 */
export function markerDir(): string {
  return claudeHookDirs().marker;
}

/**
 * Return the marker file path for a given Claude session ID.
 *
 * @internal Exported for unit tests.
 */
export function markerPath(claudeSessionId: string): string {
  return join(markerDir(), claudeSessionId);
}

/**
 * Directory where the workflow runtime writes queued follow-up prompts that
 * `atomic _claude-stop-hook` picks up and feeds back to Claude as
 * `{decision:"block", reason:<prompt>}`. @internal Exported for unit tests.
 */
export function queueDir(): string {
  return claudeHookDirs().queue;
}

/** Return the queue file path for a given Claude session ID. @internal */
export function queuePath(claudeSessionId: string): string {
  return join(queueDir(), claudeSessionId);
}

/**
 * Directory where the runtime writes session-release signals. When the Stop
 * hook sees `~/.atomic/claude-release/<session_id>` it exits 0 without
 * emitting a block decision — the signal used by `clearClaudeSession` to
 * tell Claude it's safe to actually stop. @internal Exported for unit tests.
 */
export function releaseDir(): string {
  return claudeHookDirs().release;
}

/** Return the release file path for a given Claude session ID. @internal */
export function releasePath(claudeSessionId: string): string {
  return join(releaseDir(), claudeSessionId);
}

/**
 * Ensure the marker directory exists and remove any stale marker left from a
 * previous turn of this session. Call this BEFORE submitting the prompt so
 * the subsequent `waitForIdle` watch loop doesn't fire on a stale file.
 *
 * Ignores ENOENT on `unlink` — the file simply doesn't exist yet.
 */
async function clearStaleMarker(claudeSessionId: string): Promise<void> {
  await mkdir(markerDir(), { recursive: true });
  try {
    await unlink(markerPath(claudeSessionId));
  } catch (e: unknown) {
    // ENOENT is expected — ignore it; rethrow anything else
    if (!(e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT")) {
      throw e;
    }
  }
}

/**
 * Ensure the queue directory exists and remove any stale entry from a prior
 * turn so the Stop hook doesn't race on it. Ignores ENOENT.
 */
async function clearStaleQueue(claudeSessionId: string): Promise<void> {
  await mkdir(queueDir(), { recursive: true });
  try {
    await unlink(queuePath(claudeSessionId));
  } catch (e: unknown) {
    if (!(e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT")) {
      throw e;
    }
  }
}

/**
 * Remove a stale HIL marker left over from a prior turn (e.g. the ask-hook
 * process was SIGKILL'd between PreToolUse and PostToolUse). Without this,
 * `watchHILMarker`'s initial `existsSync` would spuriously fire `onHIL(true)`
 * at the start of a fresh turn. Ignores ENOENT.
 */
async function clearStaleHILMarker(claudeSessionId: string): Promise<void> {
  const { hil } = claudeHookDirs();
  await mkdir(hil, { recursive: true });
  try {
    await unlink(join(hil, claudeSessionId));
  } catch (e: unknown) {
    if (!(e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT")) {
      throw e;
    }
  }
}

/**
 * Remove a stale ready marker from a prior session that reused this UUID (in
 * practice impossible — UUIDs are fresh per session — but cheap insurance so
 * `waitForReadyMarker`'s initial existsSync can't false-positive on anything
 * we left behind). Ignores ENOENT.
 */
async function clearStaleReadyMarker(claudeSessionId: string): Promise<void> {
  const { ready } = claudeHookDirs();
  await mkdir(ready, { recursive: true });
  try {
    await unlink(join(ready, claudeSessionId));
  } catch (e: unknown) {
    if (!(e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT")) {
      throw e;
    }
  }
}

/**
 * Write the next prompt to the session queue file. The currently-running
 * Stop hook process (blocked on poll from the previous turn) picks it up,
 * emits `{decision:"block", reason:<prompt>}` on stdout, and Claude feeds
 * it back as the next user message — no tmux keystrokes required.
 */
async function enqueuePrompt(claudeSessionId: string, prompt: string): Promise<void> {
  await mkdir(queueDir(), { recursive: true });
  await writeFile(queuePath(claudeSessionId), prompt, "utf-8");
}

/**
 * Signal the Stop hook's blocking wait that this session is done. Called
 * during session teardown so the final hook invocation exits 0 promptly.
 * Safe to call more than once.
 */
export async function releaseClaudeSession(claudeSessionId: string): Promise<void> {
  await mkdir(releaseDir(), { recursive: true });
  await writeFile(releasePath(claudeSessionId), "");
}

/** @internal */
function pidDir(): string {
  return claudeHookDirs().pid;
}

/** @internal */
function pidFilePath(claudeSessionId: string): string {
  return join(pidDir(), claudeSessionId);
}

/**
 * Write `process.pid` to `~/.atomic/claude-pid/<session_id>` so the Stop hook
 * can use it as a liveness signal. If atomic is SIGKILL'd (no chance to run
 * `clearClaudeSession`), the hook detects the dead PID via `process.kill(..,0)`
 * and self-exits instead of parking Claude for the full 24-day timeout.
 */
async function writeAtomicPidFile(claudeSessionId: string): Promise<void> {
  await mkdir(pidDir(), { recursive: true });
  await writeFile(pidFilePath(claudeSessionId), String(process.pid), "utf-8");
}

/** Remove the pid file for a session. Idempotent — ENOENT is swallowed. */
async function unlinkAtomicPidFile(claudeSessionId: string): Promise<void> {
  try {
    await unlink(pidFilePath(claudeSessionId));
  } catch (e: unknown) {
    if (!(e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT")) {
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// Idle detection via marker file watch
// ---------------------------------------------------------------------------

/**
 * Wait for the Claude session to become idle using `fs.watch` on the
 * `~/.atomic/claude-stop/` marker directory.
 *
 * When Claude finishes a turn, the `atomic _claude-stop-hook` Stop hook writes
 * `~/.atomic/claude-stop/<session_id>`. The write triggers an OS-native
 * `fs.watch` event on the parent directory — far more reliable than polling
 * tmux pane glyphs, which vary between Claude Code versions.
 *
 * This function is strictly about *idle detection*. HIL is detected separately
 * by {@link watchHILMarker}; the Stop hook does not fire while
 * `AskUserQuestion` is pending (the agent loop blocks on deferred tools), so
 * mixing the two would silently miss the HIL window.
 *
 * Algorithm:
 * 1. Attach the directory watcher, then check for the marker file on disk —
 *    this closes the race where the Stop hook fires between prompt submission
 *    and watcher attach.
 * 2. On any event, re-check the marker file on disk (we intentionally do NOT
 *    filter by `event.filename`, because on Linux a write can deliver multiple
 *    events with varying filenames and editor tools may race us).
 * 3. Read the session transcript via `getSessionMessages` and slice messages
 *    from `transcriptBeforeCount`.
 * 4. Clean up the `fs.watch` watcher on any exit path via AbortController.
 *
 * @param claudeSessionId       - Claude's session UUID (used to identify marker file)
 * @param transcriptBeforeCount - number of messages in transcript before this turn
 */
/**
 * @internal Exported for unit tests.
 */
export async function waitForIdle(
  claudeSessionId: string,
  transcriptBeforeCount: number,
): Promise<SessionMessage[]> {

  const dir = markerDir();
  const sessionId = claudeSessionId;
  const target = markerPath(sessionId);
  const ac = new AbortController();

  // Process a marker that has appeared on disk. Returns a tuple:
  //   [resolved, result] — when resolved=true, waitForIdle should return.
  const readMessages = async (): Promise<SessionMessage[] | null> => {
    try {
      return await getSessionMessages(sessionId, {
        dir: process.cwd(),
        includeSystemMessages: true,
      });
    } catch {
      return null;
    }
  };

  const handleMarker = async (): Promise<[boolean, SessionMessage[]]> => {
    let msgs = await readMessages();
    if (msgs === null) {
      // Transcript read failed — keep watching; the next event will retry.
      return [false, []];
    }

    // The Stop hook fires only once per agent loop completion (when there
    // are no more tool_use blocks to resolve — see Claude Code's
    // `src/query/stopHooks.ts` / `query.ts`: `if (!needsFollowUp)`). But
    // Claude Code writes to the JSONL transcript asynchronously via
    // `enqueueWrite()` with a batched ~100ms flush, so the final
    // `assistant[text]` message can still be in the page-cache when our
    // marker watcher fires. Reading the transcript at that moment races
    // the writer and returns a prefix ending at `user[tool_result]`.
    //
    // Because no further marker events are coming, we can't just "keep
    // watching the marker dir". Instead, poll the transcript file directly
    // until it either settles on a terminal stop_reason or the poll budget
    // expires. The budget covers Claude Code's flush interval plus headroom
    // for slow disks and buffered `fs/promises` writes.
    if (_isMidAgentLoop(msgs)) {
      const pollIntervalMs = 50;
      const pollBudgetMs = 3_000;
      const start = Date.now();
      while (_isMidAgentLoop(msgs) && Date.now() - start < pollBudgetMs) {
        await Bun.sleep(pollIntervalMs);
        const next = await readMessages();
        if (next) msgs = next;
      }
      // Whether we recovered or ran out of budget, fall through — returning
      // what we have beats hanging forever if the writer really did drop a
      // message (e.g. max-tokens collapse, abort mid-stream).
    }

    const sliced = msgs.length > transcriptBeforeCount
      ? msgs.slice(transcriptBeforeCount)
      : [];
    return [true, sliced];
  };

  try {
    // Attach the watcher FIRST; fs.watch returns an iterable whose underlying
    // inotify/FSEvent subscription is live from this point on.
    const watcher = watch(dir, { signal: ac.signal });

    // Close the race: if the Stop hook fired between clearStaleMarker() and
    // the watcher attach above, the marker is already on disk and no further
    // events will be emitted. Handle it synchronously.
    if (existsSync(target)) {
      const [done, result] = await handleMarker();
      if (done) {
        ac.abort();
        return result;
      }
    }

    for await (const _event of watcher) {
      // We don't trust event.filename — on Linux, a tmp+rename write emits
      // events with the `.tmp` basename, and other files in the marker dir
      // can race us. The marker file's existence on disk is authoritative.
      if (!existsSync(target)) continue;

      const [done, result] = await handleMarker();
      if (done) {
        ac.abort();
        return result;
      }
    }
  } catch (e: unknown) {
    // AbortError is expected when we call ac.abort() to stop watching.
    if (!(e instanceof Error && e.name === "AbortError")) {
      throw e;
    }
  }

  return [];
}

// ---------------------------------------------------------------------------
// claudeQuery
// ---------------------------------------------------------------------------

export interface ClaudeQueryOptions {
  /** tmux pane ID where Claude is running */
  paneId: string;
  /** The prompt to send */
  prompt: string;
  /**
   * Called when the agent's human-in-the-loop state changes.
   * `waiting=true`  → AskUserQuestion is pending (agent blocked on user input).
   * `waiting=false` → AskUserQuestion was resolved (agent resumed processing).
   */
  onHIL?: (waiting: boolean) => void;
}

/**
 * Extract text content from assistant messages in a transcript slice.
 *
 * Walks messages from `afterIndex` forward, pulls `TextBlock.text` from each
 * assistant message's content array, and joins them. The `message` payload is
 * `unknown` in the SDK type so we do runtime narrowing.
 *
 * Exported so workflow authors can extract text from `SessionMessage[]`
 * returned by `s.session.query()`.
 */
export function extractAssistantText(
  msgs: ReadonlyArray<{ type: string; message: unknown }>,
  afterIndex: number,
): string {
  const parts: string[] = [];
  for (let i = afterIndex; i < msgs.length; i++) {
    const msg = msgs[i];
    if (!msg || msg.type !== "assistant") continue;
    const m = msg.message;
    if (!m || typeof m !== "object") continue;
    const content = (m as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as Record<string, unknown>).type === "text"
      ) {
        parts.push(String((block as Record<string, unknown>).text ?? ""));
      }
    }
  }
  return parts.join("\n");
}

/**
 * Send a prompt to a Claude Code interactive session running in a tmux pane.
 *
 * First query and follow-up queries use different delivery channels:
 *
 *   - **First query**: stages the prompt in a tmp file and spawns
 *     `claude --session-id <UUID> 'Read the prompt in <path>'` into the
 *     empty pane. Claude's first action is a Read tool call, which
 *     sidesteps ARG_MAX on the spawn argv.
 *
 *   - **Follow-up query**: writes the prompt to
 *     `~/.atomic/claude-queue/<session_id>`. The Stop hook from the
 *     previous turn is blocked in a poll loop there; it reads the queue
 *     entry and emits `{"decision":"block","reason":<prompt>}` on stdout,
 *     which Claude Code feeds back as the next user message. No tmux
 *     keystrokes, no paste-buffer dance, no pane-state polling — the
 *     whole delivery rides Claude's own continuation API.
 *
 * Both paths converge on `waitForIdle`, which watches the Stop-hook marker
 * file for this session and returns the transcript slice for the turn.
 *
 * @example
 * ```typescript
 * import { claudeQuery } from "@bastani/atomic/workflows";
 *
 * const result = await claudeQuery({
 *   paneId: ctx.paneId,
 *   prompt: "Describe this project",
 * });
 * ctx.log(result.output);
 * ```
 */
export async function claudeQuery(options: ClaudeQueryOptions): Promise<SessionMessage[]> {
  const { paneId, prompt, onHIL } = options;

  const paneState = initializedPanes.get(paneId);
  if (!paneState) {
    throw new Error(
      "claudeQuery() called without a prior createClaudeSession() for this pane. " +
      "Call createClaudeSession({ paneId }) first to start the Claude CLI.",
    );
  }

  const dir = process.cwd();
  const claudeSessionId = paneState.claudeSessionId;

  // Clear stale marker AND stale queue entry before submitting so the
  // Stop-hook for the previous turn (if any) cannot race this one. The HIL
  // marker is cleared too so a crashed ask-hook process from turn N-1 can't
  // make `watchHILMarker`'s initial existsSync spuriously fire onHIL(true).
  await clearStaleMarker(claudeSessionId);
  await clearStaleQueue(claudeSessionId);
  await clearStaleHILMarker(claudeSessionId);
  await clearStaleReadyMarker(claudeSessionId);

  let transcriptBeforeCount = 0;
  let spawnPromptFile: string | undefined;

  try {
    if (paneState.claudeStarted) {
      // Follow-up query: snapshot the transcript length so waitForIdle can
      // slice out the messages produced by THIS turn, then enqueue the
      // prompt for the Stop hook to pick up.
      try {
        const msgs = await getSessionMessages(claudeSessionId, {
          dir,
          includeSystemMessages: true,
        });
        transcriptBeforeCount = msgs.length;
      } catch {
        // Best-effort — 0 means we scan all messages (correct, slightly less efficient)
      }

      await enqueuePrompt(claudeSessionId, prompt);
    } else {
      // First query: spawn claude with the prompt baked into argv via the
      // Read-tool indirection. The tmp file only has to live long enough
      // for Claude's first Read tool call, so we delete it once waitForIdle
      // returns (the turn is complete by then).
      spawnPromptFile = atomicTempPath(
        "atomic-claude-prompt",
        ".txt",
        `${claudeSessionId}-${randomUUID()}`,
      );
      writeFileSync(spawnPromptFile, prompt, {
        encoding: "utf-8",
        mode: 0o600,
      });

      await spawnClaudeWithPrompt(
        paneId,
        spawnPromptFile,
        paneState.chatFlags,
        claudeSessionId,
      );
      paneState.claudeStarted = true;
    }

    // HIL detection runs in parallel with idle detection. The
    // PreToolUse/PostToolUse/PostToolUseFailure hooks on `AskUserQuestion`
    // write/remove `~/.atomic/claude-hil/<session_id>`; we watch that dir
    // for create/unlink events so HIL state is deterministic and immune to
    // Claude Code's batched JSONL flush timing.
    const hilAc = new AbortController();
    if (onHIL) {
      void watchHILMarker(claudeSessionId, onHIL, hilAc.signal).catch(() => {
        // Best-effort — never fail the query over HIL detection.
      });
    }

    try {
      return await waitForIdle(claudeSessionId, transcriptBeforeCount);
    } finally {
      hilAc.abort();
      // Safety: waitForIdle only returns at true turn-idle. If the ask-hook
      // process crashed mid-turn and left the marker on disk, the UI could
      // be stuck on awaiting_input. `resumeSession` in the panel store is
      // idempotent (no-op when the session isn't in awaiting_input), so
      // this is always safe.
      onHIL?.(false);
    }
  } finally {
    if (spawnPromptFile) {
      try {
        await unlink(spawnPromptFile);
      } catch {
        // ENOENT / already removed is fine.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic wrappers — uniform s.client / s.session API for Claude stages
// ---------------------------------------------------------------------------

/**
 * Merge two `disallowedTools` lists, preserving caller entries and appending
 * any extras that aren't already present. Exported for unit testing.
 */
export function mergeDisallowedTools(
  existing: string[] | undefined,
  extras: string[],
): string[] {
  const merged = [...(existing ?? [])];
  for (const tool of extras) {
    if (!merged.includes(tool)) merged.push(tool);
  }
  return merged;
}

/**
 * Fold the atomic-managed additional instructions into a caller's
 * `systemPrompt` value. Behavior, in order of precedence:
 *
 *   - **No caller value** → return a `claude_code` preset with our content
 *     in `append`. Preserves the SDK's full Claude Code persona.
 *   - **Caller passed a preset object** → concatenate our content onto the
 *     existing `append` (newline-separated when both are present).
 *   - **Caller passed a custom string or array** → leave it alone. The
 *     caller has explicitly opted into a custom prompt, and silently
 *     prepending the persona-style preset text would break that contract.
 *
 * Exported for unit testing.
 */
export function mergeSystemPromptAppend(
  existing: SDKOptions["systemPrompt"],
  extra: string,
): SDKOptions["systemPrompt"] {
  if (!extra) return existing;
  if (existing === undefined) {
    return { type: "preset", preset: "claude_code", append: extra };
  }
  if (typeof existing === "object" && !Array.isArray(existing) && existing.type === "preset") {
    const prevAppend = existing.append ?? "";
    const merged = prevAppend ? `${prevAppend}\n\n${extra}` : extra;
    return { ...existing, append: merged };
  }
  return existing;
}

/**
 * Synthetic client wrapper for Claude stages.
 * Auto-starts the Claude CLI in the tmux pane during `start()`.
 */
export class ClaudeClientWrapper {
  readonly paneId: string;
  private readonly opts: { chatFlags?: string[] };

  constructor(
    paneId: string,
    opts: { chatFlags?: string[] } = {},
  ) {
    this.paneId = paneId;
    this.opts = opts;
  }

  /**
   * Start the Claude CLI in the tmux pane. Returns the Claude session UUID
   * so the caller can pass it to `ClaudeSessionWrapper` (and thus expose it
   * as `s.sessionId` to workflows). This is the UUID used by Claude Code to
   * name its JSONL transcript file and to key the Stop-hook marker — workflows
   * pass it to `s.save(s.sessionId)` so the save path reads the correct
   * transcript even when many Claude sessions run in parallel.
   */
  async start(): Promise<string> {
    return await createClaudeSession({
      paneId: this.paneId,
      chatFlags: this.opts.chatFlags,
    });
  }

  /** Noop — cleanup is handled by the runtime via `clearClaudeSession`. */
  async stop(): Promise<void> {}
}

/**
 * Synthetic session wrapper for Claude stages.
 * Wraps `claudeQuery()` so users call `s.session.query(prompt)`.
 */
export class ClaudeSessionWrapper {
  readonly paneId: string;
  readonly sessionId: string;
  private readonly onHIL: ((waiting: boolean) => void) | undefined;

  constructor(
    paneId: string,
    sessionId: string,
    onHIL?: (waiting: boolean) => void,
  ) {
    this.paneId = paneId;
    this.sessionId = sessionId;
    this.onHIL = onHIL;
  }

  /**
   * Send a prompt to Claude and wait for the response.
   *
   * The `_options` parameter exists for signature compatibility with
   * {@link HeadlessClaudeSessionWrapper#query} (which forwards SDK options
   * like `agent`, `permissionMode`, etc. to the Agent SDK). In the
   * interactive pane path these options don't apply — we're driving the
   * `claude` CLI binary, not the SDK — so they are silently ignored.
   */
  async query(
    prompt: string,
    _options?: Partial<SDKOptions>,
  ): Promise<SessionMessage[]> {
    return claudeQuery({
      paneId: this.paneId,
      prompt,
      onHIL: this.onHIL,
    });
  }

  /**
   * Structured output is only produced by the Agent SDK's `result` message,
   * which interactive stages don't consume (they drive the `claude` CLI via
   * tmux, not the SDK). Always `undefined` here — pair `outputFormat` with a
   * headless stage to read {@link HeadlessClaudeSessionWrapper#lastStructuredOutput}.
   */
  get lastStructuredOutput(): unknown {
    return undefined;
  }

  /** Noop — for API symmetry with CopilotSession.disconnect(). */
  async disconnect(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Headless wrappers — use the Agent SDK directly (no tmux pane)
// ---------------------------------------------------------------------------

/**
 * Headless client wrapper for Claude stages. No tmux pane — noop start/stop.
 * Used when `options.headless` is true in `ctx.stage()`.
 */
export class HeadlessClaudeClientWrapper {
  /**
   * Headless Claude stages don't pre-allocate a session — each `query()` call
   * to {@link HeadlessClaudeSessionWrapper} spawns a fresh Agent SDK run that
   * emits its own `session_id`. We still return an empty string here so the
   * method signature matches {@link ClaudeClientWrapper#start}.
   */
  async start(): Promise<string> {
    return "";
  }
  async stop(): Promise<void> {}
}

/**
 * Resolve the `claude` CLI binary for headless SDK queries.
 *
 * Pins the SDK to the same binary interactive stages already spawn via tmux
 * (`AGENT_CONFIG.claude.cmd` on PATH), bypassing
 * `@anthropic-ai/claude-agent-sdk`'s built-in resolver. That resolver probes
 * optional native packages in a fixed order — on Linux it tries
 * `linux-${arch}-musl` before `linux-${arch}` and returns whichever
 * `require.resolve` finds first — so on a glibc host where both optional
 * packages got installed (Bun installs every optionalDependency by default)
 * it picks the musl binary, which can't exec because its dynamic linker
 * (`/lib/ld-musl-*.so.1`) is absent. The SDK surfaces the resulting ENOENT
 * as a misleading "Claude Code native binary not found" error.
 *
 * `chatCommand` and `workflowCommand` already fail fast when `claude` isn't
 * on PATH (see `isCommandInstalled` in each), so in practice this lookup
 * always succeeds. The throw here is a belt-and-suspenders guard that
 * prefers a clear failure over silently falling back to the SDK's resolver.
 */
export function resolveHeadlessClaudeBin(): string {
  // Pass PATH explicitly — the 1-arg form of Bun.which caches the value
  // captured at process start, which makes the lookup insensitive to later
  // env mutations (and un-exercisable from tests that tweak `process.env.PATH`).
  const onPath = Bun.which("claude", { PATH: process.env.PATH ?? "" });
  if (!onPath) {
    throw new Error(
      "`claude` CLI not found on PATH. Install Claude Code via the native " +
        "installer (https://docs.claude.com/en/docs/claude-code/overview) " +
        "and retry.",
    );
  }
  return onPath;
}

/**
 * Headless session wrapper for Claude stages. Uses the Agent SDK's `query()`
 * directly instead of tmux pane operations. Implements the same `query()`
 * interface as {@link ClaudeSessionWrapper} so workflow callbacks work
 * identically for headless and interactive stages.
 *
 * The `query()` method accepts the full Agent SDK parameter types —
 * `prompt` can be a plain string or an `AsyncIterable<SDKUserMessage>`
 * for multi-turn streaming, and `options` passes through SDK-level
 * configuration (abort controllers, allowed tools, agents, etc.).
 */
export class HeadlessClaudeSessionWrapper {
  readonly paneId = "";
  /**
   * Project root the workflow is operating against. Used to resolve
   * project-scoped config (e.g. `additional-instructions`) against the
   * workflow's actual root rather than `process.cwd()`, which can drift
   * when workflows are invoked programmatically or from a subdirectory.
   */
  private readonly _projectRoot: string;
  /**
   * The Claude session UUID of the most recently completed `query()`. Exposed
   * via `s.sessionId` so workflows can pass it to `s.save(s.sessionId)` and
   * have the save path read the correct transcript, even when several headless
   * Claude stages run in parallel (each call gets its own SDK-assigned UUID).
   */
  private _lastSessionId: string = "";

  constructor(projectRoot: string) {
    this._projectRoot = projectRoot;
  }
  /**
   * Validated structured output captured from the most recent `query()`'s
   * `result` message. Populated only when callers pass
   * `options.outputFormat = { type: "json_schema", schema }` and the SDK
   * produced a `subtype: "success"` result with `structured_output` attached.
   * Remains `undefined` on plain text runs or when the SDK fails validation
   * (`error_max_structured_output_retries`).
   */
  private _lastStructuredOutput: unknown = undefined;

  get sessionId(): string {
    return this._lastSessionId;
  }

  get lastStructuredOutput(): unknown {
    return this._lastStructuredOutput;
  }

  async query(
    prompt: string | AsyncIterable<SDKUserMessage>,
    options?: Partial<SDKOptions>,
  ): Promise<SessionMessage[]> {
    // Auto-deny the `AskUserQuestion` tool in headless runs. Without this, the
    // agent can call it and the SDK query will sit blocked forever since no
    // human is attached to answer.
    const sdkOpts = options ?? {};
    const additional = await resolveAdditionalInstructionsContent(this._projectRoot);
    const headlessSdkOpts: Partial<SDKOptions> = {
      ...sdkOpts,
      pathToClaudeCodeExecutable:
        sdkOpts.pathToClaudeCodeExecutable ?? resolveHeadlessClaudeBin(),
      disallowedTools: mergeDisallowedTools(sdkOpts.disallowedTools, [
        "AskUserQuestion",
      ]),
      ...(additional
        ? { systemPrompt: mergeSystemPromptAppend(sdkOpts.systemPrompt, additional) }
        : {}),
    };

    let sdkSessionId = "";
    let structuredOutput: unknown = undefined;
    try {
      await withAtomicTempEnv(async () => {
        for await (const msg of sdkQuery({ prompt, options: headlessSdkOpts })) {
          if (msg.type === "result") {
            const record = msg as Record<string, unknown>;
            sdkSessionId = String(record.session_id ?? "");
            if (record.subtype === "success" && "structured_output" in record) {
              structuredOutput = record.structured_output;
            }
          }
        }
      });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`Claude SDK query failed: ${detail}`);
    }
    if (!sdkSessionId) {
      throw new Error(
        "Claude SDK query completed without a `result` message — " +
          "likely a stream idle timeout, aborted request, or upstream API error. " +
          "Set CLAUDE_ENABLE_STREAM_WATCHDOG=1 (and tune CLAUDE_STREAM_IDLE_TIMEOUT_MS / " +
          "API_TIMEOUT_MS) so the CLI surfaces a concrete failure instead of exiting silently.",
      );
    }
    this._lastSessionId = sdkSessionId;
    this._lastStructuredOutput = structuredOutput;
    return getSessionMessages(sdkSessionId, { dir: process.cwd() });
  }

  async disconnect(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Resume adapter
// ---------------------------------------------------------------------------

// TODO(task-4): replace with import from offload-types.ts once it lands
interface OffloadResumeMetadata {
  /** Agent-native session ID to pass to --resume / --session. */
  agentSessionId: string;
}

/**
 * Build the `claude` CLI argv fragment needed to resume an offloaded session.
 *
 * Produces:
 *   ["--resume", "<UUID>", ...DEFAULT_CHAT_FLAGS, "--settings", "<hooksPath>"]
 *
 * Placement: `--resume` before the standard chat flags so Claude Code's
 * last-wins flag semantics leave our `--settings` authoritative.
 */
export function buildClaudeResumeArgs(meta: OffloadResumeMetadata): string[] {
  const hooksPath = workflowHookSettingsPath();
  return [
    "--resume",
    meta.agentSessionId,
    ...DEFAULT_CHAT_FLAGS,
    "--settings",
    hooksPath,
  ];
}

// ---------------------------------------------------------------------------
// Static source validation
// ---------------------------------------------------------------------------

import { createProviderValidator } from "../types.ts";

/**
 * Validate a Claude workflow source file for common mistakes.
 *
 * Warns on direct usage of createClaudeSession/claudeQuery — the runtime
 * now handles init/cleanup automatically via s.client and s.session.
 */
export const validateClaudeWorkflow = createProviderValidator([
  {
    pattern: /\bcreateClaudeSession\b/,
    rule: "claude/manual-session",
    message:
      "Manual createClaudeSession() call detected. The runtime auto-starts the Claude CLI — " +
      "use s.session.query() instead of claudeQuery(). Pass chatFlags via the second arg to ctx.stage().",
  },
  {
    pattern: /\bclaudeQuery\b/,
    rule: "claude/manual-query",
    message:
      "Direct claudeQuery() call detected. Use s.session.query(prompt) instead — " +
      "it wraps claudeQuery with the correct paneId.",
  },
]);

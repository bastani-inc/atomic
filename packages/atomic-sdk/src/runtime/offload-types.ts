/**
 * Types for the workflow-pane offload & resume feature.
 *
 * Spec: specs/2026-05-08-workflow-pane-offload-and-resume.md §5.1, §5.9
 */

import type { AgentType } from "../types.ts";

/**
 * Re-export so callers can use `AgentKind` from this module without importing
 * from two places.  Aligned with the existing {@link AgentType} alias of
 * {@link AgentKey} — "claude" | "opencode" | "copilot".
 */
export type { AgentType as AgentKind };

/**
 * The `resume` sub-object written to `metadata.json` by {@link OffloadManager}.
 *
 * Immutability contract:
 * - `schemaVersion` is always 1 (literal) — bump the number when the shape
 *   changes in a backward-incompatible way.
 * - `offloadedAt` is `null` while the agent process is alive; set to
 *   `Date.now()` the moment the process is killed.
 * - All other fields are populated once at session registration time and then
 *   left untouched until the `error` field is written on resume failure.
 */
export interface OffloadResumeMetadata {
  /** Always 1 — used by readers to gate on forward compatibility. */
  schemaVersion: 1;
  /** Agent-native session ID fed to `--resume`/`--session` at re-spawn. */
  agentSessionId: string;
  /** tmux session name the pane lives in (e.g. "atomic-7f3a2c1d"). */
  tmuxSessionName: string;
  /** tmux window name for this stage pane (e.g. "review"). */
  tmuxWindowName: string;
  /** Snapshot of env vars injected when the agent was originally spawned. */
  spawnEnv: Record<string, string>;
  /** Working directory used when the agent was originally spawned. */
  spawnCwd: string;
  /** The last user-visible prompt sent to the agent before offload. */
  lastPrompt: string;
  /**
   * Epoch-ms timestamp of the last focus event seen for this pane.
   * Used to prioritise which offloaded pane to resume first.
   */
  lastSeenAt: number;
  /**
   * Epoch-ms timestamp of when the agent process was killed, or `null` if the
   * agent is still running (i.e. not yet offloaded).
   */
  offloadedAt: number | null;
  /** Set on resume failure; contains the error message / stack trace. */
  error?: string;
}

/**
 * Shape of the per-stage `metadata.json` file once the offload feature is
 * active.  The top-level immutable fields are written once at stage start
 * (`executor.ts:1932`); the optional `resume` sub-object is added / mutated
 * only by {@link OffloadManager}.
 *
 * Older readers that do not know about `resume` will simply ignore the extra
 * key — forward-compatible by design.
 */
export interface MetadataJsonWithResume {
  /** Human-readable stage name (matches the key passed to `ctx.stage()`). */
  name: string;
  /** Optional one-line description passed to `ctx.stage()`. */
  description: string;
  /** Which agent CLI is running in this stage pane. */
  agent: AgentType;
  /** tmux pane ID string (e.g. "%7"). */
  paneId: string;
  /** MCP server URL if the agent exposes one, otherwise empty string. */
  serverUrl: string;
  /** MCP server port number, or 0 when `serverUrl` is absent. */
  port: number;
  /** ISO-8601 timestamp of when the stage was started. */
  startedAt: string;
  /** Offload/resume sub-object — absent until the stage is registered with OffloadManager. */
  resume?: OffloadResumeMetadata;
}

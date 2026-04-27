/**
 * Session CLI commands — shared between `atomic chat session` and
 * `atomic workflow session`, and the top-level `atomic session` picker.
 *
 * Wraps tmux -L atomic list-sessions / attach-session so users can
 * inspect and reconnect to running atomic sessions without touching
 * tmux directly.
 */

import { select, confirm, isCancel, cancel } from "@clack/prompts";
import { createPainter, type PaletteKey } from "../../theme/colors.ts";
import {
  listSessions as _listSessions,
  isTmuxInstalled as _isTmuxInstalled,
  isInsideAtomicSocket as _isInsideAtomicSocket,
  isInsideTmux as _isInsideTmux,
  sessionExists as _sessionExists,
  switchClient as _switchClient,
  spawnMuxAttach as _spawnMuxAttach,
  detachAndAttachAtomic as _detachAndAttachAtomic,
  killSession as _killSession,
  SOCKET_NAME,
} from "../../sdk/runtime/tmux.ts";
import type { TmuxSession, SessionType } from "../../sdk/runtime/tmux.ts";
import type { Subprocess } from "bun";

/** Scope controls which session types a command shows. */
export type SessionScope = "chat" | "workflow" | "all";

/** Injectable tmux dependencies for command functions. */
export interface SessionDeps {
  isTmuxInstalled: () => boolean;
  sessionExists: (name: string) => boolean;
  listSessions: () => TmuxSession[];
  isInsideAtomicSocket: () => boolean;
  isInsideTmux: () => boolean;
  switchClient: (name: string) => void;
  spawnMuxAttach: (name: string) => Subprocess;
  detachAndAttachAtomic: (name: string) => void;
  killSession: (name: string) => void;
  /** Prompt function for the session picker — defaults to @clack/prompts select. */
  select: typeof select;
  /** Prompt function for yes/no confirmations — defaults to @clack/prompts confirm. */
  confirm: typeof confirm;
  isCancel: typeof isCancel;
}

/** Default deps — wire through to the real implementations. */
const defaultDeps: SessionDeps = {
  isTmuxInstalled: _isTmuxInstalled,
  sessionExists: _sessionExists,
  listSessions: _listSessions,
  isInsideAtomicSocket: _isInsideAtomicSocket,
  isInsideTmux: _isInsideTmux,
  switchClient: _switchClient,
  spawnMuxAttach: _spawnMuxAttach,
  detachAndAttachAtomic: _detachAndAttachAtomic,
  killSession: _killSession,
  select,
  confirm,
  isCancel,
};

// ─── Rendering ──────────────────────────────────────────────────────────────

/**
 * Render the session list as a printable string.
 *
 * Layout mirrors the workflow list style — data-first count header,
 * session rows with metadata, dim footer hint.
 */
export function renderSessionList(sessions: TmuxSession[]): string {
  const paint = createPainter();
  const lines: string[] = [];

  if (sessions.length === 0) {
    lines.push("");
    lines.push("  " + paint("text", "no sessions running", { bold: true }));
    lines.push("");
    lines.push("  " + paint("dim", "start one with"));
    lines.push("    " + paint("accent", "atomic chat -a <agent>"));
    lines.push("    " + paint("accent", "atomic workflow -n <name> -a <agent>"));
    lines.push("");
    return lines.join("\n") + "\n";
  }

  const count = sessions.length;
  const noun = count === 1 ? "session" : "sessions";
  lines.push("");
  lines.push(
    "  " + paint("text", String(count), { bold: true }) + " " + paint("dim", noun) +
    paint("dim", ` on tmux -L ${SOCKET_NAME}`),
  );
  lines.push("");

  for (const s of sessions) {
    const status: PaletteKey = s.attached ? "success" : "dim";
    const indicator = s.attached ? "●" : "○";
    const age = formatAge(s.created);
    const agentBadge = s.agent ? "  " + paint("accent", `[${s.agent}]`) : "";

    lines.push(
      "  " +
      paint(status, indicator) + " " +
      paint("text", s.name, { bold: true }) +
      agentBadge +
      paint("dim", "  " + age) +
      (s.attached ? "  " + paint("success", "attached") : ""),
    );
  }

  lines.push("");
  lines.push("  " + paint("dim", "connect: atomic session connect <name>"));
  lines.push("");

  return lines.join("\n") + "\n";
}

/**
 * Format an ISO timestamp (or raw string) as a human-readable relative age.
 */
function formatAge(isoOrRaw: string): string {
  const d = new Date(isoOrRaw);
  if (Number.isNaN(d.getTime())) return isoOrRaw;

  const diffMs = Date.now() - d.getTime();
  if (diffMs < 0) return "just now";

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

// ─── Filtering ─────────────────────────────────────────────────────────────

/** Map a SessionScope to the SessionType it allows (undefined = no filter). */
const SCOPE_TO_TYPE: Record<SessionScope, SessionType | undefined> = {
  chat: "chat",
  workflow: "workflow",
  all: undefined,
};

/** Filter sessions by scope (chat-only, workflow-only, or all). */
export function filterByScope(sessions: TmuxSession[], scope: SessionScope): TmuxSession[] {
  const required = SCOPE_TO_TYPE[scope];
  if (!required) return sessions;
  return sessions.filter((s) => s.type === required);
}

/** Filter sessions to only those matching at least one of the given agents. */
export function filterByAgent(sessions: TmuxSession[], agents: string[]): TmuxSession[] {
  if (agents.length === 0) return sessions;
  const allowed = new Set(agents.map((a) => a.toLowerCase()));
  return sessions.filter((s) => s.agent !== undefined && allowed.has(s.agent.toLowerCase()));
}

// ─── Session list command ───────────────────────────────────────────────────

export async function sessionListCommand(agents: string[] = [], scope: SessionScope = "all", deps: SessionDeps = defaultDeps): Promise<number> {
  if (!deps.isTmuxInstalled()) {
    const paint = createPainter();
    process.stdout.write(
      "\n  " + paint("text", "no sessions running", { bold: true }) +
      "\n\n  " + paint("dim", "tmux is not installed") + "\n\n",
    );
    return 0;
  }

  const sessions = filterByAgent(filterByScope(deps.listSessions(), scope), agents);
  process.stdout.write(renderSessionList(sessions));
  return 0;
}

// ─── Session connect command ────────────────────────────────────────────────

/**
 * Connect to a named session. Handles the three tmux contexts:
 * already on atomic socket → switch-client, inside other tmux → detach+attach,
 * outside tmux → spawn attach.
 */
export async function sessionConnectCommand(sessionName: string, deps: SessionDeps = defaultDeps): Promise<number> {
  const paint = createPainter();

  if (!deps.isTmuxInstalled()) {
    process.stderr.write(
      paint("error", "Error: tmux is not installed.") + "\n",
    );
    return 1;
  }

  if (!deps.sessionExists(sessionName)) {
    process.stderr.write(
      paint("error", `Error: session '${sessionName}' not found.`) + "\n",
    );
    const sessions = deps.listSessions();
    if (sessions.length > 0) {
      process.stderr.write(
        "\n" + paint("dim", "Available sessions:") + "\n",
      );
      for (const s of sessions) {
        process.stderr.write(
          "  " + paint("dim", "○") + " " + paint("text", s.name) + "\n",
        );
      }
      process.stderr.write("\n");
    }
    return 1;
  }

  if (deps.isInsideAtomicSocket()) {
    deps.switchClient(sessionName);
    return 0;
  }

  if (deps.isInsideTmux()) {
    deps.detachAndAttachAtomic(sessionName);
    return 0;
  }

  const proc = deps.spawnMuxAttach(sessionName);
  return await proc.exited;
}

// ─── Interactive session picker ─────────────────────────────────────────────

/**
 * Show an fzf-style interactive picker for all running atomic sessions.
 * Used by `atomic session connect` (no args).
 */
export async function sessionPickerCommand(agents: string[] = [], scope: SessionScope = "all", deps: SessionDeps = defaultDeps): Promise<number> {
  const paint = createPainter();

  if (!deps.isTmuxInstalled()) {
    process.stderr.write(
      paint("error", "Error: tmux is not installed.") + "\n",
    );
    return 1;
  }

  const sessions = filterByAgent(filterByScope(deps.listSessions(), scope), agents);

  if (sessions.length === 0) {
    process.stdout.write(renderSessionList(sessions));
    return 0;
  }

  const selected = await deps.select({
    message: "Connect to session",
    options: sessions.map((s) => {
      const age = formatAge(s.created);
      const tag = s.attached ? " (attached)" : "";
      return {
        value: s.name,
        label: s.name,
        hint: `${age}${tag}`,
      };
    }),
  });

  if (deps.isCancel(selected)) {
    cancel("Cancelled.");
    return 0;
  }

  return sessionConnectCommand(selected as string, deps);
}

// ─── Session kill command ────────────────────────────────────────────────────

/**
 * Kill a named session or all sessions matching the given scope and agents.
 *
 * - If `sessionId` is provided: confirm and kill that one session.
 * - If `sessionId` is omitted: confirm and kill all sessions in scope.
 *
 * Pass `yes: true` (the `-y/--yes` flag on the CLI) to skip the
 * confirmation prompt — useful for orchestrating agents that need to
 * tear down a workflow session non-interactively.
 */
export async function sessionKillCommand(
  sessionId: string | undefined,
  agents: string[] = [],
  scope: SessionScope = "all",
  deps: SessionDeps = defaultDeps,
  options: { yes?: boolean } = {},
): Promise<number> {
  const skipConfirm = options.yes === true;
  const paint = createPainter();

  if (!deps.isTmuxInstalled()) {
    process.stdout.write(
      "\n  " + paint("text", "no sessions running", { bold: true }) +
      "\n\n  " + paint("dim", "tmux is not installed") + "\n\n",
    );
    return 0;
  }

  // ── Named kill path ───────────────────────────────────────────────────────
  if (sessionId !== undefined) {
    const inScope = filterByScope(deps.listSessions(), scope);
    const target = inScope.find((s) => s.name === sessionId);

    if (!target) {
      const scopeLabel = scope === "all" ? "" : ` in ${scope} scope`;
      process.stderr.write(
        paint("error", `Error: session '${sessionId}' not found${scopeLabel}.`) + "\n",
      );
      if (inScope.length > 0) {
        process.stderr.write(
          "\n" + paint("dim", "Available sessions:") + "\n",
        );
        for (const s of inScope) {
          process.stderr.write(
            "  " + paint("dim", "○") + " " + paint("text", s.name) + "\n",
          );
        }
        process.stderr.write("\n");
      }
      return 1;
    }

    const answer = skipConfirm
      ? true
      : await deps.confirm({
          message: `Kill session '${sessionId}'?`,
          initialValue: false,
        });

    if (deps.isCancel(answer)) {
      cancel("Cancelled.");
      return 0;
    }

    if (answer === true) {
      deps.killSession(sessionId);
      process.stdout.write(
        "\n  " + paint("success", "✓") + " killed " + paint("text", sessionId) + "\n\n",
      );
      return 0;
    }

    // answer === false
    process.stdout.write(
      "\n  " + paint("dim", "Cancelled.") + "\n\n",
    );
    return 0;
  }

  // ── Kill-all path ─────────────────────────────────────────────────────────
  const targets = filterByAgent(filterByScope(deps.listSessions(), scope), agents);

  if (targets.length === 0) {
    process.stdout.write(renderSessionList([]));
    return 0;
  }

  const noun = targets.length === 1 ? "session" : "sessions";
  const scopePrefix = scope === "all" ? "" : `${scope} `;
  const answer = skipConfirm
    ? true
    : await deps.confirm({
        message: `Kill all ${targets.length} ${scopePrefix}${noun}?`,
        initialValue: false,
      });

  if (deps.isCancel(answer)) {
    cancel("Cancelled.");
    return 0;
  }

  if (answer === true) {
    for (const t of targets) {
      deps.killSession(t.name);
    }
    process.stdout.write(
      "\n  " + paint("success", "✓") + " killed " + paint("text", String(targets.length)) + " " + paint("dim", noun) + "\n\n",
    );
    return 0;
  }

  // answer === false
  process.stdout.write(
    "\n  " + paint("dim", "Cancelled.") + "\n\n",
  );
  return 0;
}

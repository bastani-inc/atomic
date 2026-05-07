/**
 * `atomic workflow read --sessionId <id> [--stageId <name>]` — print the
 * on-disk path to a workflow run directory (or a single stage subdirectory)
 * under `~/.atomic/sessions/`, plus a brief listing of the files inside.
 *
 * Why this exists: the model-facing skill teaches workflows that persist
 * stage data via `s.save(...)` to `messages.json` / `inbox.md` and
 * orchestrator status to `status.json`. Once the model has called
 * `atomic workflow status <id>` and seen a stage name, it needs a stable
 * way to find the corresponding directory on disk so it can `Read` the
 * artifacts directly without guessing the run id or globbing for the
 * stage's opaque session-id suffix.
 *
 * On-disk layout (executor.ts:514-1789, status-writer.ts:144):
 *
 *   ~/.atomic/sessions/<runId>/
 *     status.json            ← live panel snapshot
 *     metadata.json          ← workflow-level metadata
 *     orchestrator.{sh,ps1}  ← launcher script
 *     orchestrator.log       ← orchestrator stdout/stderr
 *     <stageName>-<stageSessionId>/
 *       metadata.json        ← stage metadata
 *       messages.json        ← s.save() output (JSON)
 *       inbox.md             ← human-readable transcript rendering
 *       error.txt            ← present only when the stage failed
 *
 * Stage names are written verbatim (no slugification, executor.ts:1728);
 * the trailing `-<stageSessionId>` is opaque, so this command resolves a
 * stage by name via a `<name>-*` glob.
 *
 * `--sessionId` accepts both forms:
 *   - the full tmux name `atomic-wf-<agent>-<workflow>-<runId>` (what
 *     `atomic workflow status` prints), or
 *   - the bare 8-hex run id (the trailing segment).
 *
 * `--format` mirrors `atomic workflow refresh` — text default outside an
 * atomic chat session, JSON default inside one (detected via the
 * `ATOMIC_AGENT` env var that every chat-launcher bakes into the agent's
 * environment).
 *
 * Exit codes:
 *   0 — path resolved cleanly.
 *   1 — sessionId is malformed, run dir doesn't exist, or stage name has
 *       0 / >1 matches under the run dir.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readdir, stat } from "node:fs/promises";
import { COLORS, createPainter } from "@bastani/atomic-sdk/theme/colors";
import { workflowRunIdFromTmuxName } from "@bastani/atomic-sdk/runtime/status-writer";

export type ReadFormat = "text" | "json";

export interface WorkflowReadOptions {
  /**
   * Either the full tmux name `atomic-wf-<agent>-<workflow>-<runId>` or
   * the bare 8-hex run id.
   */
  sessionId?: string;
  /** Stage name as it appears in `atomic workflow status` output. */
  stageId?: string;
  /** Defaults to json when ATOMIC_AGENT is set, text otherwise. */
  format?: ReadFormat;
}

export interface WorkflowReadDeps {
  /** Returns the base sessions dir; defaults to `~/.atomic/sessions`. */
  sessionsBaseDir: () => string;
  env: (name: string) => string | undefined;
  readdir: typeof readdir;
  stat: typeof stat;
}

export const defaultDeps: WorkflowReadDeps = {
  sessionsBaseDir: () => join(homedir(), ".atomic", "sessions"),
  env: (name) => process.env[name],
  readdir,
  stat,
};

// ─── JSON payload shape ──────────────────────────────────────────────────────

export interface ReadFileEntry {
  name: string;
  /** "file" | "dir" — same vocabulary the model would get from `ls -F`. */
  kind: "file" | "dir";
  /** Bytes for files, undefined for dirs. */
  size?: number;
}

export interface ReadJsonPayload {
  ok: true;
  runId: string;
  /** When --stageId resolves, the stage name (verbatim from status output). */
  stageName?: string;
  /** Resolved absolute path. */
  path: string;
  /** Immediate children of `path`. */
  files: ReadFileEntry[];
  /**
   * When this is a run directory, the stage subdir names (with the
   * `-<stageSessionId>` suffix stripped) so the model can pick a stage
   * for a follow-up `--stageId` call without re-running status.
   */
  stages?: string[];
}

export interface ReadJsonError {
  ok: false;
  error: string;
  /** Set when the failure mode has an actionable fix (e.g. "use atomic workflow status"). */
  hint?: string;
}

// ─── Format resolution ───────────────────────────────────────────────────────

function resolveFormat(
  explicit: ReadFormat | undefined,
  env: WorkflowReadDeps["env"],
): ReadFormat {
  if (explicit) return explicit;
  return env("ATOMIC_AGENT") ? "json" : "text";
}

// ─── runId resolution ────────────────────────────────────────────────────────

const RUN_ID_RE = /^[0-9a-f]{8}$/i;

/**
 * Accept either the full tmux name or the bare run id. Returns null when
 * the input is neither.
 */
export function resolveRunId(sessionId: string): string | null {
  if (RUN_ID_RE.test(sessionId)) return sessionId.toLowerCase();
  return workflowRunIdFromTmuxName(sessionId);
}

// ─── Directory introspection ─────────────────────────────────────────────────

async function listEntries(
  dir: string,
  deps: WorkflowReadDeps,
): Promise<ReadFileEntry[]> {
  const names = await deps.readdir(dir);
  // Sort deterministically so output is stable across runs.
  names.sort((a, b) => a.localeCompare(b));
  const out: ReadFileEntry[] = [];
  for (const name of names) {
    let st;
    try {
      st = await deps.stat(join(dir, name));
    } catch {
      // Race / permission failure — list the entry without size.
      out.push({ name, kind: "file" });
      continue;
    }
    if (st.isDirectory()) {
      out.push({ name, kind: "dir" });
    } else {
      out.push({ name, kind: "file", size: st.size });
    }
  }
  return out;
}

/**
 * From the immediate children of a run dir, pick subdirs that look like
 * `<stageName>-<8hex>` and return the bare stage names (suffix stripped).
 */
function extractStageNames(entries: readonly ReadFileEntry[]): string[] {
  const names = new Set<string>();
  for (const e of entries) {
    if (e.kind !== "dir") continue;
    // The session-id suffix is always 8 hex chars preceded by a `-`.
    const m = /^(.+)-([0-9a-f]{8})$/i.exec(e.name);
    if (m && m[1]) names.add(m[1]);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ─── Stage resolution ────────────────────────────────────────────────────────

interface StageMatchResult {
  ok: true;
  dirName: string;
}

interface StageMatchFail {
  ok: false;
  reason: "missing" | "ambiguous";
  candidates: string[];
}

async function findStageDir(
  runDir: string,
  stageName: string,
  deps: WorkflowReadDeps,
): Promise<StageMatchResult | StageMatchFail> {
  let entries: string[];
  try {
    entries = await deps.readdir(runDir);
  } catch {
    return { ok: false, reason: "missing", candidates: [] };
  }
  // Match `<exactName>-<8hex>` so a stage named `step-1` isn't shadowed by
  // a stage named `step-1-extra` (whose suffix `extra-XXXXXXXX` would match
  // a loose `<name>-*` glob).
  const re = new RegExp(
    `^${escapeRegExp(stageName)}-[0-9a-f]{8}$`,
    "i",
  );
  const matches = entries.filter((n) => re.test(n));
  if (matches.length === 0) {
    return { ok: false, reason: "missing", candidates: extractStageNamesFromList(entries) };
  }
  if (matches.length > 1) {
    return { ok: false, reason: "ambiguous", candidates: matches };
  }
  return { ok: true, dirName: matches[0]! };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function extractStageNamesFromList(entries: readonly string[]): string[] {
  const names = new Set<string>();
  for (const e of entries) {
    const m = /^(.+)-([0-9a-f]{8})$/i.exec(e);
    if (m && m[1]) names.add(m[1]);
  }
  return [...names].sort((a, b) => a.localeCompare(b));
}

// ─── Text renderer ───────────────────────────────────────────────────────────

const SIZE_UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatSize(bytes: number): string {
  if (bytes < 0 || !Number.isFinite(bytes)) return "—";
  let n = bytes;
  let i = 0;
  while (n >= 1024 && i < SIZE_UNITS.length - 1) {
    n /= 1024;
    i += 1;
  }
  return i === 0
    ? `${Math.round(n)} ${SIZE_UNITS[i]}`
    : `${n.toFixed(1)} ${SIZE_UNITS[i]}`;
}

function renderText(payload: ReadJsonPayload): string {
  const paint = createPainter();
  const lines: string[] = [];
  lines.push("");
  if (payload.stageName !== undefined) {
    lines.push("  " + paint("dim", "stage  · ") + paint("text", payload.stageName, { bold: true }));
  }
  lines.push("  " + paint("dim", "run    · ") + paint("text", payload.runId));
  lines.push("  " + paint("dim", "path   · ") + paint("text", payload.path));

  if (payload.stages && payload.stages.length > 0) {
    lines.push("  " + paint("dim", "stages"));
    for (const name of payload.stages) {
      lines.push("    " + paint("accent", name));
    }
  }

  if (payload.files.length > 0) {
    // For run dirs, "files" means the run-level files only (the stage
    // dirs are listed under `stages` above). Filter accordingly.
    const fileEntries = payload.stages !== undefined
      ? payload.files.filter((f) => f.kind === "file")
      : payload.files;
    if (fileEntries.length > 0) {
      lines.push("  " + paint("dim", "files"));
      const widest = Math.max(...fileEntries.map((f) => f.name.length));
      for (const f of fileEntries) {
        const sizeStr = f.size === undefined ? "" : formatSize(f.size);
        const padded = f.name.padEnd(widest, " ");
        lines.push("    " + paint("text", padded) + "  " + paint("dim", sizeStr));
      }
    }
  }

  lines.push("");
  return lines.join("\n") + "\n";
}

function renderError(format: ReadFormat, error: string, hint?: string): void {
  if (format === "json") {
    const payload: ReadJsonError = { ok: false, error };
    if (hint) payload.hint = hint;
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stderr.write(`${COLORS.red}Error: ${error}${COLORS.reset}\n`);
    if (hint) process.stderr.write(`${COLORS.dim}Hint: ${hint}${COLORS.reset}\n`);
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

export async function workflowReadCommand(
  options: WorkflowReadOptions,
  deps: WorkflowReadDeps = defaultDeps,
): Promise<number> {
  const format = resolveFormat(options.format, deps.env);

  // ── Validate sessionId ───────────────────────────────────────────────────
  if (!options.sessionId) {
    renderError(
      format,
      "missing required flag --sessionId",
      "pass either the full tmux name (atomic-wf-<agent>-<name>-<runId>) or the bare 8-hex run id; use 'atomic workflow status' to discover it",
    );
    return 1;
  }

  const runId = resolveRunId(options.sessionId);
  if (!runId) {
    renderError(
      format,
      `"${options.sessionId}" is not a valid session id`,
      "expected either an 'atomic-wf-…' tmux name or a bare 8-hex run id",
    );
    return 1;
  }

  // ── Locate run dir ───────────────────────────────────────────────────────
  const runDir = join(deps.sessionsBaseDir(), runId);
  try {
    await deps.readdir(runDir);
  } catch {
    renderError(
      format,
      `no session directory at ${runDir}`,
      "the workflow may have been killed and reaped; check 'atomic workflow status' for live runs",
    );
    return 1;
  }

  // ── Branch on --stageId ──────────────────────────────────────────────────
  if (options.stageId) {
    const match = await findStageDir(runDir, options.stageId, deps);
    if (!match.ok) {
      if (match.reason === "missing") {
        const hint = match.candidates.length > 0
          ? `available stages in this run: ${match.candidates.join(", ")}`
          : "this run has no stage subdirectories yet — check 'atomic workflow status' for stage names";
        renderError(format, `no stage named "${options.stageId}" in run ${runId}`, hint);
      } else {
        renderError(
          format,
          `stage "${options.stageId}" matches multiple directories in run ${runId}: ${match.candidates.join(", ")}`,
          "this should not happen — workflow rule 4 requires unique stage names. File a bug.",
        );
      }
      return 1;
    }
    const stageDir = join(runDir, match.dirName);
    const files = await listEntries(stageDir, deps);
    const payload: ReadJsonPayload = {
      ok: true,
      runId,
      stageName: options.stageId,
      path: stageDir,
      files,
    };
    if (format === "json") {
      process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    } else {
      process.stdout.write(renderText(payload));
    }
    return 0;
  }

  // ── Run dir output (no --stageId) ────────────────────────────────────────
  const files = await listEntries(runDir, deps);
  const stages = extractStageNames(files);
  const payload: ReadJsonPayload = {
    ok: true,
    runId,
    path: runDir,
    files,
    stages,
  };
  if (format === "json") {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
  } else {
    process.stdout.write(renderText(payload));
  }
  return 0;
}

/**
 * Helper for spawning the attached `atomic _footer` pane inside an agent
 * tmux window.
 *
 * Shared between the workflow executor (per-agent windows) and the chat
 * command (single-agent window). Splits the target pane vertically so the
 * top pane keeps running the agent CLI and the bottom pane hosts the
 * React footer.
 *
 * Resolves the CLI entrypoint relative to this module (runtime/ lives at
 * src/sdk/runtime/, so ../../cli.ts is the CLI). `process.argv[1]` points
 * at the worker entrypoint when called from the orchestrator,
 * so it can't be used here.
 */

import { posix, win32 } from "node:path";
import type { AgentType } from "../types.ts";
import { getMuxBinary, tmuxRun } from "./tmux.ts";
import { isCompiledBinaryRuntime } from "../lib/runtime-env.ts";

/**
 * Rows reserved for the footer pane. Matches the single-row height of
 * `AttachedStatusline` so the agent pane absorbs all remaining space.
 */
const FOOTER_PANE_LINES = 1;

/** Escape a string for safe interpolation inside a bash double-quoted string. */
function escBash(s: string): string {
  return s
    .replace(/\x00/g, "")
    .replace(/[\n\r]+/g, " ")
    .replace(/[\\"$`!]/g, "\\$&");
}

/** Escape a string as a PowerShell single-quoted literal. */
function quotePwshLiteral(s: string): string {
  return `'${s
    .replace(/\x00/g, "")
    .replace(/[\n\r]+/g, " ")
    .replace(/'/g, "''")}'`;
}

function encodePwshCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function resolveAttachedFooterCliPath(
  runtimeDir = import.meta.dir, // runtime-asset: dev-only
  platform: NodeJS.Platform = process.platform,
): string {
  if (isCompiledBinaryRuntime(runtimeDir)) {
    // In a compiled binary, the CLI is the binary itself.
    return process.execPath;
  }
  // runtimeDir is packages/atomic-sdk/src/runtime/
  // Walk up 3 levels to reach packages/, then down into atomic/src/cli.ts
  return platform === "win32"
    ? win32.join(runtimeDir, "..", "..", "..", "atomic", "src", "cli.ts")
    : posix.join(runtimeDir, "..", "..", "..", "atomic", "src", "cli.ts");
}

export function buildAttachedFooterCommand({
  runtime,
  cliPath,
  windowName,
  agentType,
  platform = process.platform,
}: {
  runtime: string;
  cliPath: string;
  windowName: string;
  agentType?: AgentType;
  platform?: NodeJS.Platform;
}): string {
  // In dev (`bun cli.ts _footer …`) the runtime (`bun`) and cli script
  // (`cli.ts`) are distinct files and both must appear on the command line.
  // In a compiled binary `process.execPath` is the binary itself, so runtime
  // === cliPath; emitting both would put two copies of the binary path in
  // argv. Bun's compiled binary already injects argv[1] = binary (Node-compat)
  // so Commander's default `slice(2)` then sees the surplus `<binary>` token
  // as the first user arg, fails to match the `_footer` subcommand, and
  // falls through to the default `chat` command — which exits with
  // "Missing agent" and leaves the footer pane blank.
  const isSelfExec = runtime === cliPath;
  if (platform === "win32") {
    const parts = [quotePwshLiteral(runtime)];
    if (!isSelfExec) parts.push(quotePwshLiteral(cliPath));
    parts.push(
      quotePwshLiteral("_footer"),
      quotePwshLiteral("--name"),
      quotePwshLiteral(windowName),
    );
    if (agentType) {
      parts.push(quotePwshLiteral("--agent"), quotePwshLiteral(agentType));
    }
    const script = parts.join(" ");
    return `pwsh -NoProfile -EncodedCommand ${encodePwshCommand(`& ${script}`)}`;
  }

  const agentFlag = agentType ? ` --agent "${escBash(agentType)}"` : "";
  const cliPart = isSelfExec ? "" : `"${escBash(cliPath)}" `;
  return (
    `"${escBash(runtime)}" ${cliPart}_footer ` +
    `--name "${escBash(windowName)}"${agentFlag}`
  );
}

export function buildAttachedFooterCloseHooks(
  agentPaneId: string,
  footerPaneId: string,
  options: { guardAgentPane?: boolean } = {},
): Array<{ event: string; command: string }> {
  const killFooter = `kill-pane -t ${footerPaneId}`;
  const paneExitedCommand = options.guardAgentPane === false
    ? killFooter
    : `if -F '#{==:#{hook_pane},${agentPaneId}}' '${killFooter}'`;

  return [
    { event: "pane-exited", command: paneExitedCommand },
    { event: "after-kill-pane", command: killFooter },
  ];
}

function muxSupportsHookPaneFormat(): boolean {
  const binary = getMuxBinary();
  return binary !== "psmux" && binary !== "pmux";
}

export function spawnAttachedFooter(
  windowName: string,
  paneId: string,
  agentType?: AgentType,
): void {
  const runtime = process.execPath;
  if (!runtime) return;
  const cliPath = resolveAttachedFooterCliPath();
  const cmd = buildAttachedFooterCommand({
    runtime,
    cliPath,
    windowName,
    agentType,
  });
  const split = tmuxRun([
    "split-window",
    "-t", paneId,
    "-v", "-l", String(FOOTER_PANE_LINES), "-d",
    "-P", "-F", "#{pane_id}",
    cmd,
  ]);
  if (!split.ok) return;
  const footerPaneId = split.stdout.trim();
  if (!footerPaneId) return;
  tmuxRun(["select-pane", "-t", paneId]);
  for (const hook of buildAttachedFooterCloseHooks(paneId, footerPaneId, {
    guardAgentPane: muxSupportsHookPaneFormat(),
  })) {
    tmuxRun([
      "set-hook",
      "-w", "-t", footerPaneId,
      hook.event,
      hook.command,
    ]);
  }
  // Pin the footer to FOOTER_PANE_LINES on every resize so the agent pane
  // absorbs all new space. Tmux's default proportional redistribution
  // would otherwise grow the footer on larger windows. Window-scoped
  // (`-w`) so other windows (e.g. the orchestrator graph) are unaffected.
  tmuxRun([
    "set-hook",
    "-w", "-t", footerPaneId,
    "window-resized",
    `resize-pane -t ${footerPaneId} -y ${FOOTER_PANE_LINES}`,
  ]);
}

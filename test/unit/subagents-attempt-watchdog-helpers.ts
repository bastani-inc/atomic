import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";

/** Shared fixtures for the subagent attempt-watchdog and model-candidate
 * filtering test suites (split to satisfy the 500-line file gate). */

export function agentConfig(): AgentConfig {
  return {
    name: "fake-worker",
    description: "Fake worker",
    source: "project",
    filePath: "fake-worker.md",
    systemPrompt: "Work.",
    systemPromptMode: "replace",
    inheritProjectContext: false,
    inheritSkills: false,
    model: "provider-a/stalled",
    fallbackModels: ["provider-b/working"],
  };
}

/** Runs `fn` with process.argv[1] pointed at a fake pi CLI script and short
 * watchdog timeouts (idle 250ms, wall 2000ms, kill grace 20ms); restores the
 * previous argv/env afterwards. */
export async function withFakeCli<T>(script: string, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-watchdog-"));
  const scriptPath = join(dir, "fake-pi.js");
  const previousArgv1 = process.argv[1];
  const previousIdle = process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS;
  const previousWall = process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS;
  const previousKill = process.env.ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS;
  writeFileSync(scriptPath, script, { mode: 0o700 });
  process.argv[1] = scriptPath;
  process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = "250";
  process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = "2000";
  process.env.ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS = "20";
  try {
    return await fn(dir);
  } finally {
    process.argv[1] = previousArgv1;
    if (previousIdle === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS;
    else process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = previousIdle;
    if (previousWall === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS;
    else process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = previousWall;
    if (previousKill === undefined) delete process.env.ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS;
    else process.env.ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS = previousKill;
    rmSync(dir, { recursive: true, force: true });
  }
}

export const successEvent = (text: string) => JSON.stringify({
  type: "message_end",
  message: {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1 },
    timestamp: Date.now(),
  },
});

export const toolStartEvent = JSON.stringify({ type: "tool_execution_start", toolName: "bash", args: { command: "sleep" } });
export const toolEndEvent = JSON.stringify({ type: "tool_execution_end", toolName: "bash" });

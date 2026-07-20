import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentConfig } from "../../packages/subagents/src/agents/agents.js";

/** Shared fixtures for the subagent attempt-watchdog and model-candidate
 * filtering test suites (split to satisfy the 500-line file gate). */

const transientRemovalCodes = new Set(["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]);

async function removeFixtureDir(dir: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : undefined;
      if (!code || !transientRemovalCodes.has(code) || attempt >= 5) throw error;
      await Bun.sleep(100 * (attempt + 1));
    }
  }
}

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

interface FakeCliEventFixture {
  delayMs: number;
  event: string;
}

const delayedEventScript = `
import { readFileSync } from "node:fs";

const fixture = JSON.parse(
  readFileSync(new URL("./fake-cli-event.json", import.meta.url), "utf8"),
);
setTimeout(() => console.log(fixture.event), fixture.delayMs);
`;

/** Runs a static fake CLI script whose delayed output is supplied separately
 * as fixture data, so arbitrary event text cannot become executable code. */
export async function withFakeCliEvent<T>(
  event: string,
  delayMs: number,
  fn: (dir: string) => Promise<T>,
  timeouts: { idleMs?: number; wallMs?: number } = {},
): Promise<T> {
  return withFakeCli(delayedEventScript, async (dir) => {
    const fixture = { delayMs, event } satisfies FakeCliEventFixture;
    writeFileSync(join(dir, "fake-cli-event.json"), JSON.stringify(fixture));
    return fn(dir);
  }, timeouts);
}

/** Runs `fn` with process.argv[1] pointed at a fake pi CLI script and bounded
 * watchdog timeouts; restores the previous argv/env afterwards. */
export async function withFakeCli<T>(
  script: string,
  fn: (dir: string) => Promise<T>,
  timeouts: { idleMs?: number; wallMs?: number } = {},
): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "atomic-subagent-watchdog-"));
  const scriptPath = join(dir, "fake-pi.js");
  const previousArgv1 = process.argv[1];
  const previousIdle = process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS;
  const previousWall = process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS;
  const previousKill = process.env.ATOMIC_SUBAGENT_ATTEMPT_KILL_GRACE_MS;
  writeFileSync(scriptPath, script, { mode: 0o700 });
  process.argv[1] = scriptPath;
  // Child-process startup can exceed a few hundred milliseconds when the full
  // unit suite is spawning many Bun fixtures. Keep the idle bound tight enough
  // for watchdog tests while avoiding false timeouts before first activity.
  process.env.ATOMIC_SUBAGENT_ATTEMPT_IDLE_TIMEOUT_MS = String(timeouts.idleMs ?? 1000);
  process.env.ATOMIC_SUBAGENT_ATTEMPT_TIMEOUT_MS = String(timeouts.wallMs ?? 4000);
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
    await removeFixtureDir(dir);
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

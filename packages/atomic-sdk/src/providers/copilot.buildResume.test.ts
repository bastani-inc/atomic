/**
 * Snapshot tests for buildCopilotResumeArgs.
 *
 * Key invariant: Copilot CLI requires `=` syntax (--resume=<id>), NOT
 * space-separated (--resume <id>). This file makes that constraint explicit.
 */

import { test, expect, describe } from "bun:test";
import { buildCopilotResumeArgs } from "./copilot.ts";

type CopilotMeta = Parameters<typeof buildCopilotResumeArgs>[0];

const FIXTURE_META: CopilotMeta = {
  agentSessionId: "cop-session-abc123def456",
  chatFlags: [],
};

describe("buildCopilotResumeArgs()", () => {
  test("returns exact array with server-mode prefix and --resume=<sessionId>", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    expect(args).toEqual(["--ui-server", "--port", "0", `--resume=${FIXTURE_META.agentSessionId}`]);
  });

  test("array length is 4 when chatFlags empty", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    expect(args).toHaveLength(4);
  });

  test("uses = syntax (not space-separated) for --resume", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    const resumeToken = args.find((a) => a.startsWith("--resume"));
    expect(resumeToken).toBeDefined();
    expect(resumeToken).toContain("=");
    // Must NOT produce a bare --resume entry (space-separated form)
    expect(args).not.toContain("--resume");
  });

  test("--resume= token is present", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    expect(args.some((a) => a.startsWith("--resume="))).toBe(true);
  });

  test("agentSessionId follows = without extra whitespace", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    expect(args).toContain(`--resume=${FIXTURE_META.agentSessionId}`);
  });

  test("different agentSessionId produces correct = form", () => {
    const args = buildCopilotResumeArgs({ agentSessionId: "other-cop-id", chatFlags: [] });
    expect(args).toEqual(["--ui-server", "--port", "0", "--resume=other-cop-id"]);
  });

  test("server-mode flags --ui-server --port 0 precede --resume", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    const uiIdx = args.indexOf("--ui-server");
    const portIdx = args.indexOf("--port");
    const resumeIdx = args.findIndex((a) => a.startsWith("--resume="));
    expect(uiIdx).toBeGreaterThanOrEqual(0);
    expect(portIdx).toBeGreaterThan(uiIdx);
    expect(resumeIdx).toBeGreaterThan(portIdx);
  });
});

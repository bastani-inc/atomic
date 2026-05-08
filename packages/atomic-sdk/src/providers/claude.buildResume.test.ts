/**
 * Snapshot tests for buildClaudeResumeArgs.
 *
 * Verifies the exact argv array shape without coupling to the temp-file
 * path (which is a content-hash based path under ~/.atomic/tmp/).
 */

import { test, expect, describe } from "bun:test";
import { buildClaudeResumeArgs } from "./claude.ts";

const FIXTURE_META = {
  agentSessionId: "9f3a8f1d-1c0e-4b1f-9a2f-5e7d8b0e1a23",
};

describe("buildClaudeResumeArgs()", () => {
  test("returns array with --resume flag at index 0", () => {
    const args = buildClaudeResumeArgs(FIXTURE_META);
    expect(args[0]).toBe("--resume");
  });

  test("places agentSessionId at index 1", () => {
    const args = buildClaudeResumeArgs(FIXTURE_META);
    expect(args[1]).toBe(FIXTURE_META.agentSessionId);
  });

  test("includes --allow-dangerously-skip-permissions flag", () => {
    const args = buildClaudeResumeArgs(FIXTURE_META);
    expect(args).toContain("--allow-dangerously-skip-permissions");
  });

  test("includes --dangerously-skip-permissions flag", () => {
    const args = buildClaudeResumeArgs(FIXTURE_META);
    expect(args).toContain("--dangerously-skip-permissions");
  });

  test("includes --settings flag followed by a .json path", () => {
    const args = buildClaudeResumeArgs(FIXTURE_META);
    const settingsIdx = args.indexOf("--settings");
    expect(settingsIdx).toBeGreaterThan(-1);
    const settingsPath = args[settingsIdx + 1];
    expect(settingsPath).toBeDefined();
    expect(settingsPath).toMatch(/\.json$/);
  });

  test("exact structure: [--resume, <id>, ...chatFlags, --settings, <path>]", () => {
    const args = buildClaudeResumeArgs(FIXTURE_META);
    // Must start with resume pair
    expect(args.slice(0, 2)).toEqual(["--resume", FIXTURE_META.agentSessionId]);
    // Must end with settings pair
    const lastTwo = args.slice(-2);
    expect(lastTwo[0]).toBe("--settings");
    expect(lastTwo[1]).toMatch(/\.json$/);
    // Total length: 2 (resume) + 2 (chatFlags) + 2 (settings) = 6
    expect(args).toHaveLength(6);
  });

  test("different agentSessionId produces different resume arg", () => {
    const args1 = buildClaudeResumeArgs({ agentSessionId: "uuid-aaa" });
    const args2 = buildClaudeResumeArgs({ agentSessionId: "uuid-bbb" });
    expect(args1[1]).toBe("uuid-aaa");
    expect(args2[1]).toBe("uuid-bbb");
  });

  test("settings path is same across calls (content-addressed)", () => {
    const args1 = buildClaudeResumeArgs(FIXTURE_META);
    const args2 = buildClaudeResumeArgs(FIXTURE_META);
    const path1 = args1[args1.indexOf("--settings") + 1];
    const path2 = args2[args2.indexOf("--settings") + 1];
    expect(path1).toBe(path2);
  });
});

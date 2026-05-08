/**
 * Snapshot tests for buildCopilotResumeArgs.
 *
 * Key invariant: Copilot CLI requires `=` syntax (--resume=<id>), NOT
 * space-separated (--resume <id>). This file makes that constraint explicit.
 */

import { test, expect, describe } from "bun:test";
import { buildCopilotResumeArgs } from "./copilot.ts";

const FIXTURE_META = {
  agentSessionId: "cop-session-abc123def456",
};

describe("buildCopilotResumeArgs()", () => {
  test("returns exact array [--resume=<sessionId>]", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    expect(args).toEqual([`--resume=${FIXTURE_META.agentSessionId}`]);
  });

  test("array length is 1", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    expect(args).toHaveLength(1);
  });

  test("uses = syntax (not space-separated)", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    // Must be a single token containing '='
    expect(args[0]).toContain("=");
    // Must NOT produce two separate argv entries
    expect(args).not.toContain("--resume");
  });

  test("--resume= prefix is present", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    expect(args[0]).toMatch(/^--resume=/);
  });

  test("agentSessionId follows = without extra whitespace", () => {
    const args = buildCopilotResumeArgs(FIXTURE_META);
    expect(args[0]).toBe(`--resume=${FIXTURE_META.agentSessionId}`);
  });

  test("different agentSessionId produces correct = form", () => {
    const args = buildCopilotResumeArgs({ agentSessionId: "other-cop-id" });
    expect(args).toEqual(["--resume=other-cop-id"]);
  });
});

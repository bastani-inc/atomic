/**
 * Snapshot tests for buildOpencodeResumeArgs.
 */

import { test, expect, describe } from "bun:test";
import { buildOpencodeResumeArgs } from "./opencode.ts";

const FIXTURE_META = {
  agentSessionId: "oc-session-7f3a2c1d-abcd-1234-5678-000000000001",
};

describe("buildOpencodeResumeArgs()", () => {
  test("returns exact array [--session, <sessionId>]", () => {
    const args = buildOpencodeResumeArgs(FIXTURE_META);
    expect(args).toEqual(["--session", FIXTURE_META.agentSessionId]);
  });

  test("array length is 2", () => {
    const args = buildOpencodeResumeArgs(FIXTURE_META);
    expect(args).toHaveLength(2);
  });

  test("flag is --session (not --session-id or --resume)", () => {
    const args = buildOpencodeResumeArgs(FIXTURE_META);
    expect(args[0]).toBe("--session");
  });

  test("agentSessionId is second element verbatim", () => {
    const args = buildOpencodeResumeArgs(FIXTURE_META);
    expect(args[1]).toBe(FIXTURE_META.agentSessionId);
  });

  test("different agentSessionId produces correct args", () => {
    const args = buildOpencodeResumeArgs({ agentSessionId: "other-session" });
    expect(args).toEqual(["--session", "other-session"]);
  });
});

/**
 * Snapshot tests for buildOpencodeResumeArgs.
 */

import { test, expect, describe } from "bun:test";
import { buildOpencodeResumeArgs } from "./opencode.ts";

type OpencodeMeta = Parameters<typeof buildOpencodeResumeArgs>[0];

const FIXTURE_META: OpencodeMeta = {
  agentSessionId: "oc-session-7f3a2c1d-abcd-1234-5678-000000000001",
  chatFlags: [],
};

describe("buildOpencodeResumeArgs()", () => {
  test("returns exact array with server-mode prefix and [--session, <sessionId>]", () => {
    const args = buildOpencodeResumeArgs(FIXTURE_META);
    expect(args).toEqual(["--port", "0", "--session", FIXTURE_META.agentSessionId]);
  });

  test("array length is 4 when chatFlags empty", () => {
    const args = buildOpencodeResumeArgs(FIXTURE_META);
    expect(args).toHaveLength(4);
  });

  test("--session token is present (not --session-id or --resume)", () => {
    const args = buildOpencodeResumeArgs(FIXTURE_META);
    expect(args).toContain("--session");
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  test("agentSessionId follows --session", () => {
    const args = buildOpencodeResumeArgs(FIXTURE_META);
    const sessionIdx = args.indexOf("--session");
    expect(args[sessionIdx + 1]).toBe(FIXTURE_META.agentSessionId);
  });

  test("different agentSessionId produces correct args", () => {
    const args = buildOpencodeResumeArgs({ agentSessionId: "other-session", chatFlags: [] });
    expect(args).toEqual(["--port", "0", "--session", "other-session"]);
  });

  test("server-mode flag --port 0 precedes --session", () => {
    const args = buildOpencodeResumeArgs(FIXTURE_META);
    const portIdx = args.indexOf("--port");
    const sessionIdx = args.indexOf("--session");
    expect(portIdx).toBe(0);
    expect(args[portIdx + 1]).toBe("0");
    expect(sessionIdx).toBeGreaterThan(portIdx);
  });
});

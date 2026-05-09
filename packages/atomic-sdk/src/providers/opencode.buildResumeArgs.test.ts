/**
 * RFC §5.4 tests for buildOpencodeResumeArgs — empty agentSessionId guards
 * + chatFlags pass-through.
 */

import { test, expect, describe } from "bun:test";
import { buildOpencodeResumeArgs } from "./opencode.ts";

type OpencodeMeta = Parameters<typeof buildOpencodeResumeArgs>[0];
function meta(agentSessionId: string, chatFlags: string[] = []): OpencodeMeta {
  return { agentSessionId, chatFlags };
}

describe("buildOpencodeResumeArgs() — empty agentSessionId guards (RFC §5.4)", () => {
  // Guard: empty string
  test('throws "empty agentSessionId on resume" when agentSessionId is empty string', () => {
    expect(() =>
      buildOpencodeResumeArgs(meta("")),
    ).toThrow("empty agentSessionId on resume");
  });

  // Guard: null
  test('throws "empty agentSessionId on resume" when agentSessionId is null', () => {
    expect(() =>
      buildOpencodeResumeArgs({
        agentSessionId: null as unknown as string,
        chatFlags: [],
      }),
    ).toThrow("empty agentSessionId on resume");
  });

  // RFC §5.4 §3 — no sentinel Enter token
  test("valid agentSessionId: returned args do not contain the string Enter", () => {
    const args = buildOpencodeResumeArgs(meta("oc-session-valid-001"));
    expect(args).not.toContain("Enter");
  });

  // RFC §5.4 — chatFlags threading

  test("chatFlags: [] (empty array) produces server-mode prefix + ['--session', id]", () => {
    const args = buildOpencodeResumeArgs(meta("oc-123", []));
    expect(args).toEqual(["--port", "0", "--session", "oc-123"]);
  });

  test("chatFlags: ['--model', 'opus'] → appended after session id", () => {
    const args = buildOpencodeResumeArgs(meta("oc-123", ["--model", "opus"]));
    expect(args).toEqual(["--port", "0", "--session", "oc-123", "--model", "opus"]);
  });

  test("chatFlags: ['--add-dir', '/some/path'] → preserved verbatim", () => {
    const args = buildOpencodeResumeArgs(meta("oc-123", ["--add-dir", "/some/path"]));
    expect(args).toEqual(["--port", "0", "--session", "oc-123", "--add-dir", "/some/path"]);
  });
});

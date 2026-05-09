/**
 * RFC §5.4 tests for buildCopilotResumeArgs — empty agentSessionId guards
 * + chatFlags pass-through.
 */

import { test, expect, describe } from "bun:test";
import { buildCopilotResumeArgs } from "./copilot.ts";

type CopilotMeta = Parameters<typeof buildCopilotResumeArgs>[0];
function meta(agentSessionId: string, chatFlags: string[] = []): CopilotMeta {
  return { agentSessionId, chatFlags };
}

describe("buildCopilotResumeArgs() — empty agentSessionId guards (RFC §5.4)", () => {
  // Guard: empty string
  test('throws "empty agentSessionId on resume" when agentSessionId is empty string', () => {
    expect(() =>
      buildCopilotResumeArgs(meta("")),
    ).toThrow("empty agentSessionId on resume");
  });

  // Guard: null
  test('throws "empty agentSessionId on resume" when agentSessionId is null', () => {
    expect(() =>
      buildCopilotResumeArgs({
        agentSessionId: null as unknown as string,
        chatFlags: [],
      }),
    ).toThrow("empty agentSessionId on resume");
  });

  // RFC §5.4 §3 — no sentinel Enter token
  test("valid agentSessionId: returned args do not contain the string Enter", () => {
    const args = buildCopilotResumeArgs(meta("cop-session-valid-001"));
    expect(args).not.toContain("Enter");
  });

  // RFC §5.4 — chatFlags threading

  test("chatFlags: [] (empty array) produces server-mode prefix + --resume=id", () => {
    const args = buildCopilotResumeArgs(meta("cop-123", []));
    expect(args).toEqual(["--ui-server", "--port", "0", "--resume=cop-123"]);
  });

  test("chatFlags: ['--model', 'opus'] → appended after --resume=id", () => {
    const args = buildCopilotResumeArgs(meta("cop-123", ["--model", "opus"]));
    expect(args).toEqual(["--ui-server", "--port", "0", "--resume=cop-123", "--model", "opus"]);
  });

  test("chatFlags: ['--add-dir', '/some/path'] → preserved verbatim", () => {
    const args = buildCopilotResumeArgs(meta("cop-123", ["--add-dir", "/some/path"]));
    expect(args).toEqual(["--ui-server", "--port", "0", "--resume=cop-123", "--add-dir", "/some/path"]);
  });

  test("chatFlags: ['--deny-tool', 'shell(git)'] → SCM-disable extra preserved", () => {
    const args = buildCopilotResumeArgs(meta("cop-123", ["--deny-tool", "shell(git)"]));
    expect(args).toEqual(["--ui-server", "--port", "0", "--resume=cop-123", "--deny-tool", "shell(git)"]);
  });
});

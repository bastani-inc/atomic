import { test, expect, describe } from "bun:test";
import {
  listSessions,
  getSession,
  getSessionStatus,
  getSessionTranscript,
} from "../../../src/sdk/primitives/sessions.ts";

describe("primitives/sessions", () => {
  test("listSessions returns an array (may be empty)", () => {
    const result = listSessions();
    expect(Array.isArray(result)).toBe(true);
  });

  test("getSession returns undefined for non-existent ids", () => {
    expect(getSession("does-not-exist-123")).toBeUndefined();
  });

  test("getSessionStatus returns null for invalid tmux name", () => {
    expect(
      getSessionStatus("not-an-atomic-session"),
    ).resolves.toBeNull();
  });

  test("getSessionTranscript returns [] for invalid tmux name", () => {
    expect(getSessionTranscript("nope", "stage")).resolves.toEqual([]);
  });
});

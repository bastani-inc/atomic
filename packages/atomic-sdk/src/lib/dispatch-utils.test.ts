/**
 * Tests for `src/lib/dispatch-utils.ts`.
 *
 * Covers validateDispatchToken, findSub, and parseAtomicRunArgv.
 */

import { describe, test, expect } from "bun:test";
import {
  validateDispatchToken,
  findSub,
  parseAtomicRunArgv,
} from "./dispatch-utils.ts";

// ─── validateDispatchToken ────────────────────────────────────────────────────

describe("validateDispatchToken", () => {
  const validToken = "deadbeef01234567deadbeef01234567"; // 32 hex chars

  test("returns false when ATOMIC_HOST is not '1'", () => {
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "0", ATOMIC_DISPATCH_TOKEN: validToken },
        [`--dispatch-token=${validToken}`],
      ),
    ).toBe(false);
  });

  test("returns false when ATOMIC_DISPATCH_TOKEN is missing", () => {
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1" },
        [`--dispatch-token=${validToken}`],
      ),
    ).toBe(false);
  });

  test("returns false when ATOMIC_DISPATCH_TOKEN is too short", () => {
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: "short" },
        [`--dispatch-token=${validToken}`],
      ),
    ).toBe(false);
  });

  test("returns false when ATOMIC_DISPATCH_TOKEN contains non-hex chars", () => {
    const badToken = "xxxx".repeat(8); // 32 chars but not hex
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: badToken },
        [`--dispatch-token=${validToken}`],
      ),
    ).toBe(false);
  });

  // ← Line 43: !tokenArg return false
  test("returns false when argv does not contain --dispatch-token arg", () => {
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: validToken },
        ["--name", "my-wf", "--agent", "claude"],
      ),
    ).toBe(false);
  });

  // ← Line 52: argToken invalid
  test("returns false when argv dispatch-token arg value is too short", () => {
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: validToken },
        ["--dispatch-token=short"],
      ),
    ).toBe(false);
  });

  test("returns false when argv dispatch-token arg value contains non-hex chars", () => {
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: validToken },
        [`--dispatch-token=${"xx".repeat(16)}`],
      ),
    ).toBe(false);
  });

  test("returns false when tokens don't match (case-insensitive)", () => {
    const envToken = "aabbccdd00112233aabbccdd00112233";
    const argToken = "deadbeef01234567deadbeef01234567";
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: envToken },
        [`--dispatch-token=${argToken}`],
      ),
    ).toBe(false);
  });

  test("returns true when all conditions pass (exact match)", () => {
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: validToken },
        [`--dispatch-token=${validToken}`],
      ),
    ).toBe(true);
  });

  test("returns true when tokens match case-insensitively", () => {
    const lower = "deadbeef01234567deadbeef01234567";
    const upper = "DEADBEEF01234567DEADBEEF01234567";
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: lower },
        [`--dispatch-token=${upper}`],
      ),
    ).toBe(true);
  });

  test("ignores extra argv tokens before dispatch-token", () => {
    expect(
      validateDispatchToken(
        { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: validToken },
        ["--name", "wf", "--agent", "claude", `--dispatch-token=${validToken}`, "--detach"],
      ),
    ).toBe(true);
  });
});

// ─── findSub ─────────────────────────────────────────────────────────────────

describe("findSub", () => {
  test("returns null when argv has fewer than 3 elements", () => {
    expect(findSub(["node", "script"])).toBeNull();
  });

  test("returns null when no known sub-command is in argv", () => {
    expect(findSub(["node", "script", "--name", "my-wf", "--agent", "claude"])).toBeNull();
  });

  // ← Lines 76-80: findSub function body
  test("finds _orchestrator-entry at index 2", () => {
    const result = findSub(["node", "script", "_orchestrator-entry", "--extra"]);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("_orchestrator-entry");
    expect(result!.index).toBe(2);
  });

  test("finds _cc-debounce at index 2", () => {
    const result = findSub(["node", "script", "_cc-debounce"]);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("_cc-debounce");
    expect(result!.index).toBe(2);
  });

  test("finds sub-command at later index (after other args)", () => {
    const result = findSub(["node", "script", "--some-flag", "_orchestrator-entry"]);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("_orchestrator-entry");
    expect(result!.index).toBe(3);
  });

  test("returns first matching sub-command when multiple are present", () => {
    const result = findSub(["node", "script", "_cc-debounce", "_orchestrator-entry"]);
    expect(result).not.toBeNull();
    expect(result!.sub).toBe("_cc-debounce");
    expect(result!.index).toBe(2);
  });

  test("does not confuse positional args with sub-commands", () => {
    // "orchestrator-entry" without underscore prefix should NOT match
    expect(findSub(["node", "script", "orchestrator-entry"])).toBeNull();
  });
});

// ─── parseAtomicRunArgv ───────────────────────────────────────────────────────

describe("parseAtomicRunArgv", () => {
  test("returns empty result for empty argv", () => {
    const result = parseAtomicRunArgv([]);
    expect(result.name).toBeUndefined();
    expect(result.agent).toBeUndefined();
    expect(result.detach).toBe(false);
    expect(result.inputs).toEqual({});
  });

  test("parses --name and --agent", () => {
    const result = parseAtomicRunArgv(["--name", "my-wf", "--agent", "claude"]);
    expect(result.name).toBe("my-wf");
    expect(result.agent).toBe("claude");
  });

  test("parses --detach flag", () => {
    const result = parseAtomicRunArgv(["--detach"]);
    expect(result.detach).toBe(true);
  });

  test("skips --dispatch-token= tokens", () => {
    const result = parseAtomicRunArgv([
      "--dispatch-token=deadbeef01234567deadbeef01234567",
      "--name", "wf",
    ]);
    expect(result.inputs).not.toHaveProperty("dispatch-token");
    expect(result.name).toBe("wf");
  });

  test("collects arbitrary --key value pairs as inputs", () => {
    const result = parseAtomicRunArgv([
      "--name", "wf",
      "--agent", "claude",
      "--prompt", "fix the bug",
      "--max-loops", "5",
    ]);
    expect(result.inputs["prompt"]).toBe("fix the bug");
    expect(result.inputs["max-loops"]).toBe("5");
  });

  test("handles value starting with -- without confusion", () => {
    // --rev --origin/main should parse as inputs.rev = "--origin/main"
    const result = parseAtomicRunArgv(["--rev", "--origin/main"]);
    expect(result.inputs["rev"]).toBe("--origin/main");
  });
});

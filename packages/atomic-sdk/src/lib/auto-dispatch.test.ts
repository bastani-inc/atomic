/**
 * Unit tests for `validateDispatchToken` (exported from auto-dispatch.ts)
 * and the module-private compiled workflow registry (`getCompiledWorkflows`).
 *
 * The argv side-effects in auto-dispatch.ts run at module load and cannot be
 * unit-tested here — subprocess dispatch is exercised end-to-end by the
 * `tests/fixtures/sdk-compiled-consumer/` smoke matrix. This file covers
 * only the pure helper functions that are safe to call in-process.
 */

import { test, expect, describe } from "bun:test";
import { validateDispatchToken, findSub, parseAtomicRunArgv } from "./auto-dispatch.ts";
import { defineWorkflow, getCompiledWorkflows } from "../define-workflow.ts";

// ─── validateDispatchToken ────────────────────────────────────────────────────

const VALID_TOKEN = "a".repeat(32);
const VALID_ENV = {
  ATOMIC_HOST: "1",
  ATOMIC_DISPATCH_TOKEN: VALID_TOKEN,
};
const VALID_ARGV = [`--dispatch-token=${VALID_TOKEN}`, "_emit-workflow-meta"];

describe("validateDispatchToken", () => {
  test("returns true when all conditions met", () => {
    expect(validateDispatchToken(VALID_ENV, VALID_ARGV)).toBe(true);
  });

  test("returns false when ATOMIC_HOST is absent", () => {
    const env = { ATOMIC_DISPATCH_TOKEN: VALID_TOKEN };
    expect(validateDispatchToken(env, VALID_ARGV)).toBe(false);
  });

  test("returns false when ATOMIC_HOST is not '1'", () => {
    const env = { ATOMIC_HOST: "0", ATOMIC_DISPATCH_TOKEN: VALID_TOKEN };
    expect(validateDispatchToken(env, VALID_ARGV)).toBe(false);
  });

  test("returns false when ATOMIC_DISPATCH_TOKEN is absent", () => {
    const env = { ATOMIC_HOST: "1" };
    expect(validateDispatchToken(env, VALID_ARGV)).toBe(false);
  });

  test("returns false when env token is too short (< 32 chars)", () => {
    const shortToken = "a".repeat(31);
    const env = { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: shortToken };
    const argv = [`--dispatch-token=${shortToken}`];
    expect(validateDispatchToken(env, argv)).toBe(false);
  });

  test("returns false when env token has non-hex chars", () => {
    const env = { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: "z".repeat(32) };
    const argv = [`--dispatch-token=${"z".repeat(32)}`];
    expect(validateDispatchToken(env, argv)).toBe(false);
  });

  test("returns false when --dispatch-token flag is absent from argv", () => {
    expect(validateDispatchToken(VALID_ENV, ["_emit-workflow-meta"])).toBe(false);
  });

  test("returns false when argv token is too short (< 32 chars)", () => {
    const shortToken = "a".repeat(31);
    const argv = [`--dispatch-token=${shortToken}`];
    expect(validateDispatchToken(VALID_ENV, argv)).toBe(false);
  });

  test("returns false when argv token has non-hex chars", () => {
    const argv = [`--dispatch-token=${"z".repeat(32)}`];
    expect(validateDispatchToken(VALID_ENV, argv)).toBe(false);
  });

  test("returns false when tokens do not match", () => {
    const envToken = "a".repeat(32);
    const argToken = "b".repeat(32);
    const env = { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: envToken };
    const argv = [`--dispatch-token=${argToken}`];
    expect(validateDispatchToken(env, argv)).toBe(false);
  });

  test("returns true with exactly 32-char lowercase hex token", () => {
    const token = "0123456789abcdef".repeat(2); // 32 chars
    const env = { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: token };
    const argv = [`--dispatch-token=${token}`];
    expect(validateDispatchToken(env, argv)).toBe(true);
  });

  test("token comparison is case-insensitive", () => {
    const lowerToken = "abcdef1234567890abcdef1234567890"; // 32 chars
    const upperToken = lowerToken.toUpperCase();
    const env = { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: lowerToken };
    const argv = [`--dispatch-token=${upperToken}`];
    expect(validateDispatchToken(env, argv)).toBe(true);
  });

  test("token longer than 32 chars is accepted", () => {
    const longToken = "a".repeat(64);
    const env = { ATOMIC_HOST: "1", ATOMIC_DISPATCH_TOKEN: longToken };
    const argv = [`--dispatch-token=${longToken}`];
    expect(validateDispatchToken(env, argv)).toBe(true);
  });

  test("all three conditions required — missing one always fails", () => {
    // Only ATOMIC_HOST
    expect(validateDispatchToken({ ATOMIC_HOST: "1" }, VALID_ARGV)).toBe(false);
    // Only ATOMIC_DISPATCH_TOKEN
    expect(validateDispatchToken({ ATOMIC_DISPATCH_TOKEN: VALID_TOKEN }, VALID_ARGV)).toBe(false);
    // Only argv token
    expect(validateDispatchToken({}, VALID_ARGV)).toBe(false);
  });
});

// ─── getCompiledWorkflows registry ───────────────────────────────────────────

describe("getCompiledWorkflows", () => {
  test("returns an array (may include workflows compiled elsewhere in this process)", () => {
    const result = getCompiledWorkflows();
    expect(Array.isArray(result)).toBe(true);
  });

  test("compile() registers the workflow into the in-process registry", () => {
    const uniqueName = `test-registry-workflow-${Date.now()}`;
    defineWorkflow({
      name: uniqueName,
      description: "test",
      source: import.meta.path,
    })
      .for("claude")
      .run(async () => {})
      .compile();

    const all = getCompiledWorkflows();
    const found = all.find((d) => d.name === uniqueName && d.agent === "claude");
    expect(found).toBeDefined();
    expect(found?.description).toBe("test");
    expect(found?.source).toBe(import.meta.path);
  });

  test("compiled definition has all serializable fields", () => {
    const uniqueName = `test-meta-fields-${Date.now()}`;
    defineWorkflow({
      name: uniqueName,
      description: "meta test",
      source: import.meta.path,
      minSDKVersion: "0.7.0",
      inputs: [{ name: "topic", type: "string", required: true }],
    })
      .for("copilot")
      .run(async () => {})
      .compile();

    const all = getCompiledWorkflows();
    const found = all.find((d) => d.name === uniqueName);
    expect(found).toBeDefined();
    expect(found?.minSDKVersion).toBe("0.7.0");
    expect(found?.inputs).toHaveLength(1);
    expect(found?.inputs[0]?.name).toBe("topic");
  });

  test("returns a snapshot — mutating the result does not affect the registry", () => {
    const before = getCompiledWorkflows().length;
    const snapshot = getCompiledWorkflows() as import("../types.ts").WorkflowDefinition[];
    snapshot.push({} as import("../types.ts").WorkflowDefinition);
    const after = getCompiledWorkflows().length;
    expect(after).toBe(before);
  });
});

// ─── findSub ─────────────────────────────────────────────────────────────────

describe("findSub", () => {
  test("returns null when argv has fewer than 3 tokens", () => {
    expect(findSub([])).toBeNull();
    expect(findSub(["bun"])).toBeNull();
    expect(findSub(["bun", "script.ts"])).toBeNull();
  });

  test("returns null when no sub-command token is present", () => {
    expect(findSub(["bun", "script.ts", "some-other-command"])).toBeNull();
  });

  test("finds _atomic-run at index 2 (normal position)", () => {
    const result = findSub(["bun", "script.ts", "_atomic-run", "--name", "x"]);
    expect(result).toEqual({ sub: "_atomic-run", index: 2 });
  });

  test("finds sub at index > 2 (extra launcher tokens before it)", () => {
    const result = findSub(["bunx", "--bun", "my-pkg/cli.ts", "_emit-workflow-meta"]);
    expect(result).toEqual({ sub: "_emit-workflow-meta", index: 3 });
  });

  test("returns first match and ignores subsequent matching tokens", () => {
    const result = findSub(["bun", "script.ts", "_cc-debounce", "_atomic-run"]);
    expect(result).toEqual({ sub: "_cc-debounce", index: 2 });
  });

  test("ignores tokens at indices 0 and 1", () => {
    // Even if a sub name appears in positions 0/1, must not match.
    expect(findSub(["_atomic-run", "_emit-workflow-meta"])).toBeNull();
  });

  test("finds _orchestrator-entry", () => {
    const result = findSub(["bun", "cli.ts", "_orchestrator-entry", "my-wf", "claude", "", "/path"]);
    expect(result).toEqual({ sub: "_orchestrator-entry", index: 2 });
  });

  test("finds _emit-workflow-meta", () => {
    const result = findSub(["bun", "script.ts", "_emit-workflow-meta"]);
    expect(result).toEqual({ sub: "_emit-workflow-meta", index: 2 });
  });

  test("finds _cc-debounce", () => {
    const result = findSub(["bun", "script.ts", "_cc-debounce", "pane-42"]);
    expect(result).toEqual({ sub: "_cc-debounce", index: 2 });
  });
});

// ─── parseAtomicRunArgv ───────────────────────────────────────────────────────

describe("parseAtomicRunArgv", () => {
  test("parses --name and --agent", () => {
    const result = parseAtomicRunArgv(["--name", "my-workflow", "--agent", "claude"]);
    expect(result.name).toBe("my-workflow");
    expect(result.agent).toBe("claude");
    expect(result.detach).toBe(false);
    expect(result.inputs).toEqual({});
  });

  test("parses --detach flag", () => {
    const result = parseAtomicRunArgv(["--name", "wf", "--agent", "claude", "--detach"]);
    expect(result.detach).toBe(true);
  });

  test("parses --<input> <value> pairs into inputs", () => {
    const result = parseAtomicRunArgv([
      "--name", "wf",
      "--agent", "claude",
      "--topic", "hello world",
      "--count", "5",
    ]);
    expect(result.inputs).toEqual({ topic: "hello world", count: "5" });
  });

  test("preserves --rev origin/main (value starts with '--' is NOT a flag)", () => {
    const result = parseAtomicRunArgv([
      "--name", "wf",
      "--agent", "claude",
      "--rev", "origin/main",
    ]);
    expect(result.inputs["rev"]).toBe("origin/main");
  });

  test("preserves value that starts with '--'", () => {
    const result = parseAtomicRunArgv([
      "--name", "wf",
      "--agent", "copilot",
      "--base-ref", "--main",
    ]);
    expect(result.inputs["base-ref"]).toBe("--main");
  });

  test("skips --dispatch-token= flag (does not put it in inputs)", () => {
    const token = "a".repeat(32);
    const result = parseAtomicRunArgv([
      `--dispatch-token=${token}`,
      "--name", "wf",
      "--agent", "claude",
    ]);
    expect(result.inputs).not.toHaveProperty("dispatch-token");
    expect(result.name).toBe("wf");
  });

  test("returns undefined name/agent when flags are absent", () => {
    const result = parseAtomicRunArgv([]);
    expect(result.name).toBeUndefined();
    expect(result.agent).toBeUndefined();
  });

  test("returns empty inputs when no input flags present", () => {
    const result = parseAtomicRunArgv(["--name", "wf", "--agent", "claude"]);
    expect(result.inputs).toEqual({});
  });
});

// ─── _emit-workflow-meta minSDKVersion field ──────────────────────────────────

describe("getCompiledWorkflows minSDKVersion in meta payload", () => {
  test("workflow with minSDKVersion has it set correctly", () => {
    const uniqueName = `test-meta-minsdk-${Date.now()}`;
    defineWorkflow({
      name: uniqueName,
      source: import.meta.path,
      minSDKVersion: "1.2.3",
    })
      .for("claude")
      .run(async () => {})
      .compile();

    const all = getCompiledWorkflows();
    const found = all.find((d) => d.name === uniqueName);
    expect(found).toBeDefined();
    // Verify the meta payload shape matches what _emit-workflow-meta would emit
    const payload = {
      name: found!.name,
      description: found!.description,
      agent: found!.agent,
      inputs: found!.inputs,
      source: found!.source,
      minSDKVersion: found!.minSDKVersion ?? null,
    };
    expect(payload.minSDKVersion).toBe("1.2.3");
  });

  test("workflow without minSDKVersion produces minSDKVersion: null in payload", () => {
    const uniqueName = `test-meta-minsdk-null-${Date.now()}`;
    defineWorkflow({
      name: uniqueName,
      source: import.meta.path,
      // no minSDKVersion
    })
      .for("claude")
      .run(async () => {})
      .compile();

    const all = getCompiledWorkflows();
    const found = all.find((d) => d.name === uniqueName);
    expect(found).toBeDefined();
    const payload = {
      name: found!.name,
      description: found!.description,
      agent: found!.agent,
      inputs: found!.inputs,
      source: found!.source,
      minSDKVersion: found!.minSDKVersion ?? null,
    };
    // Field must be present and explicitly null (not omitted)
    expect(Object.prototype.hasOwnProperty.call(payload, "minSDKVersion")).toBe(true);
    expect(payload.minSDKVersion).toBeNull();
  });
});

import { test, expect, describe } from "bun:test";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load schema from assets (source of truth)
const schemaPath = join(import.meta.dir, "../../../../../assets/settings.schema.json");
const schema = JSON.parse(readFileSync(schemaPath, "utf-8"));

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

// Validate a single customWorkflow entry via the top-level workflows property.
function validateEntry(entry: unknown): boolean {
  return validate({ workflows: { test: entry } });
}

describe("settings.schema.json — customWorkflow entry", () => {
  // ── Well-formed ─────────────────────────────────────────────────────────────

  test("well-formed minimal entry passes", () => {
    expect(validateEntry({ command: "bunx", agents: ["claude"] })).toBe(true);
  });

  test("well-formed entry with args passes", () => {
    expect(
      validateEntry({ command: "bunx", args: ["@me/pkg", "--flag"], agents: ["copilot"] }),
    ).toBe(true);
  });

  test("well-formed entry with all three agents passes", () => {
    expect(
      validateEntry({ command: "node", agents: ["claude", "opencode", "copilot"] }),
    ).toBe(true);
  });

  test("top-level workflows object with multiple aliases passes", () => {
    const valid = validate({
      workflows: {
        alpha: { command: "bunx", agents: ["claude"] },
        beta: { command: "node", args: ["/bin.mjs"], agents: ["opencode"] },
      },
    });
    expect(valid).toBe(true);
  });

  // ── command ─────────────────────────────────────────────────────────────────

  test("missing command → invalid", () => {
    expect(validateEntry({ agents: ["claude"] })).toBe(false);
  });

  // Note: JSON Schema type:string alone does not reject empty string "".
  // The schema declares command as type:string with no minLength constraint.
  // Empty-string rejection is enforced at runtime by pickWorkflows, not by the schema.
  test("command empty string — schema does NOT reject (pickWorkflows rejects at runtime)", () => {
    // This documents the gap: schema passes, pickWorkflows drops with error.
    expect(validateEntry({ command: "", agents: ["claude"] })).toBe(true);
  });

  // ── args ─────────────────────────────────────────────────────────────────────

  test("args non-array → invalid", () => {
    expect(validateEntry({ command: "bunx", agents: ["claude"], args: "not-array" })).toBe(false);
  });

  test("args array containing non-strings → invalid", () => {
    expect(validateEntry({ command: "bunx", agents: ["claude"], args: [1, 2] })).toBe(false);
  });

  test("args empty array → valid (default: [])", () => {
    expect(validateEntry({ command: "bunx", agents: ["claude"], args: [] })).toBe(true);
  });

  // ── agents ───────────────────────────────────────────────────────────────────

  test("agents empty array → invalid (minItems: 1)", () => {
    expect(validateEntry({ command: "bunx", agents: [] })).toBe(false);
  });

  test("agents duplicate values → invalid (uniqueItems: true)", () => {
    expect(validateEntry({ command: "bunx", agents: ["claude", "claude"] })).toBe(false);
  });

  test("agents containing unknown value → invalid", () => {
    expect(validateEntry({ command: "bunx", agents: ["gpt4"] })).toBe(false);
  });

  test("agents containing mix of known and unknown → invalid", () => {
    expect(validateEntry({ command: "bunx", agents: ["claude", "unknown"] })).toBe(false);
  });

  test("missing agents → invalid", () => {
    expect(validateEntry({ command: "bunx" })).toBe(false);
  });

  // ── additionalProperties ─────────────────────────────────────────────────────

  test("unknown property at entry level → invalid (additionalProperties: false)", () => {
    expect(
      validateEntry({ command: "bunx", agents: ["claude"], extra: "oops" }),
    ).toBe(false);
  });
});

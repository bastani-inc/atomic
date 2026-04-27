import { test, expect, describe } from "bun:test";
import { defineWorkflow } from "../../../src/sdk/define-workflow.ts";
import {
  getName,
  getDescription,
  getAgent,
  getInputSchema,
  getSource,
  getMinSDKVersion,
} from "../../../src/sdk/primitives/metadata.ts";

const sample = defineWorkflow({
  name: "hello",
  source: import.meta.path,
  description: "say hi",
  inputs: [{ name: "greeting", type: "string", required: true }],
  minSDKVersion: "0.6.0",
})
  .for("claude")
  .run(async () => {})
  .compile();

describe("primitives/metadata", () => {
  test("getName returns the declared name", () => {
    expect(getName(sample)).toBe("hello");
  });

  test("getDescription returns the declared description", () => {
    expect(getDescription(sample)).toBe("say hi");
  });

  test("getAgent returns the agent narrowed via .for()", () => {
    expect(getAgent(sample)).toBe("claude");
  });

  test("getInputSchema returns the declared inputs", () => {
    const schema = getInputSchema(sample);
    expect(schema).toHaveLength(1);
    expect(schema[0]?.name).toBe("greeting");
  });

  test("getSource returns the import.meta.path captured at definition", () => {
    expect(getSource(sample)).toBe(import.meta.path);
  });

  test("getMinSDKVersion returns the declared version", () => {
    expect(getMinSDKVersion(sample)).toBe("0.6.0");
  });

  test("getMinSDKVersion is null when not declared", () => {
    const wf = defineWorkflow({ name: "x", source: import.meta.path })
      .for("claude")
      .run(async () => {})
      .compile();
    expect(getMinSDKVersion(wf)).toBeNull();
  });
});

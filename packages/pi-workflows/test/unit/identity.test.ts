import { test, expect, describe } from "bun:test";
import { normalizeWorkflowName, workflowNamesEqual } from "../../src/workflows/identity.js";

describe("normalizeWorkflowName", () => {
  test("lowercases", () => {
    expect(normalizeWorkflowName("MyWorkflow")).toBe("myworkflow");
  });

  test("trims surrounding whitespace", () => {
    expect(normalizeWorkflowName("  hello  ")).toBe("hello");
  });

  test("replaces spaces with hyphens", () => {
    expect(normalizeWorkflowName("deep research codebase")).toBe("deep-research-codebase");
  });

  test("replaces underscores with hyphens", () => {
    expect(normalizeWorkflowName("my_workflow")).toBe("my-workflow");
  });

  test("collapses multiple separators", () => {
    expect(normalizeWorkflowName("a   b__c")).toBe("a-b-c");
  });

  test("strips non-alphanumeric non-hyphen characters", () => {
    expect(normalizeWorkflowName("hello!@#world")).toBe("helloworld");
  });

  test("strips leading and trailing hyphens", () => {
    expect(normalizeWorkflowName("-hello-")).toBe("hello");
  });

  test("full example from spec", () => {
    expect(normalizeWorkflowName("Deep Research Codebase")).toBe("deep-research-codebase");
  });

  test("throws on empty string", () => {
    expect(() => normalizeWorkflowName("")).toThrow("non-empty string");
  });

  test("throws on non-string", () => {
    // @ts-expect-error intentional wrong type
    expect(() => normalizeWorkflowName(null)).toThrow("non-empty string");
  });
});

describe("workflowNamesEqual", () => {
  test("equal for same string", () => {
    expect(workflowNamesEqual("my-workflow", "my-workflow")).toBe(true);
  });

  test("equal across casing and separators", () => {
    expect(workflowNamesEqual("My Workflow", "my-workflow")).toBe(true);
    expect(workflowNamesEqual("my_workflow", "my-workflow")).toBe(true);
  });

  test("not equal for different names", () => {
    expect(workflowNamesEqual("foo", "bar")).toBe(false);
  });
});

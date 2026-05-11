import { test, expect, describe } from "bun:test";
import { createRegistry } from "../../src/workflows/registry.js";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";

function makeWorkflow(name: string, description = "") {
  return defineWorkflow(name)
    .description(description)
    .run(async () => ({}))
    .compile();
}

describe("WorkflowRegistry extended operations", () => {
  test("has() returns false for empty registry", () => {
    expect(createRegistry().has("anything")).toBe(false);
  });

  test("has() returns true after register", () => {
    const r = createRegistry().register(makeWorkflow("w1"));
    expect(r.has("w1")).toBe(true);
  });

  test("has() normalizes name before lookup", () => {
    const r = createRegistry().register(makeWorkflow("my workflow"));
    expect(r.has("my-workflow")).toBe(true);
    expect(r.has("My Workflow")).toBe(true);
    expect(r.has("my_workflow")).toBe(true);
  });

  test("remove() returns new registry without the entry", () => {
    const r1 = createRegistry([makeWorkflow("w1"), makeWorkflow("w2")]);
    const r2 = r1.remove("w1");

    // r1 unchanged
    expect(r1.has("w1")).toBe(true);
    // r2 without w1
    expect(r2.has("w1")).toBe(false);
    expect(r2.has("w2")).toBe(true);
  });

  test("remove() is no-op when name not found", () => {
    const r = createRegistry([makeWorkflow("w1")]);
    const r2 = r.remove("nonexistent");
    expect(r2.names()).toEqual(r.names());
  });

  test("remove() normalizes name", () => {
    const r = createRegistry([makeWorkflow("my workflow")]);
    const r2 = r.remove("my-workflow");
    expect(r2.has("my-workflow")).toBe(false);
  });

  test("upsert() is an alias for register()", () => {
    const w = makeWorkflow("w1");
    const r = createRegistry().upsert(w);
    expect(r.has("w1")).toBe(true);
    expect(r.get("w1")?.name).toBe("w1");
  });

  test("upsert() replaces existing entry", () => {
    const w1a = makeWorkflow("w1", "original");
    const w1b = makeWorkflow("w1", "updated");
    const r = createRegistry().upsert(w1a).upsert(w1b);
    expect(r.get("w1")?.description).toBe("updated");
    expect(r.names().length).toBe(1);
  });

  test("get() normalizes lookup name", () => {
    const r = createRegistry([makeWorkflow("deep research codebase")]);
    const def = r.get("deep-research-codebase");
    expect(def).not.toBeUndefined();
    expect(def?.name).toBe("deep research codebase");
  });

  test("registry keys are normalized names", () => {
    const r = createRegistry([makeWorkflow("My Workflow")]);
    // names() returns normalized form
    expect(r.names()).toEqual(["my-workflow"]);
  });
});

describe("WorkflowRegistry merge collision behavior", () => {
  test("merge: other's entry wins on collision", () => {
    const wA = makeWorkflow("shared", "from-A");
    const wB = makeWorkflow("shared", "from-B");
    const rA = createRegistry([wA]);
    const rB = createRegistry([wB]);
    const merged = rA.merge(rB);
    expect(merged.get("shared")?.description).toBe("from-B");
    expect(merged.names().length).toBe(1);
  });

  test("merge: non-colliding entries all present", () => {
    const rA = createRegistry([makeWorkflow("alpha"), makeWorkflow("beta")]);
    const rB = createRegistry([makeWorkflow("gamma")]);
    const merged = rA.merge(rB);
    expect(merged.names().sort()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("merge: original registries unchanged after collision", () => {
    const wA = makeWorkflow("shared", "from-A");
    const wB = makeWorkflow("shared", "from-B");
    const rA = createRegistry([wA]);
    const rB = createRegistry([wB]);
    rA.merge(rB);
    expect(rA.get("shared")?.description).toBe("from-A");
    expect(rB.get("shared")?.description).toBe("from-B");
  });
});

describe("WorkflowRegistry insertion order", () => {
  test("names() preserves insertion order", () => {
    const r = createRegistry()
      .register(makeWorkflow("alpha"))
      .register(makeWorkflow("beta"))
      .register(makeWorkflow("gamma"));
    expect(r.names()).toEqual(["alpha", "beta", "gamma"]);
  });

  test("all() preserves insertion order", () => {
    const r = createRegistry()
      .register(makeWorkflow("first"))
      .register(makeWorkflow("second"))
      .register(makeWorkflow("third"));
    expect(r.all().map((d) => d.name)).toEqual(["first", "second", "third"]);
  });

  test("re-registering same name preserves original insertion position", () => {
    // Map.set on existing key preserves position in JS Map iteration order
    const r = createRegistry()
      .register(makeWorkflow("alpha"))
      .register(makeWorkflow("beta"))
      .register(makeWorkflow("alpha", "updated"));
    // "alpha" retains its first-insertion position
    expect(r.names()).toEqual(["alpha", "beta"]);
    // but with updated description
    expect(r.get("alpha")?.description).toBe("updated");
  });

  test("initial array populates in array order", () => {
    const r = createRegistry([makeWorkflow("x"), makeWorkflow("y"), makeWorkflow("z")]);
    expect(r.names()).toEqual(["x", "y", "z"]);
  });
});

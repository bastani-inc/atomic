import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";

function makeWorkflow(name: string, description = "") {
  return workflow({
    name: name,
    description: description,
    inputs: {},
    outputs: {},
    run: async () => ({}),
  });
}

describe("WorkflowRegistry extended operations", () => {
  test("has() returns false for empty registry", () => {
    assert.equal(createRegistry().has("anything"), false);
  });

  test("has() returns true after register", () => {
    const r = createRegistry().register(makeWorkflow("w1"));
    assert.equal(r.has("w1"), true);
  });

  test("has() normalizes name before lookup", () => {
    const r = createRegistry().register(makeWorkflow("my workflow"));
    assert.equal(r.has("my-workflow"), true);
    assert.equal(r.has("My Workflow"), true);
    assert.equal(r.has("my_workflow"), true);
  });

  test("remove() returns new registry without the entry", () => {
    const r1 = createRegistry([makeWorkflow("w1"), makeWorkflow("w2")]);
    const r2 = r1.remove("w1");

    // r1 unchanged
    assert.equal(r1.has("w1"), true);
    // r2 without w1
    assert.equal(r2.has("w1"), false);
    assert.equal(r2.has("w2"), true);
  });

  test("remove() is no-op when name not found", () => {
    const r = createRegistry([makeWorkflow("w1")]);
    const r2 = r.remove("nonexistent");
    assert.deepEqual(r2.names(), r.names());
  });

  test("remove() normalizes name", () => {
    const r = createRegistry([makeWorkflow("my workflow")]);
    const r2 = r.remove("my-workflow");
    assert.equal(r2.has("my-workflow"), false);
  });

  test("register() replaces existing entry", () => {
    const w1a = makeWorkflow("w1", "original");
    const w1b = makeWorkflow("w1", "updated");
    const r = createRegistry().register(w1a).register(w1b);
    assert.equal(r.get("w1")?.description, "updated");
    assert.equal(r.names().length, 1);
  });

  test("get() normalizes lookup name", () => {
    const r = createRegistry([makeWorkflow("deep research codebase")]);
    const def = r.get("deep-research-codebase");
    assert.notEqual(def, undefined);
    assert.equal(def?.name, "deep research codebase");
  });

  test("registry keys are normalized names", () => {
    const r = createRegistry([makeWorkflow("My Workflow")]);
    // names() returns normalized form
    assert.deepEqual(r.names(), ["my-workflow"]);
  });
});

describe("WorkflowRegistry merge collision behavior", () => {
  test("merge: other's entry wins on collision", () => {
    const wA = makeWorkflow("shared", "from-A");
    const wB = makeWorkflow("shared", "from-B");
    const rA = createRegistry([wA]);
    const rB = createRegistry([wB]);
    const merged = rA.merge(rB);
    assert.equal(merged.get("shared")?.description, "from-B");
    assert.equal(merged.names().length, 1);
  });

  test("merge: non-colliding entries all present", () => {
    const rA = createRegistry([makeWorkflow("alpha"), makeWorkflow("beta")]);
    const rB = createRegistry([makeWorkflow("gamma")]);
    const merged = rA.merge(rB);
    assert.deepEqual(merged.names().sort(), ["alpha", "beta", "gamma"]);
  });

  test("merge: original registries unchanged after collision", () => {
    const wA = makeWorkflow("shared", "from-A");
    const wB = makeWorkflow("shared", "from-B");
    const rA = createRegistry([wA]);
    const rB = createRegistry([wB]);
    rA.merge(rB);
    assert.equal(rA.get("shared")?.description, "from-A");
    assert.equal(rB.get("shared")?.description, "from-B");
  });
});

describe("WorkflowRegistry insertion order", () => {
  test("names() preserves insertion order", () => {
    const r = createRegistry()
      .register(makeWorkflow("alpha"))
      .register(makeWorkflow("beta"))
      .register(makeWorkflow("gamma"));
    assert.deepEqual(r.names(), ["alpha", "beta", "gamma"]);
  });

  test("all() preserves insertion order", () => {
    const r = createRegistry()
      .register(makeWorkflow("first"))
      .register(makeWorkflow("second"))
      .register(makeWorkflow("third"));
    assert.deepEqual(r.all().map((d) => d.name), ["first", "second", "third"]);
  });

  test("re-registering same name preserves original insertion position", () => {
    // Map.set on existing key preserves position in JS Map iteration order
    const r = createRegistry()
      .register(makeWorkflow("alpha"))
      .register(makeWorkflow("beta"))
      .register(makeWorkflow("alpha", "updated"));
    // "alpha" retains its first-insertion position
    assert.deepEqual(r.names(), ["alpha", "beta"]);
    // but with updated description
    assert.equal(r.get("alpha")?.description, "updated");
  });

  test("initial array populates in array order", () => {
    const r = createRegistry([makeWorkflow("x"), makeWorkflow("y"), makeWorkflow("z")]);
    assert.deepEqual(r.names(), ["x", "y", "z"]);
  });
});

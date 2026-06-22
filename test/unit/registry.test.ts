import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { createRegistry } from "../../packages/workflows/src/workflows/registry.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";

function makeWorkflow(name: string) {
  return workflow({
    name: name,
    description: "",
    inputs: {},
    outputs: {},
    run: async () => ({}),
  });
}

describe("createRegistry", () => {
  test("starts empty", () => {
    const r = createRegistry();
    assert.deepEqual(r.names(), []);
    assert.deepEqual(r.all(), []);
  });

  test("register adds a workflow", () => {
    const r = createRegistry().register(makeWorkflow("w1"));
    assert.ok(r.names().includes("w1"));
    assert.equal(r.get("w1")?.name, "w1");
  });

  test("register returns new registry (immutable-style)", () => {
    const r1 = createRegistry();
    const r2 = r1.register(makeWorkflow("w1"));
    assert.deepEqual(r1.names(), []);
    assert.ok(r2.names().includes("w1"));
  });

  test("get returns undefined for unknown name", () => {
    assert.equal(createRegistry().get("nope"), undefined);
  });

  test("register overwrites same name", () => {
    const w1a = makeWorkflow("w1");
    const w1b = workflow({
      name: "w1",
      description: "updated",
      inputs: {},
      outputs: {},
      run: async () => ({}),
    });
    const r = createRegistry().register(w1a).register(w1b);
    assert.equal(r.get("w1")?.description, "updated");
    assert.equal(r.names().length, 1);
  });

  test("merge combines two registries", () => {
    const rA = createRegistry([makeWorkflow("a")]);
    const rB = createRegistry([makeWorkflow("b")]);
    const merged = rA.merge(rB);
    assert.deepEqual(merged.names().sort(), ["a", "b"]);
  });

  test("all() returns all definitions", () => {
    const r = createRegistry([makeWorkflow("x"), makeWorkflow("y")]);
    assert.deepEqual(r.all().map((d) => d.name).sort(), ["x", "y"]);
  });

  test("initial array populates registry", () => {
    const r = createRegistry([makeWorkflow("init")]);
    assert.equal(r.get("init")?.name, "init");
  });
});

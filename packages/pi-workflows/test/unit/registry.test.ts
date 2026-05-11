import { test, expect, describe } from "bun:test";
import { createRegistry } from "../../src/workflows/registry.js";
import { defineWorkflow } from "../../src/workflows/define-workflow.js";

function makeWorkflow(name: string) {
  return defineWorkflow(name)
    .run(async () => ({}))
    .compile();
}

describe("createRegistry", () => {
  test("starts empty", () => {
    const r = createRegistry();
    expect(r.names()).toEqual([]);
    expect(r.all()).toEqual([]);
  });

  test("register adds a workflow", () => {
    const r = createRegistry().register(makeWorkflow("w1"));
    expect(r.names()).toContain("w1");
    expect(r.get("w1")?.name).toBe("w1");
  });

  test("register returns new registry (immutable-style)", () => {
    const r1 = createRegistry();
    const r2 = r1.register(makeWorkflow("w1"));
    expect(r1.names()).toEqual([]);
    expect(r2.names()).toContain("w1");
  });

  test("get returns undefined for unknown name", () => {
    expect(createRegistry().get("nope")).toBeUndefined();
  });

  test("register overwrites same name", () => {
    const w1a = makeWorkflow("w1");
    const w1b = defineWorkflow("w1").description("updated").run(async () => ({})).compile();
    const r = createRegistry().register(w1a).register(w1b);
    expect(r.get("w1")?.description).toBe("updated");
    expect(r.names().length).toBe(1);
  });

  test("merge combines two registries", () => {
    const rA = createRegistry([makeWorkflow("a")]);
    const rB = createRegistry([makeWorkflow("b")]);
    const merged = rA.merge(rB);
    expect(merged.names().sort()).toEqual(["a", "b"]);
  });

  test("all() returns all definitions", () => {
    const r = createRegistry([makeWorkflow("x"), makeWorkflow("y")]);
    expect(r.all().map((d) => d.name).sort()).toEqual(["x", "y"]);
  });

  test("initial array populates registry", () => {
    const r = createRegistry([makeWorkflow("init")]);
    expect(r.get("init")?.name).toBe("init");
  });
});

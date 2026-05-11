import { test, expect } from "bun:test";
import factory from "../../src/extension/index.js";

test("extension factory is a function", () => {
  expect(typeof factory).toBe("function");
});

test("extension factory runs without error (no-op)", () => {
  // Phase A: factory accepts any API object and does nothing.
  expect(() => factory({})).not.toThrow();
});

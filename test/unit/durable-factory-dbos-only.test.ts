import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { InMemoryDurableBackend } from "../../packages/workflows/src/durable/backend.js";
import { DbosNotReadyError } from "../../packages/workflows/src/durable/dbos-lifecycle.js";
import { getDurableBackend, setDurableBackend } from "../../packages/workflows/src/durable/factory.js";

afterEach(() => setDurableBackend(undefined));

describe("DBOS-only durable factory", () => {
  test("throws before DBOS readiness when no test backend is injected", () => {
    setDurableBackend(undefined);
    assert.throws(() => getDurableBackend(), DbosNotReadyError);
  });

  test("accepts only explicit internal backend injection before readiness", () => {
    const backend = new InMemoryDurableBackend();
    setDurableBackend(backend);
    assert.equal(getDurableBackend(), backend);
  });
});

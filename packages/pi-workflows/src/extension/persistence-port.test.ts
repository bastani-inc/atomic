/**
 * Tests for makePersistencePort — config-gated WorkflowPersistencePort builder.
 *
 * cross-ref: packages/pi-workflows/src/extension/index.ts makePersistencePort
 *            packages/pi-workflows/src/shared/types.ts WorkflowPersistencePort
 */

import { test, expect, describe } from "bun:test";
import { makePersistencePort } from "./index.js";
import type { ExtensionAPI } from "./index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function piWithAppendEntry(
  appendEntry: ExtensionAPI["appendEntry"],
  extra?: Partial<ExtensionAPI>,
): ExtensionAPI {
  return { appendEntry, ...extra };
}

// ---------------------------------------------------------------------------
// makePersistencePort — gate: persistRuns false
// ---------------------------------------------------------------------------

describe("makePersistencePort — persistRuns false", () => {
  test("returns undefined regardless of appendEntry presence", () => {
    const pi = piWithAppendEntry(() => "id-1");
    expect(makePersistencePort(pi, false)).toBeUndefined();
  });

  test("returns undefined when appendEntry absent and persistRuns false", () => {
    expect(makePersistencePort({}, false)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makePersistencePort — gate: appendEntry missing
// ---------------------------------------------------------------------------

describe("makePersistencePort — appendEntry absent", () => {
  test("returns undefined when pi has no appendEntry", () => {
    expect(makePersistencePort({}, true)).toBeUndefined();
  });

  test("returns undefined when appendEntry is not a function", () => {
    const pi = { appendEntry: "not-a-function" } as unknown as ExtensionAPI;
    expect(makePersistencePort(pi, true)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// makePersistencePort — happy path: appendEntry present, persistRuns true
// ---------------------------------------------------------------------------

describe("makePersistencePort — happy path", () => {
  test("returns a port when persistRuns true and appendEntry present", () => {
    const pi = piWithAppendEntry(() => "eid");
    const port = makePersistencePort(pi, true);
    expect(port).not.toBeUndefined();
  });

  test("port.appendEntry delegates to pi.appendEntry", () => {
    const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const pi = piWithAppendEntry((type, payload) => {
      calls.push({ type, payload });
      return "returned-id";
    });
    const port = makePersistencePort(pi, true)!;
    const id = port.appendEntry("workflow.run.start", { runId: "r1" });
    expect(id).toBe("returned-id");
    expect(calls).toEqual([{ type: "workflow.run.start", payload: { runId: "r1" } }]);
  });

  test("port has no setLabel when pi.setLabel absent", () => {
    const pi = piWithAppendEntry(() => "eid");
    const port = makePersistencePort(pi, true)!;
    expect(port.setLabel).toBeUndefined();
  });

  test("port.setLabel delegates to pi.setLabel when present", () => {
    const calls: Array<{ entryId: string; label: string }> = [];
    const pi = piWithAppendEntry(() => "eid", {
      setLabel: (entryId, label) => {
        calls.push({ entryId, label });
      },
    });
    const port = makePersistencePort(pi, true)!;
    expect(typeof port.setLabel).toBe("function");
    port.setLabel!("eid-1", "my-label");
    expect(calls).toEqual([{ entryId: "eid-1", label: "my-label" }]);
  });

  test("port has no appendCustomMessageEntry when pi.appendCustomMessageEntry absent", () => {
    const pi = piWithAppendEntry(() => "eid");
    const port = makePersistencePort(pi, true)!;
    expect(port.appendCustomMessageEntry).toBeUndefined();
  });

  test("port.appendCustomMessageEntry delegates to pi.appendCustomMessageEntry when present", () => {
    const calls: Array<{ content: string; meta?: Record<string, unknown> }> = [];
    const pi = piWithAppendEntry(() => "eid", {
      appendCustomMessageEntry: (content, meta) => {
        calls.push({ content, meta });
        return "msg-id";
      },
    });
    const port = makePersistencePort(pi, true)!;
    expect(typeof port.appendCustomMessageEntry).toBe("function");
    const id = port.appendCustomMessageEntry!("hello", { key: "val" });
    expect(id).toBe("msg-id");
    expect(calls).toEqual([{ content: "hello", meta: { key: "val" } }]);
  });

  test("port.appendCustomMessageEntry works without meta arg", () => {
    const calls: string[] = [];
    const pi = piWithAppendEntry(() => "eid", {
      appendCustomMessageEntry: (content) => {
        calls.push(content);
        return "msg-id-2";
      },
    });
    const port = makePersistencePort(pi, true)!;
    port.appendCustomMessageEntry!("bare");
    expect(calls).toEqual(["bare"]);
  });
});

// ---------------------------------------------------------------------------
// makePersistencePort — all three slots bound simultaneously
// ---------------------------------------------------------------------------

describe("makePersistencePort — all slots", () => {
  test("all three bound when all three present", () => {
    const pi: ExtensionAPI = {
      appendEntry: () => "eid",
      setLabel: () => undefined,
      appendCustomMessageEntry: () => "mid",
    };
    const port = makePersistencePort(pi, true)!;
    expect(typeof port.appendEntry).toBe("function");
    expect(typeof port.setLabel).toBe("function");
    expect(typeof port.appendCustomMessageEntry).toBe("function");
  });
});

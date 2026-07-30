/**
 * Tests for makePersistencePort — config-gated WorkflowPersistencePort builder.
 *
 * cross-ref: src/extension/index.ts makePersistencePort
 *            src/shared/types.ts WorkflowPersistencePort
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type { ExtensionAPI } from "../../packages/workflows/src/extension/index.js";
import { makePersistencePort } from "../../packages/workflows/src/extension/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function piWithAppendEntry(appendEntry: ExtensionAPI["appendEntry"], extra?: Partial<ExtensionAPI>): ExtensionAPI {
	return { appendEntry, ...extra };
}

// ---------------------------------------------------------------------------
// makePersistencePort — gate: persistRuns false
// ---------------------------------------------------------------------------

describe("makePersistencePort — persistRuns false", () => {
	test("returns undefined regardless of appendEntry presence", () => {
		const pi = piWithAppendEntry(() => "id-1");
		assert.equal(makePersistencePort(pi, false), undefined);
	});

	test("returns undefined when appendEntry absent and persistRuns false", () => {
		assert.equal(makePersistencePort({}, false), undefined);
	});
});

// ---------------------------------------------------------------------------
// makePersistencePort — gate: appendEntry missing
// ---------------------------------------------------------------------------

describe("makePersistencePort — appendEntry absent", () => {
	test("returns undefined when pi has no appendEntry", () => {
		assert.equal(makePersistencePort({}, true), undefined);
	});

	test("returns undefined when appendEntry is not a function", () => {
		const pi = { appendEntry: "not-a-function" } as unknown as ExtensionAPI;
		assert.equal(makePersistencePort(pi, true), undefined);
	});
});

// ---------------------------------------------------------------------------
// makePersistencePort — happy path: appendEntry present, persistRuns true
// ---------------------------------------------------------------------------

describe("makePersistencePort — happy path", () => {
	test("returns a port when persistRuns true and appendEntry present", () => {
		const pi = piWithAppendEntry(() => "eid");
		const port = makePersistencePort(pi, true);
		assert.notEqual(port, undefined);
	});

	test("port.appendEntry delegates to pi.appendEntry", () => {
		const calls: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const pi = piWithAppendEntry((type, payload) => {
			calls.push({ type, payload });
			return "returned-id";
		});
		const port = makePersistencePort(pi, true)!;
		const id = port.appendEntry("workflow.run.start", { runId: "r1" });
		assert.equal(id, "returned-id");
		assert.deepEqual(calls, [{ type: "workflow.run.start", payload: { runId: "r1" } }]);
	});

	test("port has no setLabel when pi.setLabel absent", () => {
		const pi = piWithAppendEntry(() => "eid");
		const port = makePersistencePort(pi, true)!;
		assert.equal(port.setLabel, undefined);
	});

	test("port.setLabel delegates to pi.setLabel when present", () => {
		const calls: Array<{ entryId: string; label: string }> = [];
		const pi = piWithAppendEntry(() => "eid", {
			setLabel: (entryId, label) => {
				calls.push({ entryId, label });
			},
		});
		const port = makePersistencePort(pi, true)!;
		assert.equal(typeof port.setLabel, "function");
		port.setLabel!("eid-1", "my-label");
		assert.deepEqual(calls, [{ entryId: "eid-1", label: "my-label" }]);
	});

	test("port has no appendCustomMessageEntry when pi.appendCustomMessageEntry absent", () => {
		const pi = piWithAppendEntry(() => "eid");
		const port = makePersistencePort(pi, true)!;
		assert.equal(port.appendCustomMessageEntry, undefined);
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
		assert.equal(typeof port.appendCustomMessageEntry, "function");
		const id = port.appendCustomMessageEntry!("hello", { key: "val" });
		assert.equal(id, "msg-id");
		assert.deepEqual(calls, [{ content: "hello", meta: { key: "val" } }]);
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
		assert.deepEqual(calls, ["bare"]);
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
		assert.equal(typeof port.appendEntry, "function");
		assert.equal(typeof port.setLabel, "function");
		assert.equal(typeof port.appendCustomMessageEntry, "function");
	});
});

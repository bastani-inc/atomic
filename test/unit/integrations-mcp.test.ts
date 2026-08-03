/**
 * Unit tests — integrations/mcp.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { clearMcpScope, isMcpScopeSupported, setMcpScope } from "../../packages/workflows/src/extension/mcp.js";

describe("setMcpScope", () => {
	test("emits mcp.scope.set with allow and deny", () => {
		const emitted: { event: string; payload: Record<string, unknown> }[] = [];
		const pi = {
			events: {
				emit: (event: string, payload: Record<string, unknown>) => {
					emitted.push({ event, payload });
				},
			},
		};
		setMcpScope(pi, { stageId: "s1", allow: ["github", "fetch"], deny: ["filesystem"] });
		assert.equal(emitted.length, 1);
		assert.equal(emitted[0].event, "mcp.scope.set");
		const p = emitted[0].payload as { stageId: string; allow: string[]; deny: string[] };
		assert.equal(p.stageId, "s1");
		assert.deepEqual(p.allow, ["github", "fetch"]);
		assert.deepEqual(p.deny, ["filesystem"]);
	});

	test("emits null allow/deny when not specified", () => {
		const emitted: { event: string; payload: Record<string, unknown> }[] = [];
		const pi = {
			events: {
				emit: (event: string, payload: Record<string, unknown>) => {
					emitted.push({ event, payload });
				},
			},
		};
		setMcpScope(pi, { stageId: "s2" });
		const p = emitted[0].payload as { allow: null; deny: null };
		assert.equal(p.allow, null);
		assert.equal(p.deny, null);
	});

	test("no-op when pi.events absent", () => {
		assert.doesNotThrow(() => setMcpScope({}, { stageId: "s1" }));
	});
});

describe("clearMcpScope", () => {
	test("emits mcp.scope.set with null allow and deny", () => {
		const emitted: { event: string; payload: Record<string, unknown> }[] = [];
		const pi = {
			events: {
				emit: (event: string, payload: Record<string, unknown>) => {
					emitted.push({ event, payload });
				},
			},
		};
		clearMcpScope(pi, "stage-x");
		assert.equal(emitted[0].event, "mcp.scope.set");
		const p = emitted[0].payload as { stageId: string; allow: null; deny: null };
		assert.equal(p.stageId, "stage-x");
		assert.equal(p.allow, null);
		assert.equal(p.deny, null);
	});

	test("no-op when pi.events absent", () => {
		assert.doesNotThrow(() => clearMcpScope({}, "s1"));
	});
});

describe("isMcpScopeSupported", () => {
	test("returns true when events present", () => {
		assert.equal(isMcpScopeSupported({ events: { emit: () => {} } }), true);
	});

	test("returns false when events absent", () => {
		assert.equal(isMcpScopeSupported({}), false);
	});
});

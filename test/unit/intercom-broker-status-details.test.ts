import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { isBrokerStatusReport } from "../../packages/intercom/broker/broker-status.js";
import type { JsonWireValue } from "../../packages/intercom/broker/framing.js";

function report(extra: { [key: string]: JsonWireValue } = {}): JsonWireValue {
	return { pid: 1, sessions: 2, multiNode: { status: "off" }, ...extra };
}

describe("broker status report counts (#4326)", () => {
	test("a report without counts is accepted (#4326)", () => {
		assert.equal(isBrokerStatusReport(report()), true);
	});

	test("valid reservation and held-send counts are accepted (#4326)", () => {
		assert.equal(isBrokerStatusReport(report({ reservations: 0, heldSends: 3 })), true);
		assert.equal(isBrokerStatusReport(report({ reservations: 7 })), true);
		assert.equal(isBrokerStatusReport(report({ heldSends: 7 })), true);
	});

	test("invalid reservation counts are rejected (#4326)", () => {
		for (const bad of ["1", -1, 1.5, null, true, Number.MAX_SAFE_INTEGER + 2, [1]] as JsonWireValue[]) {
			assert.equal(isBrokerStatusReport(report({ reservations: bad })), false, JSON.stringify(bad));
		}
	});

	test("invalid held-send counts are rejected even when reservations are valid (#4326)", () => {
		for (const bad of ["1", -1, 1.5, null, true, Number.MAX_SAFE_INTEGER + 2] as JsonWireValue[]) {
			assert.equal(isBrokerStatusReport(report({ reservations: 1, heldSends: bad })), false, JSON.stringify(bad));
		}
	});

	test("a valid held-send count does not excuse an invalid reservation count (#4326)", () => {
		assert.equal(isBrokerStatusReport(report({ reservations: -1, heldSends: 1 })), false);
	});
});

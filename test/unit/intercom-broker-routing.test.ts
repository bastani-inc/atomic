import assert from "node:assert/strict";
import { afterEach, expect, test, vi } from "vitest";

const control = vi.hoisted(() => ({ reply: undefined as unknown }));

vi.mock("../../packages/intercom/broker/control-request.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/intercom/broker/control-request.js")>()),
	controlRequest: async () => control.reply,
}));

const { queryBrokerRouting } = await import("../../packages/intercom/broker/broker-routing.js");
const { BROKER_CONTROL_TIMEOUT_MS } = await import("../../packages/intercom/broker/control-request.js");
const { isIntercomRoutingTimeoutError } = await import("@bastani/atomic");

afterEach(() => {
	vi.restoreAllMocks();
});

test("a timed-out status request reports at least its own timeout as elapsed, even when the clock steps back (#4320)", async () => {
	control.reply = { connected: true, timedOut: true };
	const clock = vi.spyOn(Date, "now");
	clock.mockReturnValueOnce(1_000_000).mockReturnValue(500_000);
	const error = await queryBrokerRouting("/unused").catch((caught: unknown) => caught);
	assert.ok(isIntercomRoutingTimeoutError(error));
	assert.equal(error.timeoutMs, BROKER_CONTROL_TIMEOUT_MS);
	assert.equal(error.elapsedMs, BROKER_CONTROL_TIMEOUT_MS);
});

test("a status report is read as whether the broker routes across machines and whether it holds a storage selection (#4320)", async () => {
	const report = (multiNode: { status: string }, storage?: { digest: string; source: string }) => ({
		connected: true,
		reply: {
			type: "broker_status",
			requestId: "r",
			report: { pid: 1, sessions: 0, multiNode, ...(storage ? { storage } : {}) },
		},
	});
	const selection = { digest: "d", source: "env" };
	control.reply = report({ status: "on" }, selection);
	await expect(queryBrokerRouting("/unused")).resolves.toEqual({ acrossMachines: true, hasSharedStorage: true });
	control.reply = report({ status: "off" }, selection);
	await expect(queryBrokerRouting("/unused")).resolves.toEqual({ acrossMachines: false, hasSharedStorage: true });
	control.reply = report({ status: "off" });
	await expect(queryBrokerRouting("/unused")).resolves.toEqual({ acrossMachines: false, hasSharedStorage: false });
});

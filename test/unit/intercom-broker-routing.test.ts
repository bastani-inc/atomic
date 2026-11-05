import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";

const control = vi.hoisted(() => ({ reply: undefined as unknown, calls: [] as unknown[][] }));

vi.mock("../../packages/intercom/broker/control-request.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/intercom/broker/control-request.js")>()),
	controlRequest: async (...args: unknown[]) => {
		control.calls.push(args);
		return control.reply;
	},
}));

const { queryBrokerRouting } = await import("../../packages/intercom/broker/broker-routing.js");
const { BROKER_CONTROL_TIMEOUT_MS } = await import("../../packages/intercom/broker/control-request.js");
const { isIntercomRoutingTimeoutError, isIntercomRoutingUnavailableError } = await import("@bastani/atomic");
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomBrokerRetiringError, isIntercomBrokerRetiring } = await import(
	"../../packages/intercom/recoverable-disconnect.js"
);

afterEach(() => {
	vi.restoreAllMocks();
	control.calls.length = 0;
});

test("a timed-out status request reports at least its own timeout as elapsed, even when the clock steps back (#4320)", async () => {
	control.reply = { connected: true, timedOut: true };
	const clock = vi.spyOn(Date, "now");
	clock.mockReturnValueOnce(1_000_000).mockReturnValue(500_000);
	const error = await queryBrokerRouting("/unused").catch((caught: unknown) => caught);
	assert.ok(isIntercomRoutingTimeoutError(error));
	assert.equal(error.timeoutMs, BROKER_CONTROL_TIMEOUT_MS);
	assert.equal(error.elapsedMs, BROKER_CONTROL_TIMEOUT_MS);
	assert.equal(error.phase, "broker_status");
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
	assert.deepEqual(await queryBrokerRouting("/unused"), { acrossMachines: true, hasSharedStorage: true });
	control.reply = report({ status: "off" }, selection);
	assert.deepEqual(await queryBrokerRouting("/unused"), { acrossMachines: false, hasSharedStorage: true });
	control.reply = report({ status: "off" });
	assert.deepEqual(await queryBrokerRouting("/unused"), { acrossMachines: false, hasSharedStorage: false });
});

test("the routing question is a broker_status request on the agent directory's socket, answered by a broker_status reply (#4320)", async () => {
	control.reply = {
		connected: true,
		reply: { type: "broker_status", requestId: "r", report: { pid: 1, sessions: 0, multiNode: { status: "off" } } },
	};
	await queryBrokerRouting("/agent-directory");
	assert.deepEqual(control.calls, [
		[
			getBrokerSocketPath(process.platform, "/agent-directory"),
			"broker_status",
			"broker_status",
			BROKER_CONTROL_TIMEOUT_MS,
		],
	]);
});

test("a broker nothing is listening on is a lost broker that the caller can replace, not an unsupported one (#4320)", async () => {
	control.reply = { connected: false };
	const error = await queryBrokerRouting("/unused").catch((caught: unknown) => caught);
	assert.ok(error instanceof IntercomBrokerRetiringError);
	assert.equal(isIntercomBrokerRetiring(error), true);
	assert.equal(isIntercomRoutingUnavailableError(error), false);
});

test("a broker that closes the status request without answering is unsupported at the broker_status phase (#4320)", async () => {
	control.reply = { connected: true };
	const error = await queryBrokerRouting("/unused").catch((caught: unknown) => caught);
	assert.ok(isIntercomRoutingUnavailableError(error));
	assert.deepEqual([error.reason, error.phase, error.retryable], ["unsupported", "broker_status", true]);
});

test("a status reply without a readable report is malformed at the broker_status phase (#4320)", async () => {
	const replies: unknown[] = [
		{ type: "broker_status", requestId: "r" },
		{ type: "broker_status", requestId: "r", report: "not a report" },
		{ type: "broker_status", requestId: "r", report: { pid: "unknown" } },
		{ type: "broker_status", requestId: "r", report: { pid: 1, sessions: 0, multiNode: { status: "sideways" } } },
	];
	for (const reply of replies) {
		control.reply = { connected: true, reply };
		const error = await queryBrokerRouting("/unused").catch((caught: unknown) => caught);
		assert.ok(isIntercomRoutingUnavailableError(error), JSON.stringify(reply));
		assert.deepEqual([error.reason, error.phase], ["malformed", "broker_status"], JSON.stringify(reply));
	}
});

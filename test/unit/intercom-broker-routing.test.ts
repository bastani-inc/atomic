import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";

const control = vi.hoisted(() => ({
	reply: undefined as unknown,
	calls: [] as unknown[][],
	socketAnswering: true,
	onControl: undefined as (() => void) | undefined,
}));

vi.mock("../../packages/intercom/broker/control-request.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/intercom/broker/control-request.js")>()),
	controlRequest: async (...args: unknown[]) => {
		control.calls.push(args);
		control.onControl?.();
		return control.reply;
	},
}));

vi.mock("../../packages/intercom/broker/socket-liveness.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/intercom/broker/socket-liveness.js")>()),
	isSocketAnswering: async () => control.socketAnswering,
}));

const { queryBrokerRouting } = await import("../../packages/intercom/broker/broker-routing.js");
const { BROKER_CONTROL_TIMEOUT_MS } = await import("../../packages/intercom/broker/control-request.js");
const { BROKER_SPAWN_LOCK_MAX_AGE_MS } = await import("../../packages/intercom/broker/spawn.js");
const { isIntercomRoutingTimeoutError, isIntercomRoutingUnavailableError } = await import("@bastani/atomic");
const { getBrokerPidPath, getBrokerSocketPath, getBrokerSpawnLockPath, getIntercomDirPath } = await import(
	"../../packages/intercom/broker/paths.js"
);
const { IntercomBrokerRetiringError, isIntercomBrokerRetiring } = await import(
	"../../packages/intercom/recoverable-disconnect.js"
);

const tempDirs: string[] = [];

function createTempAgentDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ic-routing-"));
	mkdirSync(getIntercomDirPath(dir), { recursive: true });
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	vi.restoreAllMocks();
	control.calls.length = 0;
	control.socketAnswering = true;
	control.onControl = undefined;
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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
	const legacy = { min: 1, max: 1 };
	control.reply = report({ status: "on" }, selection);
	assert.deepEqual(await queryBrokerRouting("/unused"), {
		acrossMachines: true,
		hasSharedStorage: true,
		protocol: legacy,
	});
	control.reply = report({ status: "off" }, selection);
	assert.deepEqual(await queryBrokerRouting("/unused"), {
		acrossMachines: false,
		hasSharedStorage: true,
		protocol: legacy,
	});
	control.reply = report({ status: "off" });
	assert.deepEqual(await queryBrokerRouting("/unused"), {
		acrossMachines: false,
		hasSharedStorage: false,
		protocol: legacy,
	});
});

test("a status report's protocol range is the broker's, and a report without one is protocol 1 (#4538)", async () => {
	const report = (protocol?: unknown) => ({
		connected: true,
		reply: {
			type: "broker_status",
			requestId: "r",
			report: { pid: 1, sessions: 0, multiNode: { status: "off" }, ...(protocol === undefined ? {} : { protocol }) },
		},
	});
	control.reply = report({ min: 1, max: 2 });
	assert.deepEqual((await queryBrokerRouting("/unused")).protocol, { min: 1, max: 2 });
	control.reply = report({ min: 3, max: 7 });
	assert.deepEqual((await queryBrokerRouting("/unused")).protocol, { min: 3, max: 7 });
	control.reply = report();
	assert.deepEqual((await queryBrokerRouting("/unused")).protocol, { min: 1, max: 1 });
	for (const malformed of [{ min: 2, max: 1 }, { min: 0, max: 1 }, { min: 1.5, max: 2 }, { max: 2 }, [1, 2], "2"]) {
		control.reply = report(malformed);
		const error = await queryBrokerRouting("/unused").catch((caught: unknown) => caught);
		assert.ok(isIntercomRoutingUnavailableError(error), JSON.stringify(malformed));
		assert.deepEqual([error.reason, error.phase], ["malformed", "broker_status"]);
	}
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

test("a broker that closes the status request without answering while still answering is unsupported at the broker_status phase (#4320)", async () => {
	const dir = createTempAgentDir();
	control.reply = { connected: true };
	control.socketAnswering = true;
	const error = await queryBrokerRouting(dir).catch((caught: unknown) => caught);
	assert.ok(isIntercomRoutingUnavailableError(error));
	assert.deepEqual([error.reason, error.phase, error.retryable], ["unsupported", "broker_status", true]);
	assert.equal(control.calls.length, 1);
});

test("a broker that closes the status request without answering and stops answering is retiring, not unsupported (#4538)", async () => {
	const dir = createTempAgentDir();
	control.reply = { connected: true };
	control.socketAnswering = false;
	const error = await queryBrokerRouting(dir).catch((caught: unknown) => caught);
	assert.ok(error instanceof IntercomBrokerRetiringError, String(error));
	assert.equal(isIntercomBrokerRetiring(error), true);
	assert.equal(isIntercomRoutingUnavailableError(error), false);
});

test("a status request dropped while the broker is replaced (broker.pid changed or unlinked) is retiring even if the successor already answers (#4538)", async () => {
	for (const scenario of ["unlinked", "replaced-pid", "replaced-same-pid-new-mtime", "created"] as const) {
		const dir = createTempAgentDir();
		const pidPath = getBrokerPidPath(dir);
		if (scenario !== "created") {
			writeFileSync(pidPath, String(process.pid));
			const earlier = (Date.now() - 5_000) / 1_000;
			utimesSync(pidPath, earlier, earlier);
		}
		control.reply = { connected: true };
		control.socketAnswering = true;
		control.onControl = () => {
			if (scenario === "unlinked") rmSync(pidPath, { force: true });
			else if (scenario === "replaced-pid") writeFileSync(pidPath, String(process.pid + 1));
			else if (scenario === "replaced-same-pid-new-mtime") {
				writeFileSync(pidPath, String(process.pid));
				const later = Date.now() / 1_000;
				utimesSync(pidPath, later, later);
			} else if (scenario === "created") writeFileSync(pidPath, String(process.pid));
		};
		const error = await queryBrokerRouting(dir).catch((caught: unknown) => caught);
		assert.ok(error instanceof IntercomBrokerRetiringError, `${scenario}: ${String(error)}`);
		assert.equal(isIntercomRoutingUnavailableError(error), false, scenario);
	}
});

test("a status request dropped while a live spawn lock is held is retiring even if the socket still briefly answers (#4538)", async () => {
	for (const createdAt of [Date.now(), Date.now() - BROKER_SPAWN_LOCK_MAX_AGE_MS + 5_000]) {
		const dir = createTempAgentDir();
		writeFileSync(getBrokerSpawnLockPath(dir), `${process.pid}\n${createdAt}\n`);
		control.reply = { connected: true };
		control.socketAnswering = true;
		const error = await queryBrokerRouting(dir).catch((caught: unknown) => caught);
		assert.ok(error instanceof IntercomBrokerRetiringError, String(error));
		assert.equal(isIntercomRoutingUnavailableError(error), false);
	}
});

test("a stale spawn lock does not mask an answering broker that drops broker_status as unsupported (#4538)", async () => {
	const staleLocks = [
		`99999999\n${Date.now()}\n`,
		`${process.pid}\n${Date.now() - BROKER_SPAWN_LOCK_MAX_AGE_MS - 1_000}\n`,
		"",
	];
	if (process.platform === "linux" || process.platform === "win32") {
		staleLocks.push(`${process.pid} mismatched-start-token\n${Date.now()}\n`);
	}
	for (const staleLock of staleLocks) {
		const dir = createTempAgentDir();
		writeFileSync(getBrokerSpawnLockPath(dir), staleLock);
		control.reply = { connected: true };
		control.socketAnswering = true;
		control.calls.length = 0;
		const error = await queryBrokerRouting(dir).catch((caught: unknown) => caught);
		assert.ok(isIntercomRoutingUnavailableError(error), `${JSON.stringify(staleLock)}: ${String(error)}`);
		assert.deepEqual([error.reason, error.phase], ["unsupported", "broker_status"]);
		assert.equal(control.calls.length, 1);
	}
});

test("a status request dropped by a crashed broker whose broker.pid names an exited process is retiring even if the pipe briefly answers (#4538)", async () => {
	const dir = createTempAgentDir();
	writeFileSync(getBrokerPidPath(dir), "99999999");
	control.reply = { connected: true };
	control.socketAnswering = true;
	const error = await queryBrokerRouting(dir).catch((caught: unknown) => caught);
	assert.ok(error instanceof IntercomBrokerRetiringError, String(error));
	assert.equal(isIntercomRoutingUnavailableError(error), false);
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

import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const control = vi.hoisted(() => ({ reply: undefined as unknown, calls: [] as unknown[][] }));

vi.mock("../../packages/intercom/broker/control-request.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../packages/intercom/broker/control-request.js")>()),
	controlRequest: async (...args: unknown[]) => {
		control.calls.push(args);
		return control.reply;
	},
}));

const { isProcessAlive, requestBrokerShutdown, waitForBrokerExit, BROKER_STOP_TIMEOUT_MS } = await import(
	"../../packages/intercom/broker/broker-stop.js"
);
const { BROKER_CONTROL_TIMEOUT_MS } = await import("../../packages/intercom/broker/control-request.js");
const { isIntercomBrokerStopTimeoutError, isRetryableIntercomBrokerError } = await import("@bastani/atomic");
const { localOnlyBrokerWarning, resetLocalOnlyBrokerWarningWithoutUi, warnLocalOnlyBrokerWithoutUi } = await import(
	"../../packages/intercom/local-only-broker.js"
);
const { IntercomBrokerUpgradeError, IntercomRoutingUnavailableError } = await import("@bastani/atomic");

afterEach(() => {
	vi.restoreAllMocks();
	control.calls.length = 0;
	resetLocalOnlyBrokerWarningWithoutUi();
});

function killThrowing(code: string): void {
	vi.spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error(code), { code });
	});
}

describe("stopping a broker (#4538)", () => {
	test("a process is alive while signal 0 reaches it, or is refused for permission, and gone once it is not found", () => {
		assert.equal(isProcessAlive(process.pid), true);
		killThrowing("EPERM");
		assert.equal(isProcessAlive(4242), true);
		vi.restoreAllMocks();
		killThrowing("ESRCH");
		assert.equal(isProcessAlive(4242), false);
	});

	test("a shutdown request reports whether the broker acknowledged it, closed it unanswered, or was already gone", async () => {
		const cases: ReadonlyArray<readonly [unknown, string]> = [
			[{ connected: false }, "gone"],
			[{ connected: true }, "unanswered"],
			[{ connected: true, timedOut: true }, "unanswered"],
			[{ connected: true, reply: { type: "shutdown_ack", requestId: "r" } }, "acknowledged"],
		];
		for (const [reply, answer] of cases) {
			control.reply = reply;
			assert.equal(await requestBrokerShutdown("/broker.sock"), answer, JSON.stringify(reply));
		}
		assert.deepEqual(control.calls[0], ["/broker.sock", "shutdown", "shutdown_ack", BROKER_CONTROL_TIMEOUT_MS]);
		await requestBrokerShutdown("/other.sock", 123);
		assert.deepEqual(control.calls.at(-1), ["/other.sock", "shutdown", "shutdown_ack", 123]);
	});

	test("waiting for an exited broker returns at once, and a broker still running past the bound is a typed stop timeout", async () => {
		killThrowing("ESRCH");
		await waitForBrokerExit(4242, 1);
		vi.restoreAllMocks();

		assert.equal(BROKER_STOP_TIMEOUT_MS, 10_000);
		const startedAt = Date.now();
		const error = await waitForBrokerExit(process.pid, 120).catch((caught: unknown) => caught);
		assert.ok(isIntercomBrokerStopTimeoutError(error), String(error));
		assert.deepEqual([error.pid, error.timeoutMs, error.phase, error.retryable], [process.pid, 120, "stop", true]);
		assert.ok(error.elapsedMs >= 120 && error.elapsedMs <= Date.now() - startedAt, String(error.elapsedMs));
		assert.equal(isRetryableIntercomBrokerError(error), true);
	});
});

describe("the single-machine warning (#4538)", () => {
	test("names why the broker cannot be verified and how to replace it, and a failed replacement when there was one", () => {
		const plain = localOnlyBrokerWarning(new IntercomRoutingUnavailableError("malformed", "broker_status"));
		assert.equal(
			plain,
			"The running Intercom broker cannot verify how it routes (broker_status: malformed). No multi-node storage is configured, so this session uses it on this machine only; run `atomic intercom restart` to replace it with this version's broker.",
		);
		const failure = new IntercomBrokerUpgradeError({ phase: "stop", previousPid: 9, previousProtocolMax: 1 });
		const withCause = localOnlyBrokerWarning(
			new IntercomRoutingUnavailableError("unsupported", "register", { cause: failure }),
		);
		assert.equal(
			withCause,
			`${plain.replace("broker_status: malformed", "register: unsupported")} Replacing it failed: ${failure.message}`,
		);
	});

	test("a session without a UI writes it to stderr once per process, until it is reset", () => {
		const lines: string[] = [];
		const reason = new IntercomRoutingUnavailableError("unsupported", "broker_status");
		warnLocalOnlyBrokerWithoutUi(reason, (line) => lines.push(line));
		warnLocalOnlyBrokerWithoutUi(reason, (line) => lines.push(line));
		assert.deepEqual(lines, [`Warning: ${localOnlyBrokerWarning(reason)}`]);
		resetLocalOnlyBrokerWarningWithoutUi();
		warnLocalOnlyBrokerWithoutUi(reason, (line) => lines.push(line));
		assert.equal(lines.length, 2);
		const written = vi.spyOn(console, "error").mockImplementation(() => {});
		resetLocalOnlyBrokerWarningWithoutUi();
		warnLocalOnlyBrokerWithoutUi(reason);
		assert.deepEqual(written.mock.calls, [[`Warning: ${localOnlyBrokerWarning(reason)}`]]);
	});
});

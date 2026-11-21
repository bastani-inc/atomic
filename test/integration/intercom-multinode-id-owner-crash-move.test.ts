import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, test, vi } from "vitest";
import { BROKER_CONNECT_TIMEOUT_MS } from "../../packages/intercom/broker/client.js";
import { BROKER_LEASE_STALE_AFTER_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import {
	type TwoBrokerClient,
	TwoBrokerHarness,
	twoBrokerHarnessStartTimeoutMs,
} from "../helpers/intercom-two-broker-harness.js";
import { type RecordedProcess, recordProcess, signalRecordedProcess } from "../helpers/recorded-process.js";
import { sleep } from "../helpers/runtime.js";

/**
 * #5607: broker "a" stops (its process is stopped, so no broker can tell it apart from one on another machine that
 * crashed) while it holds a session's id. The session registers on broker "b" half a second later and gets a fresh id
 * while "a" still holds the one it asked for. Once that hold lapses, "b" takes the id back for it: sends to the id reach
 * the session throughout, and the fresh id stays an alias of it. A session that registers on "b" after the hold lapsed
 * gets its id at once.
 */

const HARNESS = { nodes: ["a", "b", "c"] } as const;
const REAL_BROKERS_HOOK_TIMEOUT_MS = twoBrokerHarnessStartTimeoutMs(HARNESS);
/** The stopped broker's hold lapses only after the owner lease's stale age: the structural cost of this test. */
const AFTER_THE_HOLD_LAPSES_MS = BROKER_LEASE_STALE_AFTER_MS + 10_000;
const TEST_TIMEOUT_MS = AFTER_THE_HOLD_LAPSES_MS + 60_000;
const WAIT = { timeout: 20_000, interval: 50 };

let harness: TwoBrokerHarness;
let stopped: RecordedProcess | undefined;

beforeAll(async () => {
	harness = await TwoBrokerHarness.start(HARNESS);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(async () => {
	if (stopped !== undefined) await signalRecordedProcess(stopped, "SIGCONT");
	await harness?.cleanup();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

function textsOf(client: TwoBrokerClient): string[] {
	return client.received.flatMap((frame) => {
		const text = (frame.message.content as { text?: unknown }).text;
		return typeof text === "string" ? [text] : [];
	});
}

function disconnectedOnce(client: TwoBrokerClient): Promise<void> {
	return new Promise((resolve) => client.client.once("disconnected", () => resolve()));
}

async function within(promise: Promise<void>, ms: number, what: string): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

test.skipIf(process.platform === "win32")(
	"a session that moves to another broker while the stopped broker it left still holds its id gets that id back once the hold lapses, and sends to it reach the session throughout (#5607)",
	async () => {
		assert.equal(harness.multiNodeRouting, true);
		const sender = await harness.connect("c", unique("sender"));
		const moving = { id: randomUUID(), returnAddress: randomUUID(), name: unique("moving") };
		const late = { id: randomUUID(), returnAddress: randomUUID(), name: unique("late") };
		const first = await harness.connect("a", moving.name, {
			preferredSessionId: moving.id,
			returnAddress: moving.returnAddress,
		});
		assert.equal(first.sessionId, moving.id);
		const lateFirst = await harness.connect("a", late.name, {
			preferredSessionId: late.id,
			returnAddress: late.returnAddress,
		});
		assert.equal(lateFirst.sessionId, late.id);

		const pid = harness.brokerPid("a");
		assert.ok(pid !== undefined);
		stopped = await recordProcess(pid);
		assert.ok(await signalRecordedProcess(stopped, "SIGSTOP"));
		const stoppedAt = performance.now();
		await sleep(500);

		// While "a" still holds the id, the session gets a fresh one, and is told which id it awaits.
		const moved = await harness.connect("b", moving.name, {
			preferredSessionId: moving.id,
			returnAddress: moving.returnAddress,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});
		const fresh = moved.sessionId;
		assert.notEqual(fresh, moving.id);
		const awaited = moved.client.awaitedSessionId;
		const switched = disconnectedOnce(moved);

		await sleep(Math.max(0, stoppedAt + 5_000 - performance.now()));
		// Queued for the session, as while its earlier broker still holds the id; never refused.
		const early = sender.client.send(moving.id, { text: "to the id at 5 s" });
		await vi.waitFor(() => assert.ok(textsOf(moved).includes("to the id at 5 s")), WAIT);
		assert.notEqual((await early).reason, "Session not found");

		// Once the hold lapses, "b" takes the id back for the session and has it register again under it.
		await within(switched, AFTER_THE_HOLD_LAPSES_MS, "the move back to the id");
		assert.equal(awaited, moving.id, "it was told which id it awaited, so it asks for that one again");
		const back = await harness.connect("b", moving.name, {
			preferredSessionId: moving.id,
			returnAddress: moving.returnAddress,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});
		assert.equal(back.sessionId, moving.id);

		// A session that moves only after the hold lapsed gets its id at once.
		await sleep(Math.max(0, stoppedAt + AFTER_THE_HOLD_LAPSES_MS - performance.now()));
		const lateMoved = await harness.connect("b", late.name, {
			preferredSessionId: late.id,
			returnAddress: late.returnAddress,
			connectTimeoutMs: BROKER_CONNECT_TIMEOUT_MS,
		});
		assert.equal(lateMoved.sessionId, late.id);

		const after = await sender.client.send(moving.id, { text: "to the id at 40 s" });
		assert.equal(after.delivered, true, JSON.stringify(after));
		await vi.waitFor(() => assert.ok(textsOf(back).includes("to the id at 40 s")), WAIT);
		// The id it had meanwhile still reaches it, from this broker and from another.
		const local = await harness.connect("b", unique("local"));
		const toFresh = await local.client.send(fresh, { text: "to the fresh id from b" });
		assert.equal(toFresh.delivered, true, JSON.stringify(toFresh));
		const remote = await sender.client.send(fresh, { text: "to the fresh id from c" });
		assert.equal(remote.delivered, true, JSON.stringify(remote));
		await vi.waitFor(
			() =>
				assert.deepEqual(
					["to the fresh id from b", "to the fresh id from c"].filter((text) => textsOf(back).includes(text)),
					["to the fresh id from b", "to the fresh id from c"],
				),
			WAIT,
		);
		assert.equal(textsOf(back).filter((text) => text === "to the id at 40 s").length, 1, "delivered once");
	},
	TEST_TIMEOUT_MS,
);

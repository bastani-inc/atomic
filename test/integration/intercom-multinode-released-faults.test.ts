import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, test, vi } from "vitest";
import {
	BROKER_LEASE_STALE_AFTER_MS,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import { getJitiCliPath } from "../../packages/intercom/broker/spawn.js";
import type { SupervisorRegistration } from "../../packages/intercom/types.js";
import {
	type ReceivedFrame,
	TWO_BROKER_STORAGE_PREFIX,
	type TwoBrokerClient,
	TwoBrokerHarness,
} from "../helpers/intercom-two-broker-harness.js";
import { sleep } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

/** Spawning two real broker processes (and restarting them) is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
/** An owner process loads the Intercom client through jiti before it can connect. */
const OWNER_PROCESS_READY_MS = 30_000;
const DELIVERY_WAIT_MS = 15_000;
/** Headroom for broker restarts, an owner process start-up and the deliveries after them. */
const RECOVERY_MARGIN_MS = 60_000;
/** The reservation must be stale before the other node queues sends instead of holding them. */
const BROKER_KILL_TEST_TIMEOUT_MS = BROKER_LEASE_STALE_AFTER_MS + OUTBOX_BACKUP_POLL_INTERVAL_MS + RECOVERY_MARGIN_MS;
/** Three owner processes start one after another. */
const OWNER_KILL_TEST_TIMEOUT_MS = 3 * OWNER_PROCESS_READY_MS + RECOVERY_MARGIN_MS;
const SENDS = 3;

const repoRoot = resolve(import.meta.dirname, "../..");
const ownerFixture = join(repoRoot, "test/fixtures/intercom-released-owner.ts");
const OUTBOX_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_outbox`;
const RESERVATIONS_TABLE = `${TWO_BROKER_STORAGE_PREFIX}intercom_restoring_reservations`;

let harness: TwoBrokerHarness;
const ownerProcesses: ChildProcess[] = [];

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(async () => {
	for (const owner of ownerProcesses) if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGKILL");
	await harness?.cleanup();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
beforeEach(() => harness.ensureBrokersRunning(), REAL_BROKERS_HOOK_TIMEOUT_MS);

const unique = (label: string): string => `${label}-${randomUUID().slice(0, 8)}`;

interface ReleasedChild {
	readonly name: string;
	readonly returnAddress: string;
	readonly sessionId: string;
	readonly aliases: readonly string[];
}

/** A subagent that ran once on node b, so every broker knows its session, and was then released. */
async function releasedChild(): Promise<ReleasedChild> {
	const name = unique("released-child");
	const returnAddress = randomUUID();
	const sessionId = randomUUID();
	const child = await harness.connect("b", name, { returnAddress, preferredSessionId: sessionId });
	assert.equal(child.sessionId, sessionId);
	await harness.disconnect(child);
	return { name, returnAddress, sessionId, aliases: [returnAddress, sessionId] };
}

/** The woken child connects again as the same session, under its owner's authorization. */
function reconnectChild(child: ReleasedChild, supervisor: SupervisorRegistration): Promise<TwoBrokerClient> {
	return harness.connect("b", child.name, {
		returnAddress: child.returnAddress,
		preferredSessionId: child.sessionId,
		supervisor,
	});
}

/** Sends from the other node that are queued for the offline child, one after another. */
async function queueSends(sender: TwoBrokerClient, child: ReleasedChild): Promise<string[]> {
	const ids: string[] = [];
	for (let index = 0; index < SENDS; index++) {
		const result = await sender.client.send(child.name, { text: `queued ${index}`, messageId: randomUUID() });
		assert.equal(result.queued, true, JSON.stringify(result));
		assert.equal(result.target, "offline session");
		ids.push(result.id);
	}
	return ids;
}

async function shared() {
	return harness.openSharedStorage("a");
}

async function reservationEnded(childName: string): Promise<boolean> {
	const row = await (await shared()).get<{ end_json: string | null }>(
		`SELECT end_json FROM ${RESERVATIONS_TABLE} WHERE reservation_key = ?`,
		releasedReservationKey(childName),
	);
	return row !== undefined && row.end_json !== null;
}

async function outboxStates(ids: readonly string[]): Promise<string[]> {
	const database = await shared();
	const states: string[] = [];
	for (const id of ids) {
		const row = await database.get<{ state: string }>(`SELECT state FROM ${OUTBOX_TABLE} WHERE message_id = ?`, id);
		states.push(row?.state ?? "missing");
	}
	return states;
}

/** Each queued send arrives once, in the order it was sent, and its row is settled as delivered. */
async function assertDeliveredOnceInOrder(child: TwoBrokerClient, ids: readonly string[]): Promise<void> {
	const delivered = (frame: ReceivedFrame) => ids.includes(frame.message.id);
	await vi.waitFor(() => assert.equal(child.received.filter(delivered).length, ids.length), {
		timeout: DELIVERY_WAIT_MS,
		interval: 25,
	});
	await vi.waitFor(
		async () =>
			assert.deepEqual(
				await outboxStates(ids),
				ids.map(() => "delivered"),
			),
		{
			timeout: DELIVERY_WAIT_MS,
			interval: 50,
		},
	);
	assert.deepEqual(
		child.received.map((frame) => frame.message.id),
		ids,
	);
}

interface OwnerProcess {
	readonly process: ChildProcess;
	readonly supervisor: SupervisorRegistration;
	readonly wakes: Array<{ readonly childName: string }>;
}

interface OwnerIdentity {
	readonly name: string;
	readonly returnAddress: string;
	readonly sessionId: string;
	readonly token: string;
}

/** Start the owner in a process of its own on node b; it reserves the child for waking and authorizes it. */
async function startOwnerProcess(owner: OwnerIdentity, child: ReleasedChild): Promise<OwnerProcess> {
	const ownerProcess = spawn(
		process.execPath,
		[
			getJitiCliPath(join(repoRoot, "packages/intercom")),
			ownerFixture,
			owner.name,
			owner.returnAddress,
			owner.sessionId,
			owner.token,
			child.name,
			JSON.stringify(child.aliases),
		],
		{ cwd: repoRoot, env: { ...process.env, ATOMIC_CODING_AGENT_DIR: harness.agentDir("b") }, stdio: "pipe" },
	);
	ownerProcesses.push(ownerProcess);
	const wakes: Array<{ readonly childName: string }> = [];
	let stdout = "";
	let stderr = "";
	ownerProcess.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const ready = new Promise<SupervisorRegistration>((resolveReady, rejectReady) => {
		const timer = setTimeout(
			() => rejectReady(new Error(`owner process never became ready:\n${stderr}`)),
			OWNER_PROCESS_READY_MS,
		);
		ownerProcess.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			const lines = stdout.split("\n");
			stdout = lines.pop() ?? "";
			for (const line of lines) {
				if (line.startsWith("WAKE ")) wakes.push(JSON.parse(line.slice(5)) as { childName: string });
				if (line.startsWith("READY ")) {
					clearTimeout(timer);
					const { capability, supervisorSessionId } = JSON.parse(line.slice(6)) as SupervisorRegistration;
					resolveReady({ capability, supervisorSessionId });
				}
			}
		});
		ownerProcess.once("exit", (code, signal) => {
			clearTimeout(timer);
			rejectReady(new Error(`owner process exited with ${code ?? signal}:\n${stderr}`));
		});
	});
	return { process: ownerProcess, supervisor: await ready, wakes };
}

async function killOwnerProcess(owner: OwnerProcess): Promise<void> {
	const exited = new Promise<void>((resolveExit) => owner.process.once("exit", () => resolveExit()));
	owner.process.kill("SIGKILL");
	await exited;
}

test(
	"sends queued while the owner's broker and the sender's broker were killed reach the released child once each, in order, after both restart (#4401)",
	async () => {
		const ownerToken = randomUUID();
		const owner = await harness.connect("b", unique("released-owner"), { supervisorOwnerToken: ownerToken });
		const sender = await harness.connect("a", unique("released-sender"));
		assert.equal(harness.multiNodeRouting, true, "the two brokers route across nodes");
		const ownerSessionId = owner.sessionId;
		const senderSessionId = sender.sessionId;
		const child = await releasedChild();
		await owner.client.reserveReleasedChildren([{ childName: child.name, aliases: child.aliases, wake: true }]);
		await vi.waitFor(
			async () => {
				const row = await (await shared()).get(
					`SELECT 1 FROM ${RESERVATIONS_TABLE} WHERE reservation_key = ? AND end_json IS NULL`,
					releasedReservationKey(child.name),
				);
				assert.ok(row);
			},
			{ timeout: DELIVERY_WAIT_MS, interval: 25 },
		);

		await harness.stopBroker("b", "SIGKILL");
		await sleep(BROKER_LEASE_STALE_AFTER_MS + 1_000);
		const ids = await queueSends(sender, child);
		await harness.stopBroker("a", "SIGKILL");
		await harness.startBroker("a");
		await harness.startBroker("b");

		const wakes: Array<{ childName: string }> = [];
		const back = await harness.connect("b", owner.name, {
			returnAddress: owner.returnAddress,
			preferredSessionId: ownerSessionId,
			supervisorOwnerToken: ownerToken,
		});
		assert.equal(back.sessionId, ownerSessionId);
		back.client.on("restoring_recipient_wake", (notice: { childName: string }) => wakes.push(notice));
		await back.client.reserveReleasedChildren([{ childName: child.name, aliases: child.aliases, wake: true }]);
		await vi.waitFor(() => assert.deepEqual(wakes, [{ childName: child.name }]), {
			timeout: DELIVERY_WAIT_MS,
			interval: 25,
		});

		const authorization = await back.client.authorizeSupervisorChild(child.name);
		const woken = await reconnectChild(child, {
			capability: authorization.capability,
			supervisorSessionId: authorization.supervisorSessionId,
		});
		await assertDeliveredOnceInOrder(woken, ids);
		assert.equal(wakes.length, 1);

		const resender = await harness.connect("a", sender.name, {
			returnAddress: sender.returnAddress,
			preferredSessionId: senderSessionId,
		});
		for (const [index, id] of ids.entries()) {
			const retry = await resender.client.send(child.name, { text: `queued ${index}`, messageId: id });
			assert.equal(retry.delivered, true, JSON.stringify(retry));
		}
		assert.deepEqual(
			woken.received.map((frame) => frame.message.id),
			ids,
			"a retry of a delivered send is answered from its row, never delivered again",
		);
	},
	BROKER_KILL_TEST_TIMEOUT_MS,
);

test(
	"sends still queued when the owner's process is killed, before and after it woke the released child, reach the child once each, in order, through the next owner process (#4401)",
	async () => {
		const sender = await harness.connect("a", unique("released-sender"));
		assert.equal(harness.multiNodeRouting, true, "the two brokers route across nodes");
		const child = await releasedChild();
		const owner: OwnerIdentity = {
			name: unique("released-owner"),
			returnAddress: randomUUID(),
			sessionId: randomUUID(),
			token: randomUUID(),
		};
		const first = await startOwnerProcess(owner, child);
		assert.equal(await reservationEnded(child.name), false);
		await killOwnerProcess(first);
		await vi.waitFor(async () => assert.equal(await reservationEnded(child.name), true), {
			timeout: DELIVERY_WAIT_MS,
			interval: 25,
		});
		const ids = await queueSends(sender, child);
		assert.deepEqual(first.wakes, []);

		const second = await startOwnerProcess(owner, child);
		await vi.waitFor(() => assert.deepEqual(second.wakes, [{ childName: child.name }]), {
			timeout: DELIVERY_WAIT_MS,
			interval: 25,
		});
		assert.deepEqual(await outboxStates(ids), ["queued", "queued", "queued"]);
		await killOwnerProcess(second);
		await vi.waitFor(async () => assert.equal(await reservationEnded(child.name), true), {
			timeout: DELIVERY_WAIT_MS,
			interval: 25,
		});

		const third = await startOwnerProcess(owner, child);
		await vi.waitFor(() => assert.deepEqual(third.wakes, [{ childName: child.name }]), {
			timeout: DELIVERY_WAIT_MS,
			interval: 25,
		});
		const woken = await reconnectChild(child, third.supervisor);
		await assertDeliveredOnceInOrder(woken, ids);
		assert.equal(second.wakes.length, 1);
		assert.equal(third.wakes.length, 1);
		await killOwnerProcess(third);
	},
	OWNER_KILL_TEST_TIMEOUT_MS,
);

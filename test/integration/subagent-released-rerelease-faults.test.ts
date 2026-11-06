import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { BROKER_LEASE_STALE_AFTER_MS } from "../../packages/intercom/broker/multinode-state-store.js";
import { SHARED_LEASES_TABLE, type TwoBrokerClient, TwoBrokerHarness } from "../helpers/intercom-two-broker-harness.js";
import { decodeStream, moduleDir, type SpawnedProcess, spawnProcess } from "../helpers/runtime.js";
import { useTemporaryAgentDir } from "../helpers/temporary-agent-dir.js";

useTemporaryAgentDir();

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const OWNER_FIXTURE = join(ROOT, "test/fixtures/released-subagent-owner.ts");
/** One module instance per owner process: the packages the sources import from each other resolve to their sources. */
const SOURCE_ALIASES = JSON.stringify({
	"@bastani/atomic/storage": join(ROOT, "packages/coding-agent/src/core/storage/index.ts"),
	"@bastani/atomic": join(ROOT, "packages/coding-agent/src/index.ts"),
});
/** Spawning two real broker processes (and restarting one) is the structural cost of this suite. */
const REAL_BROKERS_HOOK_TIMEOUT_MS = 60_000;
/** An owner process loads the subagent, Intercom and session sources through jiti before it binds. */
const OWNER_PROCESS_READY_MS = 60_000;
/** A wake, the woken run, and its release after the fixture's short release delay. */
const SETTLE_MS = 30_000;
/** A crashed broker's presence lease for the child must be stale before a send stops routing to that broker. */
const PRESENCE_GONE_MS = BROKER_LEASE_STALE_AFTER_MS + SETTLE_MS;
/** Two owner processes start, the broker restarts once, and the child is woken five times. */
const FAULTS_TEST_TIMEOUT_MS = 2 * OWNER_PROCESS_READY_MS + 6 * SETTLE_MS + PRESENCE_GONE_MS;

let harness: TwoBrokerHarness;
const owners: OwnerProcess[] = [];

beforeAll(async () => {
	harness = await TwoBrokerHarness.start();
	// The owner's Intercom reconnects to the harness's broker; it never starts one of its own on node b.
	mkdirSync(join(harness.agentDir("b"), "intercom"), { recursive: true });
	writeFileSync(
		join(harness.agentDir("b"), "intercom", "config.json"),
		JSON.stringify({ brokerCommand: process.execPath, brokerArgs: ["-e", "process.exit(1)"] }),
	);
}, REAL_BROKERS_HOOK_TIMEOUT_MS);
afterAll(async () => {
	for (const owner of owners) owner.kill();
	await Promise.all(owners.map((owner) => owner.process.exited));
	await harness?.cleanup();
}, REAL_BROKERS_HOOK_TIMEOUT_MS);

interface ChildRecord {
	readonly state: string;
	readonly terminalStatus: string | null;
	readonly childSessionFile: string | null;
}

/** One owner process on node b and what it printed: its child's runs, records and received messages. */
class OwnerProcess {
	readonly records: ChildRecord[] = [];
	readonly runs: Array<{ readonly started: number; ended?: number }> = [];
	received: string[] = [];
	read: string[] = [];
	ready = false;
	group = "";
	stderr = "";
	private output = "";
	private readonly listeners = new Set<() => void>();

	constructor(readonly process: SpawnedProcess) {}

	static start(phase: "launch" | "recover", dir: string, childName: string): OwnerProcess {
		const owner = new OwnerProcess(
			spawnProcess([process.execPath, "--import", "jiti/register", OWNER_FIXTURE, phase, dir, childName], {
				cwd: ROOT,
				env: { ...process.env, JITI_ALIAS: SOURCE_ALIASES, ATOMIC_CODING_AGENT_DIR: harness.agentDir("b") },
				stdout: "pipe",
				stderr: "pipe",
			}),
		);
		owners.push(owner);
		void owner.readStdout();
		void owner.drainStderr();
		return owner;
	}

	private async readStdout(): Promise<void> {
		const stdout = this.process.stdout;
		if (!stdout) return;
		for await (const chunk of decodeStream(stdout)) {
			this.output += chunk;
			const lines = this.output.split("\n");
			this.output = lines.pop() ?? "";
			for (const line of lines) this.take(line);
			for (const listener of this.listeners) listener();
		}
	}

	private async drainStderr(): Promise<void> {
		const stderr = this.process.stderr;
		if (!stderr) return;
		for await (const chunk of decodeStream(stderr)) this.stderr += chunk;
	}

	private take(line: string): void {
		if (line.startsWith("READY ")) {
			this.group = line.slice("READY ".length);
			this.ready = true;
		} else if (line.startsWith("RUN start ")) this.runs.push({ started: Date.now() });
		else if (line.startsWith("RUN end ")) {
			const run = this.runs[Number(line.slice("RUN end ".length)) - 1];
			if (run) run.ended = Date.now();
		} else if (line.startsWith("RECORD ")) this.records.push(JSON.parse(line.slice(7)) as ChildRecord);
		else if (line.startsWith("RECEIVED ")) this.received = JSON.parse(line.slice(9)) as string[];
		else if (line.startsWith("READ ")) this.read = JSON.parse(line.slice(5)) as string[];
	}

	/** Runs at once when a line arrives that makes `condition` true, so a test can act inside a short window. */
	when(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
		if (condition()) return Promise.resolve();
		return new Promise((resolveWhen, rejectWhen) => {
			const timer = setTimeout(() => {
				this.listeners.delete(check);
				rejectWhen(
					new Error(`${label}: ${JSON.stringify({ records: this.records, runs: this.runs })}\n${this.stderr}`),
				);
			}, timeoutMs);
			const check = () => {
				if (!condition()) return;
				clearTimeout(timer);
				this.listeners.delete(check);
				resolveWhen();
			};
			this.listeners.add(check);
		});
	}

	get latest(): ChildRecord | undefined {
		return this.records.at(-1);
	}

	get running(): boolean {
		return this.runs.some((run) => run.ended === undefined);
	}

	/** Released again: its latest record says so and no run of it is going on. */
	released(): boolean {
		return this.latest?.state === "terminal" && this.latest.terminalStatus === "released" && !this.running;
	}

	kill(): void {
		if (this.process.exitCode === null && this.process.signalCode === null) this.process.kill("SIGKILL");
	}
}

/**
 * No live presence of the child is left in the shared store: the one a crashed broker held has gone stale. Until then
 * the other node routes a send to that broker, which is a delivery outcome of its own (#4401), not a wake.
 */
async function presenceGone(childName: string): Promise<void> {
	const database = await harness.openSharedStorage("a");
	await vi.waitFor(
		async () => {
			const rows = await database.all<{ subject_json: string; age_ms: number }>(
				`SELECT subject_json, CAST(unixepoch('subsec') * 1000 AS INTEGER) - renewed_at AS age_ms
				 FROM "${SHARED_LEASES_TABLE}" WHERE kind = 'presence'`,
			);
			const live = rows.filter(
				(row) => row.subject_json.includes(JSON.stringify(childName)) && row.age_ms < BROKER_LEASE_STALE_AFTER_MS,
			);
			assert.deepEqual(live, []);
		},
		{ timeout: PRESENCE_GONE_MS, interval: 250 },
	);
}

/**
 * What an owner's crash can leave in its woken child's session: a message Intercom delivered and saved as a card the
 * moment it arrived, whose model-facing turn the child had not taken yet. Its session's recovery replays it.
 */
async function interruptedDelivery(childSessionFile: string, senderName: string): Promise<string> {
	const child = await SessionManager.open(childSessionFile);
	const id = randomUUID();
	const from = { id: randomUUID(), name: senderName, cwd: harness.root };
	await child.appendCustomMessageEntry(
		"intercom_message",
		`**📨 From ${senderName}** (${harness.root})\n\narrived just before its owner died`,
		true,
		{ from, message: { id, timestamp: Date.now(), content: { text: "arrived just before its owner died" } } },
		true,
		{ delivery: "steer" },
	);
	return id;
}

/** No two runs of the child overlapped in one owner process: each wake ran it once, after the last run ended. */
function assertRunsSequential(owner: OwnerProcess): void {
	for (let index = 1; index < owner.runs.length; index++) {
		const previous = owner.runs[index - 1];
		assert.ok(previous?.ended !== undefined && previous.ended <= (owner.runs[index]?.started ?? 0));
	}
}

test(
	"a subagent woken through Intercom while it waits on a shell is released again after broker and owner faults, and every send reaches it once (#4488)",
	async () => {
		assert.equal(harness.multiNodeRouting, true, "the two brokers route across nodes");
		const childName = `subagent-worker-rr-${randomUUID().slice(0, 8)}`;
		const dir = join(harness.root, "owner");
		const first = OwnerProcess.start("launch", dir, childName);
		await first.when(() => first.ready && first.released(), OWNER_PROCESS_READY_MS, "never released on its shell");
		const sender: TwoBrokerClient = await harness.connect("a", `released-sender-${randomUUID().slice(0, 8)}`, {
			group: first.group,
		});
		const sent: string[] = [];
		const send = async (owner: OwnerProcess, label: string): Promise<string> => {
			const runs = owner.runs.length;
			const result = await sender.client.send(childName, { text: label, messageId: randomUUID() });
			assert.ok(result.delivered === true || result.queued === true, JSON.stringify(result));
			sent.push(result.id);
			await owner.when(() => owner.runs.length > runs, SETTLE_MS, `${label} never woke the child`);
			return result.id;
		};
		const settled = (owner: OwnerProcess, id: string, label: string) =>
			owner.when(() => owner.received.includes(id) && owner.released(), SETTLE_MS, `${label} never settled`);

		const woken = await send(first, "woken while waiting on its shell");
		await settled(first, woken, "the first wake");

		// The broker its owner and the woken child use crashes mid-run; the child is released while Intercom reconnects.
		const midRun = await send(first, "woken before its broker crashes");
		await first.when(() => first.received.includes(midRun), SETTLE_MS, "the message before the crash never arrived");
		await harness.stopBroker("b", "SIGKILL");
		await harness.startBroker("b");
		await settled(first, midRun, "the wake across the broker crash");
		await presenceGone(childName);
		const afterBroker = await send(first, "woken after its broker restarted");
		await settled(first, afterBroker, "the wake after the broker restarted");

		// Its owner's process dies while the child is woken and has just been handed a message; the crash also leaves a
		// message Intercom saved for it a moment later, which it never read.
		const runsBefore = first.runs.length;
		const midWake = await send(first, "read just before its owner dies");
		await first.when(
			() => first.received.includes(midWake) && first.running,
			SETTLE_MS,
			"the child never read the message before its owner died",
		);
		first.kill();
		await first.process.exited;
		assert.equal(first.runs.length, runsBefore + 1, "one wake ran the child once");
		const childSessionFile = first.latest?.childSessionFile;
		assert.ok(childSessionFile, "the child's session is saved where its record says");
		const interrupted = await interruptedDelivery(childSessionFile, sender.name);
		sent.push(interrupted);

		const second = OwnerProcess.start("recover", dir, childName);
		await second.when(() => second.ready, OWNER_PROCESS_READY_MS, "the reopened owner never bound");
		await second.when(
			() =>
				second.released() || (second.latest?.state === "terminal" && second.latest.terminalStatus !== "released"),
			SETTLE_MS,
			"the restored child never settled",
		);
		assert.deepEqual(
			{ state: second.latest?.state, terminalStatus: second.latest?.terminalStatus },
			{ state: "terminal", terminalStatus: "released" },
			"restored, then released",
		);
		const afterOwner = await send(second, "woken by its reopened owner");
		await settled(second, afterOwner, "the wake after the owner restarted");

		assert.deepEqual(second.received, sent, "every message for the child reached it once, in the order it was sent");
		assert.deepEqual(
			second.read.filter((id) => id === interrupted),
			[interrupted],
			"the message its owner's crash interrupted was read once",
		);
		assertRunsSequential(first);
		assertRunsSequential(second);
	},
	FAULTS_TEST_TIMEOUT_MS,
);

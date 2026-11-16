import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import type { AttemptLease } from "../../packages/workflows/src/durable/journal/sql-shared-pool.js";
import { type ShipBatchRows, type ShipEvent, shipShardPath } from "../../packages/workflows/src/workers/ship-shard.js";
import {
	decodeStream,
	makeTempDirectory,
	readStreamText,
	removeTempDirectory,
	type SpawnedProcess,
	spawnProcess,
} from "../helpers/runtime.js";

const fixturePath = fileURLToPath(new URL("../fixtures/checkpoint-shipping-process.mjs", import.meta.url));
const ROOT = "root-4768";
const G1: AttemptLease = { id: "work-1", generation: 1, worker: "host-a/1", epoch: 1 };
const G2: AttemptLease = { id: "work-1", generation: 2, worker: "host-b/1", epoch: 1 };

type ShardCommand =
	| { readonly action: "open" }
	| { readonly action: "hold"; readonly lease: AttemptLease; readonly leaseMs: number }
	| {
			readonly action: "accept";
			readonly lease: AttemptLease;
			readonly key: string;
			readonly payload: string;
			readonly at: number;
	  }
	| { readonly action: "pending"; readonly lease: Pick<AttemptLease, "id" | "generation"> }
	| { readonly action: "leftover" }
	| {
			readonly action: "seal";
			readonly lease: Pick<AttemptLease, "id" | "generation">;
			readonly maxBatch: number;
	  }
	| { readonly action: "close" };

interface ShardFailureResponse {
	readonly id: number;
	readonly ok: false;
	readonly name: string;
	readonly message: string;
}

interface ShardSuccessResponse {
	readonly id: number;
	readonly ok: true;
	readonly pid?: number;
	readonly receipt?: { readonly localSeq: number; readonly accepted: boolean };
	readonly events?: readonly ShipEvent[];
	readonly items?: readonly { readonly lease: AttemptLease }[];
	readonly batch?: ShipBatchRows | null;
}

type ShardResponse = ShardSuccessResponse | ShardFailureResponse;

interface ShardReadyMessage {
	readonly event: "ready";
	readonly pid: number;
}

interface ShardProcess {
	readonly child: SpawnedProcess;
	readonly call: (command: ShardCommand) => Promise<ShardResponse>;
}

const directories: string[] = [];
const processes: ShardProcess[] = [];

afterEach(async () => {
	for (const proc of processes.splice(0)) {
		if (proc.child.exitCode === null && proc.child.signalCode === null) proc.child.kill("SIGKILL");
		await proc.child.exited.catch(() => {});
	}
	for (const directory of directories.splice(0)) removeTempDirectory(directory);
});

async function spawnShardProcess(shardPath: string): Promise<ShardProcess> {
	const child = spawnProcess([process.execPath, fixturePath, shardPath, ROOT], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	assert.ok(child.stdin !== null && child.stdout !== null);
	const stdin = child.stdin;
	const stderrPromise = readStreamText(child.stderr);
	const reader = decodeStream(child.stdout).getReader();
	let buffer = "";
	const nextLine = async <T>(): Promise<T> => {
		for (;;) {
			const newline = buffer.indexOf("\n");
			if (newline !== -1) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				return JSON.parse(line) as T;
			}
			const chunk = await reader.read();
			if (chunk.done) throw new Error(`Shard fixture exited early: ${await stderrPromise}`);
			buffer += chunk.value;
		}
	};
	let seq = 0;
	const proc: ShardProcess = {
		child,
		async call(command) {
			const id = ++seq;
			stdin.write(`${JSON.stringify({ id, ...command })}\n`);
			await stdin.flush();
			const response = await nextLine<ShardResponse>();
			assert.equal(response.id, id);
			return response;
		},
	};
	processes.push(proc);
	const ready = await nextLine<ShardReadyMessage>();
	assert.equal(ready.event, "ready");
	return proc;
}

test("refuses concurrent cross-process ShipShard open and recovers persisted checkpoints after owner kill (#4768)", async () => {
	const directory = makeTempDirectory("ship-shard-process-");
	directories.push(directory);
	const shardPath = shipShardPath(directory, "journal-4768", ROOT);

	const first = await spawnShardProcess(shardPath);
	const firstOpen = await first.call({ action: "open" });
	assert.equal(firstOpen.ok, true);
	assert.equal((await first.call({ action: "hold", lease: G1, leaseMs: 60_000 })).ok, true);
	const persistedAccept = await first.call({
		action: "accept",
		lease: G1,
		key: "scope:persisted",
		payload: '{"step":1}',
		at: 1,
	});
	assert.equal(persistedAccept.ok, true);
	assert.deepEqual(persistedAccept.receipt, { localSeq: 1, accepted: true });

	const second = await spawnShardProcess(shardPath);
	const secondOpen = await second.call({ action: "open" });
	if (secondOpen.ok) {
		await second.call({ action: "hold", lease: G2, leaseMs: 60_000 });
		const staleAccept = await first.call({
			action: "accept",
			lease: G1,
			key: "scope:race",
			payload: '{"step":2}',
			at: 2,
		});
		const replacementAccept = await second.call({
			action: "accept",
			lease: G2,
			key: "scope:race",
			payload: '{"step":2}',
			at: 3,
		});
		const pendingG2 = await second.call({ action: "pending", lease: G2 });
		assert.equal(
			secondOpen.ok,
			false,
			`unsafe concurrent open lost g2 checkpoint: stale=${JSON.stringify(staleAccept.ok ? staleAccept.receipt : staleAccept)} replacement=${JSON.stringify(replacementAccept.ok ? replacementAccept.receipt : replacementAccept)} pendingG2=${JSON.stringify(pendingG2.ok ? pendingG2.events : pendingG2)}`,
		);
	}
	assert.equal(secondOpen.ok, false);
	assert.match(secondOpen.message, /already open/i);

	first.child.kill("SIGKILL");
	await first.child.exited;
	assert.equal(first.child.signalCode, "SIGKILL");

	const third = await spawnShardProcess(shardPath);
	const thirdOpen = await third.call({ action: "open" });
	assert.equal(thirdOpen.ok, true);
	const leftover = await third.call({ action: "leftover" });
	assert.equal(leftover.ok, true);
	assert.deepEqual(leftover.items, [{ lease: G1 }]);
	const pendingG1 = await third.call({ action: "pending", lease: G1 });
	assert.equal(pendingG1.ok, true);
	assert.deepEqual(
		pendingG1.events?.map((event) => ({
			key: event.key,
			payload: event.payload,
			generation: event.generation,
		})),
		[{ key: "scope:persisted", payload: '{"step":1}', generation: 1 }],
	);
	assert.equal((await third.call({ action: "close" })).ok, true);
});

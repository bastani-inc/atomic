import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import { EndedQueueMemory } from "../../packages/intercom/broker/client.js";
import {
	ENDED_QUEUE_OPEN_WAIT_ENV,
	ENDED_QUEUE_OPEN_WAIT_MS,
} from "../../packages/intercom/broker/durable-ended-queue.js";
import { PAUSED_RECIPIENT_TARGET } from "../../packages/intercom/broker/ended-child-wakes.js";
import {
	getBrokerEndedChildQueuePath,
	getBrokerPidPath,
	getBrokerSocketReplacementLockPath,
} from "../../packages/intercom/broker/paths.js";
import { acquireSocketReplacementLock } from "../../packages/intercom/broker/socket-replacement-lock.js";
import { sleep } from "../helpers/runtime.js";
import {
	again,
	cleanupEndedQueueRestartFixtures,
	connect,
	endedChild,
	Host,
	heldMessage,
	markEnded,
	owner,
	requestShutdown,
	resume,
	SETTLE_MS,
	type SharedOpening,
	SLOW_MODULE_LOAD_PRELOAD,
	SLOW_STORE_LOAD_MS,
	WAIT,
} from "./intercom-ended-child-queue-restart-helpers.js";

/** Real broker processes, killed and started again: their start, registration and restore are the structural cost. */
const RESTART_TEST_TIMEOUT_MS = 120_000;

afterEach(cleanupEndedQueueRestartFixtures);
afterAll(cleanupEndedQueueRestartFixtures);

test(
	"a store an older broker may have served past drops what it kept and takes a new identity: told lost once, never delivered (#5999)",
	async () => {
		for (const after of ["crashed", "exited"] as const) {
			const host = new Host();
			await host.start();
			const memory = new EndedQueueMemory();
			const { ownerSession, childName, sender, messageId } = await heldMessage(host, `older-${after}`, memory);
			if (after === "crashed") {
				await host.kill();
				// An older broker served in between and crashed: its pid file names it, not the store's holder.
				writeFileSync(getBrokerPidPath(host.agentDir), "999999");
			} else {
				await requestShutdown(host);
				await host.exited();
				// An older broker started (taking the socket lock, as every version does) and exited in order.
				const lock = await acquireSocketReplacementLock(getBrokerSocketReplacementLockPath(host.agentDir));
				lock();
			}
			await host.start();
			const senderBack = await again(host, `older-${after}-sender`, sender, { memory });
			await vi.waitFor(
				() =>
					assert.deepEqual(
						senderBack.lost.map((lost) => lost.messageId),
						[messageId],
						after,
					),
				WAIT,
			);
			const ownerBack = await owner(host, `older-${after}`, ownerSession);
			await markEnded(ownerBack, childName, "stopped");
			const continued = await resume(host, ownerBack, childName);
			await sleep(SETTLE_MS);
			assert.deepEqual(continued.received, [], `${after}: what its sender was told was lost is never delivered`);
		}
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a shared database that does not open within the broker's wait keeps the queue in memory, and a restart tells each sender once that it was lost (#5999)",
	async () => {
		const openings: ReadonlyArray<readonly [string, SharedOpening]> = [
			["late", "once it answered a registration"],
			["failed", "after a failed attempt"],
		];
		for (const [label, opening] of openings) {
			const directory = mkdtempSync(join(tmpdir(), "ecq-unopened-"));
			const host = new Host(join(directory, "shared.sqlite"), join(directory, "open-gate"));
			await host.startSlowly(opening);
			const memory = new EndedQueueMemory();
			const { ownerSession, childName, sender, messageId } = await heldMessage(host, `unopened-${label}`, memory);
			await host.kill();
			await host.start();
			const senderBack = await again(host, `unopened-${label}-sender`, sender, { memory });
			await vi.waitFor(
				() =>
					assert.deepEqual(
						senderBack.lost.map((lost) => lost.messageId),
						[messageId],
						label,
					),
				WAIT,
			);
			const ownerBack = await owner(host, `unopened-${label}`, ownerSession);
			await markEnded(ownerBack, childName, "stopped");
			const continued = await resume(host, ownerBack, childName);
			await sleep(SETTLE_MS);
			assert.deepEqual(continued.received, [], `${label}: what its sender was told was lost is never delivered`);
			assert.equal(senderBack.lost.length, 1, `${label}: told once`);
		}
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker restarted on a busy machine still takes up what the earlier broker kept when loading its store takes longer than its wait (#6126)",
	async () => {
		const host = new Host();
		await host.start();
		const memory = new EndedQueueMemory();
		const { ownerSession, childName, sender, messageId } = await heldMessage(host, "slow-load", memory);
		await host.kill();
		// The next broker waits the usual time for its store, and loading the store's code takes longer than that.
		await host.start(
			{
				[ENDED_QUEUE_OPEN_WAIT_ENV]: String(ENDED_QUEUE_OPEN_WAIT_MS),
				ATOMIC_TEST_SLOW_MODULE: "broker/sql-ended-child-queue-store.ts",
				ATOMIC_TEST_SLOW_MODULE_MS: String(SLOW_STORE_LOAD_MS),
			},
			SLOW_MODULE_LOAD_PRELOAD,
		);
		const ownerBack = await owner(host, "slow-load", ownerSession);
		const senderBack = await again(host, "slow-load-sender", sender, { memory });
		await markEnded(ownerBack, childName, "stopped");
		const continued = await resume(host, ownerBack, childName);
		await vi.waitFor(
			() =>
				assert.deepEqual(
					continued.received.map(({ message }) => message.id),
					[messageId],
				),
			WAIT,
		);
		assert.deepEqual(senderBack.lost, [], "nothing was lost");
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a broker whose writes another process's lock held off is still known as the store's holder: the next one keeps what it queued (#5999)",
	async () => {
		const host = new Host();
		await host.start();
		const memory = new EndedQueueMemory();
		const { ownerSession, childName, sender, messageId } = await heldMessage(host, "locked", memory);
		await host.kill();
		// Another process holds the store's write lock while the next broker starts: its writes fail after their wait.
		const { DatabaseSync } = await import("node:sqlite");
		const other = new DatabaseSync(getBrokerEndedChildQueuePath(host.agentDir));
		other.exec("BEGIN IMMEDIATE");
		try {
			await host.start();
			await again(host, "locked-sender", sender, { memory });
			await sleep(6_000);
		} finally {
			other.exec("ROLLBACK");
			other.close();
		}
		await host.kill();
		await host.start();
		const ownerBack = await owner(host, "locked", ownerSession);
		const senderBack = await again(host, "locked-sender", sender, { memory });
		await markEnded(ownerBack, childName, "stopped");
		const continued = await resume(host, ownerBack, childName);
		await vi.waitFor(
			() =>
				assert.deepEqual(
					continued.received.map(({ message }) => message.id),
					[messageId],
				),
			WAIT,
		);
		assert.deepEqual(senderBack.lost, [], "nothing was lost");
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a store that cannot be opened keeps the queue in memory, and a restart tells each sender once that it was lost (#5999)",
	async () => {
		const host = new Host();
		// Not a database: a directory where the file would be.
		mkdirSync(getBrokerEndedChildQueuePath(host.agentDir), { recursive: true });
		await host.start();
		const ownerBefore = await owner(host, "unopenable");
		await endedChild(host, ownerBefore, "subagent-worker-unopenable-1", "completed");
		const memory = new EndedQueueMemory();
		const senderBefore = await connect(host, "unopenable-sender", { memory });
		const messageId = randomUUID();
		const queued = await senderBefore.client.send("subagent-worker-unopenable-1", {
			text: "kept in memory",
			messageId,
			wakeEndedRecipient: true,
		});
		assert.equal(queued.queued, true, queued.reason);
		await host.kill();
		await host.start();
		const sender = await again(host, "unopenable-sender", senderBefore, { memory });
		await vi.waitFor(
			() =>
				assert.deepEqual(
					sender.lost.map((lost) => lost.messageId),
					[messageId],
				),
			WAIT,
		);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a corrupt store keeps the queue in memory, and a restart tells each sender once that it was lost (#5999)",
	async () => {
		const host = new Host();
		const path = getBrokerEndedChildQueuePath(host.agentDir);
		mkdirSync(resolve(path, ".."), { recursive: true });
		writeFileSync(path, "this is not a SQLite database, and was never one".repeat(100));
		await host.start();
		const ownerBefore = await owner(host, "corrupt");
		await endedChild(host, ownerBefore, "subagent-worker-corrupt-1", "stopped");
		const memory = new EndedQueueMemory();
		const senderBefore = await connect(host, "corrupt-sender", { memory });
		const messageId = randomUUID();
		const queued = await senderBefore.client.send("subagent-worker-corrupt-1", {
			text: "kept in memory",
			messageId,
			wakeEndedRecipient: true,
		});
		assert.equal(queued.queued, true, queued.reason);
		assert.equal(queued.target, PAUSED_RECIPIENT_TARGET);
		await host.kill();
		await host.start();
		const sender = await again(host, "corrupt-sender", senderBefore, { memory });
		await vi.waitFor(
			() =>
				assert.deepEqual(
					sender.lost.map((lost) => lost.messageId),
					[messageId],
				),
			WAIT,
		);
	},
	RESTART_TEST_TIMEOUT_MS,
);

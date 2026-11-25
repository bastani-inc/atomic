import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, test, vi } from "vitest";
import { ENDED_QUEUE_LOAD_WAIT_ENV } from "../../packages/intercom/broker/durable-ended-queue.js";
import { getBrokerEndedChildQueuePath } from "../../packages/intercom/broker/paths.js";
import { sleep } from "../helpers/runtime.js";
import {
	again,
	childReturnAddress,
	cleanupEndedQueueRestartFixtures,
	connect,
	endedChild,
	Host,
	markEnded,
	owner,
	resume,
	SETTLE_MS,
	type Session,
	STORE_OPEN_WAIT_MS,
	tempDirs,
	texts,
	untilGone,
	WAIT,
} from "./intercom-ended-child-queue-restart-helpers.js";

/** Real broker processes, killed and started again: their start, registration and restore are the structural cost. */
const RESTART_TEST_TIMEOUT_MS = 120_000;

afterEach(cleanupEndedQueueRestartFixtures);
afterAll(cleanupEndedQueueRestartFixtures);

test(
	"a send to a subagent right after a restart, from a sender with messages still kept for it, reaches it after them (#5999)",
	async () => {
		const host = new Host();
		await host.start();
		const ownerBefore = await owner(host, "order");
		const childName = "subagent-worker-order-1";
		await endedChild(host, ownerBefore, childName, "stopped");
		const senderBefore = await connect(host, "order-sender");
		// Large enough that the next broker reads them for a while after it answers its first session.
		const kept: string[] = [];
		for (let index = 0; index < 12; index++) {
			const queued = await senderBefore.client.send(childName, {
				text: `kept ${index} ${"x".repeat(1024 * 1024 - 64)}`,
				wakeEndedRecipient: true,
			});
			assert.equal(queued.queued, true, queued.reason);
			kept.push(`kept ${index}`);
		}
		await host.kill();
		await host.start();
		// Its launching session is back and continues it at once, and the sender writes to it while it starts.
		const ownerBack = await owner(host, "order", ownerBefore);
		const sender = await again(host, "order-sender", senderBefore);
		const child = await resume(host, ownerBack, childName);
		const live = await sender.client.send(childName, { text: "after them" });
		assert.equal(live.delivered, true, live.reason);
		await vi.waitFor(() => assert.equal(child.received.length, 13), WAIT);
		assert.deepEqual(
			child.received.map(({ message }) => message.content.text.split(" x")[0]),
			[...kept, "after them"],
		);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a send addressed by a resumed subagent's new session ID right after a restart reaches it after messages still kept for it (#5999)",
	async () => {
		const host = new Host();
		await host.start();
		const ownerBefore = await owner(host, "order-id");
		const childName = "subagent-worker-order-id-1";
		await endedChild(host, ownerBefore, childName, "stopped");
		const senderBefore = await connect(host, "order-id-sender");
		const kept: string[] = [];
		for (let index = 0; index < 12; index++) {
			const queued = await senderBefore.client.send(childName, {
				text: `kept ${index} ${"x".repeat(1024 * 1024 - 64)}`,
				wakeEndedRecipient: true,
			});
			assert.equal(queued.queued, true, queued.reason);
			kept.push(`kept ${index}`);
		}
		await host.kill();
		await host.start();
		const ownerBack = await owner(host, "order-id", ownerBefore);
		const sender = await again(host, "order-id-sender", senderBefore);
		const child = await resume(host, ownerBack, childName);
		const live = await sender.client.send(child.sessionId, { text: "after them by id" });
		assert.equal(live.delivered, true, live.reason);
		await vi.waitFor(() => assert.equal(child.received.length, 13), WAIT);
		assert.deepEqual(
			child.received.map(({ message }) => message.content.text.split(" x")[0]),
			[...kept, "after them by id"],
		);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a subagent's queue holds at most its 32 MiB on disk: the cap counts what each message takes there (#5999)",
	async () => {
		const host = new Host();
		await host.start();
		const ownerSession = await owner(host, "cap");
		const childName = "subagent-worker-cap-1";
		await endedChild(host, ownerSession, childName, "stopped");
		const sender = await connect(host, "cap-sender");
		let refused: string | undefined;
		for (let index = 0; index < 40 && refused === undefined; index++) {
			const result = await sender.client.send(childName, {
				text: `m${index} ${"x".repeat(1024 * 1024 - 64)}`,
				wakeEndedRecipient: true,
			});
			if (result.queued !== true) refused = result.reason;
		}
		assert.match(refused ?? "", /The message was not queued for it: \d+ MiB of messages already wait for it\./);
		const { DatabaseSync } = await import("node:sqlite");
		const store = new DatabaseSync(getBrokerEndedChildQueuePath(host.agentDir), { readOnly: true });
		try {
			const stored = store
				.prepare(
					`SELECT SUM(LENGTH(CAST(b.request_json AS BLOB)) + LENGTH(CAST(q.sender_json AS BLOB))) AS bytes
					 FROM intercom_ended_child_queue q JOIN intercom_ended_child_bodies b ON b.message_id = q.message_id`,
				)
				.get() as { bytes: number };
			assert.ok(stored.bytes <= 32 * 1024 * 1024, `${stored.bytes} bytes kept for one subagent`);
		} finally {
			store.close();
		}
	},
	RESTART_TEST_TIMEOUT_MS,
);

/** The bytes the broker's store keeps for messages for `childName`, as written there. */
async function keptFor(host: Host, childName: string): Promise<{ readonly bytes: number; readonly rows: number }> {
	const { DatabaseSync } = await import("node:sqlite");
	const store = new DatabaseSync(getBrokerEndedChildQueuePath(host.agentDir), { readOnly: true });
	try {
		const row = store
			.prepare(
				`SELECT COALESCE(SUM(LENGTH(CAST(b.request_json AS BLOB)) + LENGTH(CAST(q.sender_json AS BLOB))), 0) AS bytes,
					COUNT(*) AS rows
				 FROM intercom_ended_child_queue q JOIN intercom_ended_child_bodies b ON b.message_id = q.message_id
				 WHERE q.child_key = ?`,
			)
			.get(childName) as { bytes: number; rows: number };
		return { bytes: Number(row.bytes), rows: Number(row.rows) };
	} finally {
		store.close();
	}
}

test(
	"messages delivered while another process held the store's lock still count against their subagent's 32 MiB until their rows go, which they do once it is free",
	async () => {
		const host = new Host();
		await host.start();
		const ownerSession = await owner(host, "held");
		const childName = "subagent-worker-held-1";
		await endedChild(host, ownerSession, childName, "stopped");
		const sender = await connect(host, "held-sender");
		const fill = async (label: string, count: number): Promise<number> => {
			let queued = 0;
			for (let index = 0; index < count; index++) {
				const result = await sender.client.send(childName, {
					text: `${label}${index} ${"x".repeat(1024 * 1024 - 64)}`,
					wakeEndedRecipient: true,
				});
				if (result.queued === true) queued += 1;
			}
			return queued;
		};
		assert.equal(await fill("first-", 30), 30);
		// Another process holds the store's write lock while the subagent is continued and confirms each message: the
		// broker's deletes of their rows wait out the lock, and fail.
		const { DatabaseSync } = await import("node:sqlite");
		const other = new DatabaseSync(getBrokerEndedChildQueuePath(host.agentDir));
		other.exec("BEGIN IMMEDIATE");
		let child: Session;
		try {
			child = await resume(host, ownerSession, childName);
			await vi.waitFor(() => assert.equal(child.received.length, 30), WAIT);
			await sleep(6_000);
		} finally {
			other.exec("ROLLBACK");
			other.close();
		}
		// It is paused again; once the broker's writes go through again (its lock wait over), as much is sent again.
		await child.client.disconnect();
		await untilGone(ownerSession.client, child.sessionId);
		await markEnded(ownerSession, childName, "stopped");
		await sleep(5_000);
		await fill("second-", 30);
		const kept = await keptFor(host, childName);
		assert.ok(kept.bytes <= 33 * 1024 * 1024, `${kept.bytes} bytes kept for one subagent`);
		// The delivered rows are gone; the subagent's queue takes as much as fits again.
		await vi.waitFor(
			async () => assert.ok((await keptFor(host, childName)).rows <= 30, "only the second messages are kept"),
			WAIT,
		);
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a resumed subagent that renamed before restore finishes still receives its kept messages ahead of live sends, never misdelivering to a peer with its old name",
	async () => {
		const directory = mkdtempSync(join(tmpdir(), "ecq-rename-"));
		tempDirs.push(directory);
		const loadGate = join(directory, "load-gate");
		const host = new Host(join(directory, "shared.sqlite"), undefined, loadGate);
		await host.start();
		const ownerBefore = await owner(host, "rename");
		const childName = "subagent-worker-rename-1";
		await endedChild(host, ownerBefore, childName, "stopped");
		const senderBefore = await connect(host, "rename-sender");
		const keptAskId = randomUUID();
		const first = await senderBefore.client.send(childName, {
			text: "kept-before-rename-0",
			wakeEndedRecipient: true,
		});
		const second = await senderBefore.client.send(childName, {
			text: "kept-before-rename-ask",
			messageId: keptAskId,
			expectsReply: true,
			wakeEndedRecipient: true,
		});
		assert.equal(first.queued, true, first.reason);
		assert.equal(second.queued, true, second.reason);

		await host.kill();
		// Park `store.load()` on the restarted broker so the subagent registers, renames, and a colliding peer claims
		// the vacated name deterministically before `restoreEndedQueue` runs.
		writeFileSync(loadGate, "closed");
		try {
			await host.start({ [ENDED_QUEUE_LOAD_WAIT_ENV]: String(STORE_OPEN_WAIT_MS) });
			await vi.waitFor(() => assert.equal(existsSync(`${loadGate}.parked`), true, "store.load() parked"), WAIT);

			const ownerBack = await owner(host, "rename", ownerBefore);
			const sender = await again(host, "rename-sender", senderBefore);
			const child = await resume(host, ownerBack, childName);
			await child.client.updatePresenceAcked({ name: "renamed-worker-1" });
			const collidingPeer = await connect(host, childName);

			// Start a live send to the renamed subagent (must wait behind kept rows), then send to the non-subagent
			// colliding peer (must deliver immediately while restore is still parked).
			const liveToRenamed = sender.client.send("renamed-worker-1", { text: "live-after-rename" });
			const liveToColliding = await sender.client.send(childName, { text: "for-colliding-peer" });
			assert.equal(liveToColliding.delivered, true, liveToColliding.reason);
			await vi.waitFor(() => assert.deepEqual(texts(collidingPeer), ["for-colliding-peer"]), WAIT);
			assert.deepEqual(texts(child), [], "live send to renamed subagent waits while restore is loading");

			// Release `store.load()` so `restoreEndedQueue` dispatches kept rows by session identity, then releases held live sends.
			writeFileSync(loadGate, "open");
			const liveResult = await liveToRenamed;
			assert.equal(liveResult.delivered, true, liveResult.reason);
			await vi.waitFor(() => assert.equal(child.received.length, 3), WAIT);
			assert.deepEqual(texts(child), ["kept-before-rename-0", "kept-before-rename-ask", "live-after-rename"]);
			assert.equal(child.received[0]!.message.heldWhilePaused, true);
			assert.equal(child.received[1]!.message.heldWhilePaused, true);
			assert.equal(child.received[1]!.message.id, keptAskId);

			// The renamed subagent can reply to the restored ask; the colliding peer never received any kept row.
			const reply = await child.client.send(child.received[1]!.from.id, {
				text: "renamed-ask-reply",
				replyTo: keptAskId,
				requirePendingReply: true,
			});
			assert.equal(reply.delivered, true, reply.reason);
			await vi.waitFor(
				() =>
					assert.deepEqual(
						sender.received
							.filter(({ message }) => message.replyTo === keptAskId)
							.map(({ message }) => message.content.text),
						["renamed-ask-reply"],
					),
				WAIT,
			);
			await sleep(SETTLE_MS);
			assert.deepEqual(texts(collidingPeer), ["for-colliding-peer"], "colliding peer must never receive kept rows");
			assert.deepEqual(
				sender.received.filter(({ message }) => message.replyError !== undefined),
				[],
				"no kept row may fail after subagent rename",
			);
		} finally {
			writeFileSync(loadGate, "open");
		}
	},
	RESTART_TEST_TIMEOUT_MS,
);

test(
	"a supervisor-channel vertical-bypass reply across group isolation waits behind kept rows during restore across all addressing forms",
	async () => {
		for (const withReachPolicy of [false, true] as const) {
			const label = withReachPolicy ? "vb-reach" : "vb-open";
			const isolatedGroup = `sub-isolated-${label}`;
			const directory = mkdtempSync(join(tmpdir(), `ecq-${label}-`));
			tempDirs.push(directory);
			const loadGate = join(directory, "load-gate");
			const host = new Host(join(directory, "shared.sqlite"), undefined, loadGate);
			await host.start();

			const ownerReach = withReachPolicy ? () => ({ home: "default", reachable: ["default"] }) : undefined;
			const ownerToken = randomUUID();
			const ownerBefore = await connect(host, `${label}-owner`, {
				ownerToken,
				group: "default",
				...(ownerReach === undefined ? {} : { reach: ownerReach }),
			});
			const childName = `subagent-worker-${label}-1`;
			const childBefore = await connect(host, childName, {
				returnAddress: childReturnAddress(childName),
				supervisor: await ownerBefore.client.authorizeSupervisorChild(childName),
				group: isolatedGroup,
			});
			const childBeforeId = childBefore.sessionId;
			await childBefore.client.disconnect();
			const siblingBefore = await connect(host, `${label}-sibling`, { group: isolatedGroup });
			await untilGone(siblingBefore.client, childBeforeId);
			await ownerBefore.client.markEndedChildren([
				{
					childName,
					childId: `${childName}:0`,
					group: isolatedGroup,
					outcome: "stopped",
					aliases: [],
					messages: "hold",
				},
			]);

			const kept0 = await siblingBefore.client.send(childName, { text: "kept-vb-0", wakeEndedRecipient: true });
			const kept1 = await siblingBefore.client.send(childName, { text: "kept-vb-1", wakeEndedRecipient: true });
			assert.equal(kept0.queued, true, kept0.reason);
			assert.equal(kept1.queued, true, kept1.reason);

			await host.kill();
			writeFileSync(loadGate, "closed");
			try {
				await host.start({ [ENDED_QUEUE_LOAD_WAIT_ENV]: String(STORE_OPEN_WAIT_MS) });
				await vi.waitFor(
					() => assert.equal(existsSync(`${loadGate}.parked`), true, `${label}: store.load() parked`),
					WAIT,
				);

				const ownerBack = await again(host, `${label}-owner`, ownerBefore, {
					ownerToken,
					group: "default",
					...(ownerReach === undefined ? {} : { reach: ownerReach }),
				});
				const sameGroupPeer = await connect(host, `${label}-peer`, { group: "default" });
				const child = await connect(host, childName, {
					returnAddress: childReturnAddress(childName),
					supervisor: await ownerBack.client.authorizeSupervisorChild(childName),
					group: isolatedGroup,
				});
				const childTargetName = withReachPolicy ? childName : `renamed-${label}-1`;
				if (!withReachPolicy) await child.client.updatePresenceAcked({ name: childTargetName });

				// Child sends a one-way `supervisor_send` (`expectsReply` omitted -> no pendingQuestions entry; ONLY
				// supervisorChannel.record — plus returnPaths when ownerReach is undefined!).
				const crossingId = randomUUID();
				const crossing = await child.client.sendToSupervisor(ownerBack.sessionId, {
					text: "progress update across groups",
					messageId: crossingId,
				});
				assert.equal(crossing.delivered, true, crossing.reason);

				// Supervisor sends vertical-bypass replies addressed by exact ID, name (original or renamed), 8-hex
				// prefix, and host session ID while `store.load()` is still parked.
				const replyById = ownerBack.client.send(child.sessionId, { text: "vb-by-id", replyTo: crossingId });
				const replyByName = ownerBack.client.send(childTargetName, { text: "vb-by-name", replyTo: crossingId });
				const replyByPrefix = ownerBack.client.send(child.sessionId.slice(0, 8), {
					text: "vb-by-prefix",
					replyTo: crossingId,
				});
				const replyByHostId = ownerBack.client.send(child.returnAddress, {
					text: "vb-by-host-id",
					replyTo: crossingId,
				});

				// Causal barrier: a send to a non-subagent peer in the supervisor's group delivers immediately without
				// waiting for `loadGate`.
				const peerSend = await ownerBack.client.send(sameGroupPeer.sessionId, { text: "peer-unblocked" });
				assert.equal(peerSend.delivered, true, peerSend.reason);
				await vi.waitFor(() => assert.deepEqual(texts(sameGroupPeer), ["peer-unblocked"]), WAIT);
				assert.deepEqual(
					texts(child),
					[],
					`${label}: vertical-bypass replies must wait behind kept rows while restore is loading`,
				);

				writeFileSync(loadGate, "open");
				const replyResults = await Promise.all([replyById, replyByName, replyByPrefix, replyByHostId]);
				for (const result of replyResults) assert.equal(result.delivered, true, result.reason);

				await vi.waitFor(() => assert.equal(child.received.length, 6), WAIT);
				assert.deepEqual(
					texts(child),
					["kept-vb-0", "kept-vb-1", "vb-by-id", "vb-by-name", "vb-by-prefix", "vb-by-host-id"],
					`${label}: kept rows must precede all vertical-bypass replies in FIFO order`,
				);
			} finally {
				writeFileSync(loadGate, "open");
			}
		}
	},
	RESTART_TEST_TIMEOUT_MS,
);

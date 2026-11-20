import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, test, vi } from "vitest";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.js";
import { sleep } from "../helpers/runtime.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const brokerFixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "ended-child-wake-")));
brokerFixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { isSubagentRecipientEndedError } = await import("../../packages/intercom/broker/recipient-gone-errors.js");
const { ENDED_CHILD_WAKE_CHAIN_MAX, PAUSED_LIVE_RECIPIENT_TARGET, PAUSED_RECIPIENT_TARGET, RESUMING_RECIPIENT_TARGET } =
	await import("../../packages/intercom/broker/ended-child-wakes.js");

type Client = InstanceType<typeof IntercomClient>;

/** The Intercom client of main before #5999, which never asks to wake an ended recipient. */
interface MainClient extends EventEmitter {
	connect(session: object): Promise<void>;
	send(
		to: string,
		options: { text: string; expectsReply?: boolean },
	): Promise<{ id: string; delivered: boolean; queued?: boolean; target?: string; reason?: string }>;
	disconnect(): Promise<void>;
}
const { IntercomClient: MainIntercomClient } = (await import(
	join(repoRoot, "test/fixtures/intercom-main-pre-5999/broker/client.ts")
)) as { IntercomClient: new (returnAddress: string, options?: { acknowledgesReceipt?: true }) => MainClient };
type Notice = import("../../packages/intercom/broker/client.js").EndedChildWakeNotice;
interface Received {
	readonly from: { readonly id: string; readonly name?: string };
	readonly message: {
		readonly id: string;
		readonly replyTo?: string;
		readonly replyError?: string;
		readonly expectsReply?: boolean;
		readonly heldWhilePaused?: true;
		readonly content: { readonly text: string };
	};
}

/** A real broker process: these tests cross its socket, its registration and its departure handling. */
const REAL_BROKER_TEST_TIMEOUT_MS = 60_000;
const BROKER_START_WAIT_MS = 90_000;
const BROKER_START_HOOK_TIMEOUT_MS = BROKER_START_WAIT_MS + 5_000;
/** Long enough for a frame another socket wrote to reach the broker and be applied. */
const SETTLE_MS = 300;
/** A send to a subagent being resumed is answered at once, not after a hold. */
const ANSWERED_AT_ONCE_MS = 5_000;
const WAIT = { timeout: 10_000, interval: 20 } as const;

let broker: ChildProcess | undefined;

async function connect(
	name: string,
	options: {
		ownerToken?: string;
		supervisor?: { capability: string; supervisorSessionId: string };
		returnAddress?: string;
		group?: string;
	} = {},
): Promise<{ client: Client; received: Received[]; wakes: Notice[] }> {
	const client = new IntercomClient(options.returnAddress ?? randomUUID());
	client.on("error", () => {});
	const received: Received[] = [];
	const wakes: Notice[] = [];
	client.on("message", (from: Received["from"], message: Received["message"]) => received.push({ from, message }));
	client.on("ended_child_wake", (notice: Notice) => wakes.push(notice));
	const group = options.group ?? "default";
	await client.connect(
		{
			name,
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group,
			groups: [group],
		},
		options.supervisor,
		options.ownerToken,
		undefined,
		group,
	);
	brokerFixture.onCleanup(() => client.disconnect().catch(() => undefined));
	return { client, received, wakes };
}

async function untilGone(observer: Client, sessionId: string | null): Promise<void> {
	assert.ok(sessionId);
	await vi.waitFor(
		async () =>
			assert.equal(
				(await observer.listSessions()).some((session) => session.id === sessionId),
				false,
			),
		WAIT,
	);
}

/** An owner with one subagent whose run ended (`outcome`) and whose session is gone; `wake`: the owner resumes it. */
async function endedChild(
	label: string,
	outcome: "completed" | "failed" | "stopped" | "cancelled" = "completed",
	wake = true,
	ownerSession?: { readonly returnAddress: string; readonly ownerToken: string },
) {
	const owner = await connect(`${label}-owner`, ownerSession ?? { ownerToken: randomUUID() });
	const childName = `subagent-worker-${label}-1`;
	const child = await connect(childName, { supervisor: await owner.client.authorizeSupervisorChild(childName) });
	const childIntercomId = child.client.sessionId;
	await child.client.disconnect();
	await untilGone(owner.client, childIntercomId);
	await owner.client.markEndedChildren([
		{
			childName,
			childId: `${label}:0`,
			outcome,
			aliases: [],
			...(wake && outcome !== "cancelled"
				? { messages: outcome === "stopped" ? ("hold" as const) : ("wake" as const) }
				: {}),
		},
	]);
	return { owner, childName };
}

/** The owner resumes the child: it registers again under the owner's authorization, as a resumed subagent does. */
async function resume(owner: Client, childName: string) {
	return connect(childName, { supervisor: await owner.authorizeSupervisorChild(childName) });
}

beforeAll(async () => {
	const extensionDir = join(repoRoot, "packages/intercom");
	broker = spawn(process.execPath, [getJitiCliPath(extensionDir), join(extensionDir, "broker/broker.ts")], {
		env: { ...process.env, ATOMIC_CODING_AGENT_DIR: brokerFixture.agentDir },
		stdio: "ignore",
	});
	brokerFixture.trackBroker(broker);
	await brokerFixture.holdSession(getBrokerSocketPath(process.platform, brokerFixture.agentDir), BROKER_START_WAIT_MS);
}, BROKER_START_HOOK_TIMEOUT_MS);
afterAll(() => brokerFixture.cleanup());

test(
	"a sibling's send to a completed subagent resumes it once, and the subagent receives the message (#5999)",
	async () => {
		const { owner, childName } = await endedChild("sibling");
		const sibling = await connect("sibling-sender");
		assert.equal(sibling.client.wakesEndedChildren, true, "this broker wakes ended children");

		const startedAt = performance.now();
		const first = await sibling.client.send(childName, { text: "one more thing", wakeEndedRecipient: true });
		assert.ok(performance.now() - startedAt < ANSWERED_AT_ONCE_MS, "the send returns at once");
		assert.equal(first.delivered, false);
		assert.equal(first.queued, true, first.reason);
		assert.equal(first.target, RESUMING_RECIPIENT_TARGET);
		await vi.waitFor(() => assert.equal(owner.wakes.length, 1), WAIT);
		const [wake] = owner.wakes;
		assert.equal(wake!.childName, childName);
		assert.equal(wake!.childId, "sibling:0");
		assert.equal(wake!.depth, 1);
		assert.deepEqual(wake!.from, { id: sibling.client.sessionId, name: "sibling-sender" });

		assert.equal(owner.client.answerEndedChildWake(childName, wake!.wakeId, true), true);
		const second = await sibling.client.send(childName, { text: "and another", wakeEndedRecipient: true });
		assert.equal(second.queued, true, second.reason);
		assert.equal(second.target, RESUMING_RECIPIENT_TARGET);

		const resumed = await resume(owner.client, childName);
		await vi.waitFor(() => assert.equal(resumed.received.length, 2), WAIT);
		await sleep(SETTLE_MS);
		assert.deepEqual(
			resumed.received.map(({ from, message }) => ({ from: from.name, text: message.content.text })),
			[
				{ from: "sibling-sender", text: "one more thing" },
				{ from: "sibling-sender", text: "and another" },
			],
			"each message reaches the resumed subagent once, in order",
		);
		assert.equal(owner.wakes.length, 1, "one wake for both messages");
		assert.equal((await owner.client.brokerStatus())?.heldSends, 0);

		const live = await sibling.client.send(childName, { text: "now that you are back", wakeEndedRecipient: true });
		assert.equal(live.delivered, true, "a live subagent gets the message as any message, without a wake");
		assert.equal(owner.wakes.length, 1);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"an ask to a completed subagent returns at once and its reply arrives later, as any async reply (#5999)",
	async () => {
		const { owner, childName } = await endedChild("asked");
		const asker = await connect("asked-asker");
		const askId = randomUUID();
		const asked = await asker.client.send(childName, {
			text: "what did you find?",
			messageId: askId,
			expectsReply: true,
			wakeEndedRecipient: true,
		});
		assert.equal(asked.queued, true, asked.reason);
		assert.equal(asked.target, RESUMING_RECIPIENT_TARGET);
		await vi.waitFor(() => assert.equal(owner.wakes.length, 1), WAIT);
		owner.client.answerEndedChildWake(childName, owner.wakes[0]!.wakeId, true);

		const resumed = await resume(owner.client, childName);
		await vi.waitFor(() => assert.equal(resumed.received.length, 1), WAIT);
		const question = resumed.received[0]!;
		assert.equal(question.message.id, askId);
		assert.equal(question.message.expectsReply, true);

		const replied = await resumed.client.send(question.from.id, {
			text: "three bugs",
			replyTo: askId,
			requirePendingReply: true,
		});
		assert.equal(replied.delivered, true, replied.reason);
		await vi.waitFor(
			() =>
				assert.deepEqual(
					asker.received.map(({ message }) => [message.replyTo, message.content.text]),
					[[askId, "three bugs"]],
				),
			WAIT,
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a killed subagent, or one whose owner does not resume it for messages, keeps today's refusal (#5999)",
	async () => {
		const killed = await endedChild("killed", "cancelled");
		// Even an owner that offered it for a cancelled child does not get it woken.
		await killed.owner.client.markEndedChildren([
			{ childName: killed.childName, childId: "killed:0", outcome: "cancelled", aliases: [], messages: "wake" },
		]);
		const sender = await connect("killed-sender");
		const refused = await sender.client.send(killed.childName, { text: "hello", wakeEndedRecipient: true });
		assert.ok(refused.error !== undefined && isSubagentRecipientEndedError(refused.error), refused.reason);
		assert.equal(refused.error.code, "recipient_cancelled");
		assert.equal(
			refused.reason,
			`Subagent "${killed.childName}" was cancelled for good and has no live session (recipient_cancelled). It cannot be resumed; launch a fresh subagent if its work is still needed.`,
		);

		const older = await endedChild("older-owner", "completed", false);
		const unwoken = await sender.client.send(older.childName, { text: "hello", wakeEndedRecipient: true });
		assert.ok(unwoken.error !== undefined && isSubagentRecipientEndedError(unwoken.error), unwoken.reason);
		assert.equal(unwoken.error.code, "recipient_completed");

		const wakeable = await endedChild("unflagged");
		const plain = await sender.client.send(wakeable.childName, { text: "hello" });
		assert.ok(plain.error !== undefined && isSubagentRecipientEndedError(plain.error), plain.reason);
		assert.equal(plain.error.code, "recipient_completed", "a send that does not ask to wake gets today's answer");

		await sleep(SETTLE_MS);
		assert.deepEqual([...killed.owner.wakes, ...older.owner.wakes, ...wakeable.owner.wakes], []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a sender outside the subagent's group finds no session and wakes nothing (#5999)",
	async () => {
		const { owner, childName } = await endedChild("hidden");
		const outsider = await connect("hidden-outsider", { group: "elsewhere" });
		const hidden = await outsider.client.send(childName, { text: "hello", wakeEndedRecipient: true });
		assert.equal(hidden.delivered, false);
		assert.equal(hidden.queued, undefined);
		assert.equal(hidden.reason, "Session not found");
		await sleep(SETTLE_MS);
		assert.deepEqual(owner.wakes, []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a paused subagent is not resumed by a message: it is queued and reaches it after it is continued (#5999)",
	async () => {
		const { owner, childName } = await endedChild("paused", "stopped");
		const sender = await connect("paused-sender");
		const startedAt = performance.now();
		const queued = await sender.client.send(childName, { text: "when you are back", wakeEndedRecipient: true });
		assert.ok(performance.now() - startedAt < ANSWERED_AT_ONCE_MS, "the send returns at once");
		assert.equal(queued.queued, true, queued.reason);
		assert.equal(queued.target, PAUSED_RECIPIENT_TARGET, "the sender is told the subagent is paused");
		await sleep(SETTLE_MS);
		assert.deepEqual(owner.wakes, [], "nothing asks its owner to resume it");

		const plain = await sender.client.send(childName, { text: "a pattern copy" });
		assert.ok(plain.error !== undefined && isSubagentRecipientEndedError(plain.error), plain.reason);
		assert.equal(plain.error.code, "recipient_stopped", "a send that does not ask to wake gets today's answer");

		// Its owner continues it: it registers again, and the kept message reaches it, marked to follow what continues it.
		const continued = await resume(owner.client, childName);
		await vi.waitFor(() => assert.equal(continued.received.length, 1), WAIT);
		assert.equal(continued.received[0]!.message.content.text, "when you are back");
		assert.equal(continued.received[0]!.message.heldWhilePaused, true);
		assert.deepEqual(owner.wakes, []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a subagent its owner is already resuming takes the message without another wake, and one it gives up as gone keeps that answer (#5999)",
	async () => {
		const { owner, childName } = await endedChild("restoring");
		const sender = await connect("restoring-sender");
		// The owner resumes it itself: it holds sends to it while it starts.
		const authorization = await owner.client.authorizeSupervisorChild(childName);
		await owner.client.reserveRestoringRecipient(authorization.capability, { holdMs: 60_000 });
		const during = await sender.client.send(childName, { text: "while you start", wakeEndedRecipient: true });
		assert.equal(during.queued, true, during.reason);
		assert.equal(during.target, RESUMING_RECIPIENT_TARGET);
		await sleep(SETTLE_MS);
		assert.deepEqual(owner.wakes, [], "the owner is already resuming it: nothing asks it again");

		// Its start fails and the owner reports it gone: what was queued fails, and later senders get the gone answer.
		await owner.client.releaseRestoringRecipient(authorization.capability, { gone: "its session could not be read" });
		await vi.waitFor(() => assert.equal(sender.received.length, 1), WAIT);
		const goneReason = `Subagent \`${childName}\` did not survive the restart and is gone: its session could not be read. The message was not sent; launch a fresh subagent if its work is still needed.`;
		assert.equal(sender.received[0]!.message.replyTo, during.id);
		assert.equal(sender.received[0]!.message.replyError, goneReason);
		const after = await sender.client.send(childName, { text: "are you there?", wakeEndedRecipient: true });
		assert.equal(after.delivered, false);
		assert.equal(after.queued, undefined);
		assert.equal(after.reason, goneReason, "main's answer for a subagent its owner reported gone");
		assert.deepEqual(owner.wakes, []);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a live subagent whose user paused its turn keeps the message: a current sender is told it is paused, an older one gets delivered as before (#5999)",
	async () => {
		const sender = await connect("live-paused-sender");
		const older = new MainIntercomClient(randomUUID(), { acknowledgesReceipt: true });
		older.on("error", () => {});
		brokerFixture.onCleanup(() => older.disconnect().catch(() => undefined));
		await older.connect({
			name: "live-paused-older-sender",
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		});
		const child = new IntercomClient(randomUUID(), { acknowledgesReceipt: true });
		child.on("error", () => {});
		brokerFixture.onCleanup(() => child.disconnect().catch(() => undefined));
		let paused = true;
		child.on("message", (_from: Received["from"], message: Received["message"]) =>
			child.acknowledgeReceived(message.id, paused),
		);
		await child.connect(
			{
				name: "subagent-worker-live-paused-1",
				model: "test-model",
				cwd: repoRoot,
				pid: process.pid,
				status: "idle",
				startedAt: Date.now(),
				lastActivity: Date.now(),
				group: "default",
				groups: ["default"],
			},
			undefined,
			undefined,
			undefined,
			"default",
		);
		const kept = await sender.client.send("subagent-worker-live-paused-1", {
			text: "when you are back",
			wakeEndedRecipient: true,
		});
		assert.equal(kept.delivered, false);
		assert.equal(kept.queued, true, kept.reason);
		assert.equal(kept.target, PAUSED_LIVE_RECIPIENT_TARGET);

		// A client of main never asked to wake an ended recipient: it is answered as main's broker answers it.
		const olderSend = await older.send("subagent-worker-live-paused-1", { text: "from an older session" });
		assert.equal(olderSend.delivered, true, olderSend.reason);
		assert.equal(olderSend.queued, undefined);
		const olderAsk = await older.send("subagent-worker-live-paused-1", { text: "an older ask", expectsReply: true });
		assert.equal(olderAsk.delivered, true, "its ask stays open, as on main");
		assert.equal(olderAsk.queued, undefined);

		paused = false;
		const delivered = await sender.client.send("subagent-worker-live-paused-1", {
			text: "now",
			wakeEndedRecipient: true,
		});
		assert.equal(delivered.delivered, true, "once it is continued, messages are delivered as before");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a paused subagent's message fails once when the session that launched it ends, and waits when that session comes back (#5999)",
	async () => {
		const closing = await endedChild("paused-owner-ends", "stopped");
		const sender = await connect("paused-owner-sender");
		const queued = await sender.client.send(closing.childName, { text: "for later", wakeEndedRecipient: true });
		assert.equal(queued.target, PAUSED_RECIPIENT_TARGET, queued.reason);
		await closing.owner.client.disconnect();
		await vi.waitFor(() => assert.equal(sender.received.length, 1), WAIT);
		assert.equal(sender.received[0]!.message.replyTo, queued.id);
		assert.equal(
			sender.received[0]!.message.replyError,
			`Subagent "${closing.childName}" is paused and the session that launched it ended, so nothing can continue it now. The message was not delivered; send it again if it is still needed.`,
		);

		// A session whose connection only dropped, and that is back as the same Atomic session, keeps it paused with the
		// message still waiting, and delivers it when it continues the subagent.
		const ownerSession = { returnAddress: randomUUID(), ownerToken: randomUUID() };
		const away = await endedChild("paused-owner-back", "stopped", true, ownerSession);
		const later = await sender.client.send(away.childName, { text: "still for later", wakeEndedRecipient: true });
		assert.equal(later.target, PAUSED_RECIPIENT_TARGET, later.reason);
		const awayId = away.owner.client.sessionId;
		await away.owner.client.disconnect({ resumable: true });
		await untilGone(sender.client, awayId);
		const back = await connect("paused-owner-back-owner", ownerSession);
		await back.client.markEndedChildren([
			{
				childName: away.childName,
				childId: "paused-owner-back:0",
				outcome: "stopped",
				aliases: [],
				messages: "hold",
			},
		]);
		const continued = await resume(back.client, away.childName);
		await vi.waitFor(() => assert.equal(continued.received.length, 1), WAIT);
		assert.equal(continued.received[0]!.message.content.text, "still for later");
		await sleep(SETTLE_MS);
		assert.equal(sender.received.length, 1, "no failure for the message that waited");
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"two subagents messaging each other cannot wake each other without bound (#5999)",
	async () => {
		const owner = await connect("loop-owner", { ownerToken: randomUUID() });
		const names = ["subagent-worker-loop-a", "subagent-worker-loop-b"] as const;
		const mark = (childName: string) =>
			owner.client.markEndedChildren([
				{ childName, childId: `${childName}:0`, outcome: "completed", aliases: [], messages: "wake" },
			]);
		// A runs; B has finished.
		let running = await resume(owner.client, names[0]);
		const b = await resume(owner.client, names[1]);
		const bId = b.client.sessionId;
		await b.client.disconnect();
		await untilGone(owner.client, bId);
		await mark(names[1]);

		const depths: number[] = [];
		let turn = 0;
		for (;;) {
			const target = names[(turn + 1) % 2]!;
			const sent = await running.client.send(target, { text: `wake ${turn}`, wakeEndedRecipient: true });
			if (sent.queued !== true) {
				assert.ok(sent.error !== undefined && isSubagentRecipientEndedError(sent.error), sent.reason);
				assert.match(sent.reason ?? "", /was not resumed for this message: the message came from a chain/);
				break;
			}
			await vi.waitFor(() => assert.equal(owner.wakes.length, depths.length + 1), WAIT);
			const wake = owner.wakes.at(-1)!;
			depths.push(wake.depth);
			owner.client.answerEndedChildWake(target, wake.wakeId, true);
			// The woken one runs and gets the message; the sender finishes.
			const woken = await resume(owner.client, target);
			await vi.waitFor(() => assert.equal(woken.received.length, 1), WAIT);
			const finishedId = running.client.sessionId;
			const finishedName = names[turn % 2]!;
			await running.client.disconnect();
			await untilGone(owner.client, finishedId);
			await mark(finishedName);
			running = woken;
			turn += 1;
			assert.ok(turn <= ENDED_CHILD_WAKE_CHAIN_MAX, "the chain stops at its bound");
		}
		assert.deepEqual(
			depths,
			Array.from({ length: ENDED_CHILD_WAKE_CHAIN_MAX }, (_, index) => index + 1),
			"each wake by a woken sender is one further down the chain, until the bound refuses one",
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"a subagent its owner does not resume after all fails the queued ask, and tells the sender why (#5999)",
	async () => {
		const { owner, childName } = await endedChild("declined");
		const asker = await connect("declined-asker");
		const askId = randomUUID();
		const asked = await asker.client.send(childName, {
			text: "still there?",
			messageId: askId,
			expectsReply: true,
			wakeEndedRecipient: true,
		});
		assert.equal(asked.queued, true, asked.reason);
		await vi.waitFor(() => assert.equal(owner.wakes.length, 1), WAIT);
		owner.client.answerEndedChildWake(childName, owner.wakes[0]!.wakeId, false, "it was cancelled for good");
		await vi.waitFor(() => assert.equal(asker.received.length, 1), WAIT);
		const failure = asker.received[0]!;
		assert.equal(failure.from.name, childName, "the failure comes from the subagent the ask was for");
		assert.equal(failure.message.replyTo, askId);
		assert.equal(
			failure.message.replyError,
			`Subagent "${childName}" was not resumed for this message: it was cancelled for good. The message was not delivered.`,
		);
		assert.equal((await owner.client.brokerStatus())?.heldSends, 0);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

test(
	"what was queued for a subagent fails when the session that would resume it ends for good (#5999)",
	async () => {
		const { owner, childName } = await endedChild("orphaned");
		const sender = await connect("orphaned-sender");
		const sent = await sender.client.send(childName, { text: "hello", wakeEndedRecipient: true });
		assert.equal(sent.queued, true, sent.reason);
		await vi.waitFor(() => assert.equal(owner.wakes.length, 1), WAIT);
		// It says goodbye (not resumable): nobody can resume the subagent any more. One that only went away is waited for.
		await owner.client.disconnect();
		await vi.waitFor(() => assert.equal(sender.received.length, 1), WAIT);
		assert.equal(sender.received[0]!.message.replyTo, sent.id);
		assert.match(
			sender.received[0]!.message.replyError ?? "",
			/the session that launched it ended before it was resumed/,
		);
	},
	REAL_BROKER_TEST_TIMEOUT_MS,
);

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, test, vi } from "vitest";
import {
	KNOWN_SESSION_RETENTION_MS,
	OUTBOX_BACKUP_POLL_INTERVAL_MS,
	OUTBOX_CLAIM_STALE_AFTER_MS,
	OUTBOX_EXPIRED_REASON,
	OUTBOX_TARGET_MAX_BYTES,
	OUTBOX_TARGET_MAX_ROWS,
} from "../../packages/intercom/broker/multinode-state-store.js";
import { UNCERTAIN_RECEIPT_REASON } from "../../packages/intercom/broker/recipient-receipts.js";
import { releasedReservationKey } from "../../packages/intercom/broker/released-children.js";
import { RESTORING_RECIPIENT_HOLD_MS } from "../../packages/intercom/broker/restoring-recipients.js";
import { type BrokerConnectedSession, deliveryTargetIdentity } from "../../packages/intercom/broker/send-handler.js";
import type { BrokerOutboundFrame } from "../../packages/intercom/broker/socket-writes.js";
import { normalizeGroup } from "../../packages/intercom/group.js";
import { TERMINAL_CHILD_ASK_REFUSAL } from "../../packages/intercom/recipient-purpose.js";
import {
	HELD_SEND_GRACE_MS,
	RECIPIENT_RECEIPT_TIMEOUT_MS,
	RECIPIENT_SAVE_MAX_WAIT_MS,
	RECIPIENT_SAVING_REPORT_INTERVAL_MS,
	SEND_RESPONSE_TIMEOUT_MS,
} from "../../packages/intercom/retry-policy.js";
import {
	advance,
	advanceUntil,
	BUS_POLL_INTERVAL_MS,
	CROSS_NODE_WAIT_MS,
	cluster,
	framesOf,
	message,
	messageFrames,
	type Node,
	outcomeOf,
	reasonOf,
	runCleanups,
	sendAndSettle,
	settleFileIo,
	startConnectionTracking,
	stopConnectionTracking,
	waitFor,
	waitOffline,
	whenWritten,
} from "./intercom-multinode-broker-routing-helpers.js";

afterEach(runCleanups);
beforeEach(startConnectionTracking);
afterEach(stopConnectionTracking);

/** A write stall on the sender's shared connection: longer than the sender's wait past the receipt wait. */
const OUTBOX_READ_STALL_MS = 5_000;
const SLOW_HOLD_TEST_TIMEOUT_MS = 4 * (RECIPIENT_RECEIPT_TIMEOUT_MS + OUTBOX_READ_STALL_MS);

test(
	"a remote recipient still saving keeps its sender waiting even when the hold check's outbox read is slow (#3983)",
	async () => {
		const [a, b] = await cluster();
		const sender = await a!.connect("sender");
		const recipient = await b!.connect("recipient");
		const sent = message();
		const sentAt = Date.now();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		// The recipient's save is held while it reports progress, as a pooled stage's journal commit can wait.
		const saving = setInterval(() => b!.router.saving(recipient, sent.id), RECIPIENT_SAVING_REPORT_INTERVAL_MS);
		b!.router.saving(recipient, sent.id);
		// From now on the sender's broker reads the outbox behind a write stall on its shared connection.
		const outbox = a!.opened.state.outbox;
		const read = outbox.read.bind(outbox);
		const spy = vi.spyOn(outbox, "read").mockImplementation(async (messageId) => {
			await new Promise((resolveStall) => setTimeout(resolveStall, OUTBOX_READ_STALL_MS));
			return read(messageId);
		});
		try {
			const held = await waitFor(
				() =>
					framesOf(sender).find((frame) => frame.type === "send_held" && frame.messageId === sent.id) === undefined
						? undefined
						: Date.now(),
				SEND_RESPONSE_TIMEOUT_MS + OUTBOX_READ_STALL_MS,
			);
			// The sender's client gives up `SEND_RESPONSE_TIMEOUT_MS` after its send unless a hold reaches it first.
			assert.ok(
				held - sentAt < SEND_RESPONSE_TIMEOUT_MS,
				`the sender was told to keep waiting only ${held - sentAt} ms after its send`,
			);
			assert.equal(outcomeOf(sender, sent.id), undefined, "no outcome while the recipient is still saving");
			// The recipient keeps reporting through another receipt wait, then saves.
			await new Promise((resolveSave) => setTimeout(resolveSave, RECIPIENT_RECEIPT_TIMEOUT_MS));
			clearInterval(saving);
			b!.router.received(recipient, sent.id);
			const outcome = await waitFor(() => outcomeOf(sender, sent.id), CROSS_NODE_WAIT_MS + OUTBOX_READ_STALL_MS);
			assert.equal(outcome.type, "delivered", JSON.stringify(outcome));
			assert.equal(
				framesOf(sender).filter((frame) => frame.type === "delivery_failed" && frame.messageId === sent.id).length,
				0,
			);
			assert.equal(messageFrames(recipient, sent.id).length, 1, "delivered once");
		} finally {
			clearInterval(saving);
			spy.mockRestore();
		}
	},
	SLOW_HOLD_TEST_TIMEOUT_MS,
);

test(
	"a send whose hold check meets a permanently stalled store keeps one read in flight and ends uncertain within the save cap (#3983)",
	async () => {
		const [a, b] = await cluster();
		const sender = await a!.connect("sender");
		const recipient = await b!.connect("recipient");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
		const outbox = a!.opened.state.outbox;
		const read = outbox.read.bind(outbox);
		let stalled = false;
		let inFlight = 0;
		let mostInFlight = 0;
		const spy = vi.spyOn(outbox, "read").mockImplementation(async (messageId) => {
			if (!stalled) return read(messageId);
			inFlight += 1;
			mostInFlight = Math.max(mostInFlight, inFlight);
			return new Promise<never>(() => {});
		});
		try {
			const sent = message();
			const sentAt = Date.now();
			a!.send(sender, "recipient", sent);
			await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
			b!.router.saving(recipient, sent.id);
			stalled = true;
			await advance(RECIPIENT_SAVE_MAX_WAIT_MS + RECIPIENT_RECEIPT_TIMEOUT_MS);
			const outcome = outcomeOf(sender, sent.id);
			assert.equal(outcome?.type, "delivery_failed", JSON.stringify(outcome));
			assert.equal(mostInFlight, 1, `${mostInFlight} hold-check reads were in flight at once`);
			const holds = framesOf(sender).filter((frame) => frame.type === "send_held" && frame.messageId === sent.id);
			for (const hold of holds)
				assert.ok(
					hold.type === "send_held" && hold.timeoutMs <= RECIPIENT_SAVE_MAX_WAIT_MS,
					"no hold reaches past the save cap",
				);
			assert.ok(Date.now() - sentAt >= RECIPIENT_RECEIPT_TIMEOUT_MS);
		} finally {
			spy.mockRestore();
			vi.useRealTimers();
		}
	},
	CROSS_NODE_WAIT_MS * 6,
);

test(
	"a remote recipient that keeps reporting progress with a fast store keeps its sender waiting until the save cap (#3983)",
	async () => {
		const [a, b] = await cluster();
		const sender = await a!.connect("sender");
		const recipient = await b!.connect("recipient");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
		try {
			const sent = message();
			const sentAt = Date.now();
			a!.send(sender, "recipient", sent);
			await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
			let outcomeAt: number | undefined;
			for (let elapsed = 0; elapsed < RECIPIENT_SAVE_MAX_WAIT_MS + RECIPIENT_RECEIPT_TIMEOUT_MS; ) {
				b!.router.saving(recipient, sent.id);
				await advance(RECIPIENT_SAVING_REPORT_INTERVAL_MS);
				elapsed += RECIPIENT_SAVING_REPORT_INTERVAL_MS;
				if (outcomeAt === undefined && outcomeOf(sender, sent.id) !== undefined) outcomeAt = Date.now();
			}
			assert.equal(outcomeOf(sender, sent.id)?.type, "delivery_failed");
			assert.ok(outcomeAt !== undefined);
			const waited = outcomeAt - sentAt;
			assert.ok(
				waited >= RECIPIENT_SAVE_MAX_WAIT_MS - RECIPIENT_RECEIPT_TIMEOUT_MS,
				`the sender heard the outcome after ${waited} ms, before the save cap`,
			);
			assert.ok(
				waited <= RECIPIENT_SAVE_MAX_WAIT_MS + RECIPIENT_SAVING_REPORT_INTERVAL_MS,
				`the sender waited ${waited} ms, past the save cap`,
			);
			assert.ok(
				framesOf(sender).filter((frame) => frame.type === "send_held" && frame.messageId === sent.id).length > 1,
				"progress reports held the sender",
			);
		} finally {
			vi.useRealTimers();
		}
	},
	CROSS_NODE_WAIT_MS * 6,
);

/** Fine enough that a hold check's real outbox read answers before its `send_held`-while-reading grace. */
const DECISION_STEP_MS = 100;

function holdsOf(session: BrokerConnectedSession, id: string) {
	return framesOf(session).filter(
		(frame): frame is Extract<BrokerOutboundFrame, { type: "send_held" }> =>
			frame.type === "send_held" && frame.messageId === id,
	);
}

/** Steps fake time until the sender's broker decides its next receipt wait: one more hold, or an outcome. */
async function nextReceiptDecision(sender: BrokerConnectedSession, id: string): Promise<void> {
	const holdsBefore = holdsOf(sender, id).length;
	const decided = await advanceUntil(
		() => (holdsOf(sender, id).length > holdsBefore || outcomeOf(sender, id) !== undefined ? true : undefined),
		2 * RECIPIENT_RECEIPT_TIMEOUT_MS,
		DECISION_STEP_MS,
	);
	assert.ok(decided !== undefined, "the sender's broker decided the receipt wait");
}

test("a remote recipient whose saving report lands only after a receipt wait keeps its sender waiting and is delivered once (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		// The recipient is stalled through the first receipt wait, so its saving report lands after that wait ends.
		await nextReceiptDecision(sender, sent.id);
		assert.equal(outcomeOf(sender, sent.id), undefined, JSON.stringify(outcomeOf(sender, sent.id)));
		assert.equal(holdsOf(sender, sent.id).length, 1);
		assert.equal(b!.router.saving(recipient, sent.id), true);
		await nextReceiptDecision(sender, sent.id);
		assert.equal(outcomeOf(sender, sent.id), undefined, JSON.stringify(outcomeOf(sender, sent.id)));
		assert.equal(holdsOf(sender, sent.id).length, 2, "the late report kept the sender waiting");
		assert.equal(b!.router.received(recipient, sent.id), true);
		const delivered = await advanceUntil(() => outcomeOf(sender, sent.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(delivered?.value.type, "delivered", JSON.stringify(delivered));
		assert.equal(
			framesOf(sender).filter((frame) => frame.type === "delivery_failed" && frame.messageId === sent.id).length,
			0,
		);
		assert.equal(messageFrames(recipient, sent.id).length, 1, "delivered once");
	} finally {
		vi.useRealTimers();
	}
});

test("a remote recipient that holds a message but has stopped saving still ends its sender's wait uncertain, one forgiven receipt wait later and within the save cap (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		const sentAt = Date.now();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		await nextReceiptDecision(sender, sent.id);
		assert.equal(outcomeOf(sender, sent.id), undefined, "one missed report does not decide the outcome");
		await nextReceiptDecision(sender, sent.id);
		const outcome = outcomeOf(sender, sent.id);
		assert.equal(reasonOf(outcome), UNCERTAIN_RECEIPT_REASON, JSON.stringify(outcome));
		assert.equal(holdsOf(sender, sent.id).length, 1, "exactly one receipt wait was forgiven");
		const waited = Date.now() - sentAt;
		assert.ok(waited >= 2 * RECIPIENT_RECEIPT_TIMEOUT_MS, `uncertain after only ${waited} ms`);
		assert.ok(waited < 3 * RECIPIENT_RECEIPT_TIMEOUT_MS, `a stalled recipient held its sender ${waited} ms`);
		assert.ok(waited < RECIPIENT_SAVE_MAX_WAIT_MS);
		assert.equal(messageFrames(recipient, sent.id).length, 1, "delivered to the recipient once");
	} finally {
		vi.useRealTimers();
	}
});

test("only two receipt waits in a row without a fresh saving report end a remote send uncertain, and a fresh report forgives the next miss (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const outbox = a!.opened.state.outbox;
	const read = outbox.read.bind(outbox);
	// The store clock is real, so the age of the recipient's last report as the sender's broker reads it is scripted.
	let scriptedSavingAgeMs: number | undefined;
	const spy = vi.spyOn(outbox, "read").mockImplementation(async (messageId) => {
		const result = await read(messageId);
		if (scriptedSavingAgeMs === undefined || result.status !== "found" || result.row.state !== "claimed")
			return result;
		return { ...result, row: { ...result.row, savingAgeMs: scriptedSavingAgeMs } };
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		const decisions: Array<string | undefined> = [];
		const decide = async (savingAgeMs: number | undefined) => {
			scriptedSavingAgeMs = savingAgeMs;
			const holdsBefore = holdsOf(sender, sent.id).length;
			await nextReceiptDecision(sender, sent.id);
			decisions.push(holdsOf(sender, sent.id).length > holdsBefore ? "held" : reasonOf(outcomeOf(sender, sent.id)));
		};
		await decide(undefined);
		await decide(RECIPIENT_RECEIPT_TIMEOUT_MS - 1);
		await decide(RECIPIENT_RECEIPT_TIMEOUT_MS);
		await decide(RECIPIENT_RECEIPT_TIMEOUT_MS);
		assert.deepEqual(decisions, ["held", "held", "held", UNCERTAIN_RECEIPT_REASON]);
		for (const hold of holdsOf(sender, sent.id))
			assert.ok(hold.type === "send_held" && hold.timeoutMs === RECIPIENT_RECEIPT_TIMEOUT_MS);
	} finally {
		spy.mockRestore();
		vi.useRealTimers();
	}
});

test("a hold check that finds no outbox row ends the remote send uncertain without reporting a routing error (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const outbox = a!.opened.state.outbox;
	const read = outbox.read.bind(outbox);
	let rowGone = false;
	const spy = vi
		.spyOn(outbox, "read")
		.mockImplementation(async (messageId) => (rowGone ? { status: "missing" } : read(messageId)));
	const errors = vi.spyOn(console, "error").mockImplementation(() => {});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		rowGone = true;
		await nextReceiptDecision(sender, sent.id);
		assert.equal(reasonOf(outcomeOf(sender, sent.id)), UNCERTAIN_RECEIPT_REASON);
		assert.equal(holdsOf(sender, sent.id).length, 0);
		assert.deepEqual(errors.mock.calls, []);
	} finally {
		errors.mockRestore();
		spy.mockRestore();
		vi.useRealTimers();
	}
});

test("a hold check whose read answers after the save cap has passed ends the remote send uncertain, never holding it for no time (#4443)", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const outbox = a!.opened.state.outbox;
	const read = outbox.read.bind(outbox);
	let answerPastCap = false;
	const spy = vi.spyOn(outbox, "read").mockImplementation(async (messageId) => {
		const result = await read(messageId);
		if (!answerPastCap || result.status !== "found" || result.row.state !== "claimed") return result;
		// The read answers once the cap has passed, before the cap's own timer has run: a fresh report cannot hold.
		vi.setSystemTime(Date.now() + RECIPIENT_SAVE_MAX_WAIT_MS);
		// The cap is timed on the monotonic clock (#5058).
		const elapsed = performance.now.bind(performance);
		vi.spyOn(performance, "now").mockImplementation(() => elapsed() + RECIPIENT_SAVE_MAX_WAIT_MS);
		return { ...result, row: { ...result.row, savingAgeMs: 0 } };
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		answerPastCap = true;
		await nextReceiptDecision(sender, sent.id);
		assert.equal(reasonOf(outcomeOf(sender, sent.id)), UNCERTAIN_RECEIPT_REASON);
		assert.deepEqual(holdsOf(sender, sent.id), []);
	} finally {
		spy.mockRestore();
		vi.restoreAllMocks();
		vi.useRealTimers();
	}
});

/**
 * #4896: the most one send queued for an offline session may take on a loaded CI host. It is a few database reads and
 * one commit, which a Windows disk syncs in about 3 ms when idle and several times that beside other suites. A flood
 * makes `OUTBOX_TARGET_MAX_ROWS` such sends one after another, so its budget is this per send, not a fixed total.
 */
const QUEUED_SEND_BUDGET_MS = 60;
/** The flood's budget: every send it makes at `QUEUED_SEND_BUDGET_MS`, then its setup and its delivery, each a hop. */
const FLOOD_BUDGET_MS = (OUTBOX_TARGET_MAX_ROWS + 1) * QUEUED_SEND_BUDGET_MS + 2 * CROSS_NODE_WAIT_MS;
/**
 * #4992: a test that fills an away asker's queue queues `OUTBOX_TARGET_MAX_ROWS` messages, each at
 * `QUEUED_SEND_BUDGET_MS`, and waits seven hops around them: two for its ask, one for the asker going away, one for
 * the failure's row and three for the queue delivered when the asker returns.
 */
const FULL_QUEUE_BUDGET_MS = (OUTBOX_TARGET_MAX_ROWS + 1) * QUEUED_SEND_BUDGET_MS + 7 * CROSS_NODE_WAIT_MS;

test(
	"flooding an offline known session through another broker stops at the per-target outbox cap and keeps every queued message (#4896)",
	async () => {
		const [a, b] = await cluster();
		const sender = await a!.connect("sender");
		const recipient = await b!.connect("away");
		const returnAddress = recipient.registrationReturnAddress!;
		b!.leave(recipient);
		await waitOffline(a!, recipient);

		const sentIds: string[] = [];
		for (let index = 0; index < OUTBOX_TARGET_MAX_ROWS; index++) {
			const sent = message({ content: { text: `flood ${index}` } });
			sentIds.push(sent.id);
			assert.equal((await sendAndSettle(a!, sender, "away", sent)).type, "queued");
		}
		const overflow = message({ content: { text: "one too many" } });
		const refused = await sendAndSettle(a!, sender, "away", overflow);
		assert.equal(refused.type, "delivery_failed");
		assert.match(
			reasonOf(refused) ?? "",
			/already has the most queued Intercom messages it accepts \(1000 messages or 64 MiB\)/,
		);
		// Nothing was written for it: no row, and no reservation of its id.
		assert.deepEqual(await a!.opened.state.outbox.read(overflow.id), { status: "missing" });
		assert.deepEqual(await a!.opened.state.sentMessages.lookup({ messageId: overflow.id, digest: "" }), {
			status: "miss",
		});

		// Nothing already queued was lost: every message reaches the recipient when it returns.
		const delivered = (session: BrokerConnectedSession) =>
			framesOf(session).flatMap((frame) => (frame.type === "message" ? [frame.message.id] : []));
		const back = await b!.connect("away", { returnAddress, id: recipient.info.id });
		await whenWritten(
			back,
			() => (delivered(back).length === sentIds.length ? true : undefined),
			"delivery of every queued message",
		);
		assert.deepEqual(delivered(back), sentIds);
	},
	FLOOD_BUDGET_MS,
);

/** A delivery frame of `text`, as an outbox row holds it. */
function outboxFrame(id: string, text: string) {
	return {
		type: "message",
		from: { id: "s", name: "s", cwd: "/", model: "m", pid: 1, startedAt: 1, lastActivity: 1 },
		message: { id, timestamp: 1, content: { text } },
	} as const;
}

function enqueueFrame(node: Node, id: string, text: string, targetIdentity = "away") {
	return node.opened.state.outbox.enqueue({
		targetIdentity,
		originBrokerId: node.name,
		digest: id,
		frame: outboxFrame(id, text),
	});
}

test("the per-target outbox byte cap refuses a frame that would pass it, across connections (#4896)", async () => {
	const [a, b] = await cluster();
	const big = "x".repeat(OUTBOX_TARGET_MAX_BYTES / 4);
	for (let index = 0; index < 3; index++)
		assert.equal((await enqueueFrame(index % 2 === 0 ? a! : b!, `big-${index}`, big)).status, "inserted");
	assert.deepEqual(await enqueueFrame(b!, "big-3", big), {
		status: "full",
		limit: OUTBOX_TARGET_MAX_ROWS,
		byteLimit: OUTBOX_TARGET_MAX_BYTES,
	});
	assert.equal((await enqueueFrame(a!, "small", "fits")).status, "inserted");
	// A frame that brings the target to exactly the byte cap is admitted; one more byte is not.
	const frameBytes = (id: string, text: string) => Buffer.byteLength(JSON.stringify(outboxFrame(id, text)));
	const used = 3 * frameBytes("big-0", big) + frameBytes("small", "fits");
	const fill = "f".repeat(OUTBOX_TARGET_MAX_BYTES - used - frameBytes("exact", ""));
	assert.equal((await enqueueFrame(b!, "over-by-one", `${fill}x`)).status, "full");
	assert.equal((await enqueueFrame(b!, "exact", fill)).status, "inserted");
	assert.equal((await enqueueFrame(a!, "after-exact", "")).status, "full");
	assert.equal((await enqueueFrame(b!, "other-target", big, "elsewhere")).status, "inserted");
	assert.equal(
		(await enqueueFrame(a!, "big-0", big)).status,
		"duplicate",
		"a retry of a queued row is still answered",
	);
});

test("rows an older broker queued without their frame size still count toward the byte cap, by their frames (#4896)", async () => {
	const [a] = await cluster(1);
	const big = "x".repeat(OUTBOX_TARGET_MAX_BYTES / 4);
	for (let index = 0; index < 3; index++)
		assert.equal((await enqueueFrame(a!, `big-${index}`, big)).status, "inserted");
	// An older broker records no frame size.
	await a!.database.run("UPDATE mn_intercom_outbox SET frame_bytes = NULL");
	assert.equal((await enqueueFrame(a!, "big-3", big)).status, "full");
	assert.equal((await enqueueFrame(a!, "small", "fits")).status, "inserted");
});

test(
	"queued outbox rows expire once their recipient's known-session retention lapses, and a retry is told why (#4896)",
	async () => {
		vi.useFakeTimers({ toFake: ["setInterval"] });
		try {
			const [a, b] = await cluster();
			const sender = await a!.connect("sender");
			const recipient = await b!.connect("away");
			b!.leave(recipient);
			await waitOffline(a!, recipient);
			const old = message({ content: { text: "old" } });
			const recent = message({ content: { text: "recent" } });
			assert.equal((await sendAndSettle(a!, sender, "away", old)).type, "queued");
			assert.equal((await sendAndSettle(a!, sender, "away", recent)).type, "queued");
			// The clock moves past the retention for the older row only.
			await a!.database.run(
				"UPDATE mn_intercom_outbox SET queued_at = queued_at - ? WHERE message_id = ?",
				KNOWN_SESSION_RETENTION_MS + 60_000,
				old.id,
			);
			await a!.database.run(
				"UPDATE mn_intercom_outbox SET queued_at = queued_at - ? WHERE message_id = ?",
				KNOWN_SESSION_RETENTION_MS - 60_000,
				recent.id,
			);
			vi.advanceTimersByTime(OUTBOX_BACKUP_POLL_INTERVAL_MS);
			const expired = await vi.waitFor(
				async () => {
					const read = await a!.opened.state.outbox.read(old.id);
					assert.ok(read.status === "found" && read.row.state === "failed", "not yet expired");
					return read.row;
				},
				{ timeout: CROSS_NODE_WAIT_MS },
			);
			assert.equal(expired.failureReason, OUTBOX_EXPIRED_REASON);
			const kept = await a!.opened.state.outbox.read(recent.id);
			assert.equal(kept.status === "found" && kept.row.state, "queued");

			framesOf(sender).length = 0;
			const retried = await sendAndSettle(a!, sender, "away", old);
			assert.equal(reasonOf(retried), OUTBOX_EXPIRED_REASON);
		} finally {
			vi.useRealTimers();
		}
	},
	2 * CROSS_NODE_WAIT_MS,
);

/** An ask from `asker` that `recipient`, on `recipientNode`, saved: its route is in the shared store. */
async function savedAsk(
	askerNode: Node,
	asker: BrokerConnectedSession,
	recipientNode: Node,
	recipient: BrokerConnectedSession,
) {
	const ask = message({ expectsReply: true });
	askerNode.send(asker, recipient.info.id, ask);
	await waitFor(() => messageFrames(recipient, ask.id)[0]);
	recipientNode.router.received(recipient, ask.id);
	assert.equal((await waitFor(() => outcomeOf(asker, ask.id))).type, "delivered");
	return ask;
}

function failuresOf(session: BrokerConnectedSession, askId: string) {
	return framesOf(session).filter(
		(frame) => frame.type === "message" && frame.message.replyTo === askId && frame.message.replyError !== undefined,
	);
}

/**
 * #5145: asker on a, recipient on b. Broker b stops right after it queued the asker's failure for the ended recipient:
 * it never clears the ask nor wakes the asker's broker, so the ask stays marked ended, as long ago as a stale claim.
 * `beforeSweep` changes the queued row before the asker's broker sweeps the ask at its next backup poll, which also
 * delivers a row still queued. Resolves to the ids of the failures the asker got.
 */
async function sweptAfterQueuedFailure(beforeSweep: (node: Node, askId: string) => Promise<void> = async () => {}) {
	vi.useFakeTimers({ toFake: ["setInterval"] });
	try {
		const [a, b] = await cluster();
		const asker = await a!.connect("asker");
		const recipient = await b!.connect("recipient");
		const ask = await savedAsk(a!, asker, b!, recipient);
		const stopped = () => Promise.reject(new Error("broker b stopped"));
		Object.assign(b!.opened.state.pendingAsks, { clearReply: stopped, unmarkEnded: stopped });
		b!.leave(recipient);
		const queued = await vi.waitFor(
			async () => {
				const read = await a!.opened.state.outbox.read(`ended:${ask.id}`);
				assert.equal(read.status, "found", "the failure is not queued yet");
				return read;
			},
			{ timeout: CROSS_NODE_WAIT_MS },
		);
		assert.ok(queued.status === "found" && queued.row.state === "queued");
		const ended = async () => {
			const listed = await a!.opened.state.pendingAsks.listEnded(0);
			return listed.status === "listed" && listed.asks.some((pending) => pending.messageId === ask.id);
		};
		assert.equal(await ended(), true, "the ask is still marked ended");

		await beforeSweep(a!, ask.id);
		await a!.database.run(
			"UPDATE mn_intercom_pending_asks SET ended_at = ended_at - ? WHERE message_id = ?",
			OUTBOX_CLAIM_STALE_AFTER_MS + 60_000,
			ask.id,
		);
		vi.advanceTimersByTime(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await vi.waitFor(async () => assert.equal(await ended(), false, "the ended ask is not swept yet"), {
			timeout: CROSS_NODE_WAIT_MS,
		});
		await waitFor(() => (failuresOf(asker, ask.id).length > 0 ? true : undefined));
		vi.advanceTimersByTime(OUTBOX_BACKUP_POLL_INTERVAL_MS);
		await new Promise((resolve) => setTimeout(resolve, 10 * BUS_POLL_INTERVAL_MS));
		return {
			askId: ask.id,
			failures: failuresOf(asker, ask.id).map((frame) => (frame.type === "message" ? frame.message.id : undefined)),
		};
	} finally {
		vi.useRealTimers();
	}
}

test(
	"an asker on another node is told once when the ended recipient's broker stops after queueing its failure and before clearing the ask (#5145)",
	async () => {
		const { askId, failures } = await sweptAfterQueuedFailure();
		assert.deepEqual(failures, [`ended:${askId}`], "told once");
	},
	3 * CROSS_NODE_WAIT_MS,
);

test(
	"an asker is still told its ask failed when the failure a stopped broker queued for it expired undelivered (#5145)",
	async () => {
		const { askId, failures } = await sweptAfterQueuedFailure(async (node, id) => {
			const outbox = node.opened.state.outbox;
			const queued = await outbox.read(`ended:${id}`);
			assert.ok(queued.status === "found");
			const claimed = await outbox.claim({
				claimantId: "expiry",
				targetIdentity: queued.row.targetIdentity,
				staleAfterMs: OUTBOX_CLAIM_STALE_AFTER_MS,
			});
			assert.ok(claimed.status === "claimed" && claimed.rows.length === 1);
			assert.equal((await outbox.markFailed(claimed.rows[0]!.claim, OUTBOX_EXPIRED_REASON)).status, "failed");
		});
		assert.deepEqual(failures, [`ended:${askId}`], "told once, by its own broker");
	},
	3 * CROSS_NODE_WAIT_MS,
);

/** Owner and its released subagent on b, asker on a: the asker's ask to the subagent is parked for the owner. */
async function parkedAskScene() {
	const [a, b] = await cluster();
	// Not the default group: the failure is authorized by the subagent's own group, as its sends were.
	const asker = await a!.connect("asker", { group: "crew" });
	const owner = await b!.connect("owner", { group: "crew" });
	const child = await b!.connect("child", { group: "crew", supervisorId: owner.info.id });
	const ask = await savedAsk(a!, asker, b!, child);
	b!.sessions.delete(child.info.id);
	b!.router.sessionLeft(child, { ownerSessionId: owner.info.id, childName: "child" });
	await vi.waitFor(
		async () =>
			assert.deepEqual(await a!.opened.state.pendingAsks.listParked(owner.info.id), {
				status: "listed",
				asks: [{ senderSessionId: asker.info.id, targetSessionId: child.info.id, messageId: ask.id }],
			}),
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	assert.deepEqual(failuresOf(asker, ask.id), [], "a released subagent's ask is still open");
	return { a: a!, b: b!, asker, owner, child, ask };
}

async function toldOnce(scene: Awaited<ReturnType<typeof parkedAskScene>>): Promise<void> {
	const failure = await waitFor(() => failuresOf(scene.asker, scene.ask.id)[0]);
	assert.ok(failure.type === "message");
	assert.equal(failure.message.id, `ended:${scene.ask.id}`);
	assert.equal(failure.message.replyError, 'Session "child" ended before replying');
	assert.deepEqual(failure.from, {
		id: scene.child.info.id,
		name: "child",
		group: "crew",
		groups: ["crew"],
		cwd: "",
		model: "",
		pid: 0,
		startedAt: 0,
		lastActivity: failure.from.lastActivity,
	});
	await new Promise((resolve) => setTimeout(resolve, 10 * BUS_POLL_INTERVAL_MS));
	assert.equal(failuresOf(scene.asker, scene.ask.id).length, 1, "told once");
	await vi.waitFor(
		async () =>
			assert.deepEqual(await scene.a.opened.state.pendingAsks.listParked(scene.owner.info.id), {
				status: "listed",
				asks: [],
			}),
		{ timeout: CROSS_NODE_WAIT_MS },
	);
}

test("an ask parked for a released subagent fails once for its asker on another node when the owner ends (#4992)", async () => {
	const scene = await parkedAskScene();
	scene.b.leave(scene.owner);
	await toldOnce(scene);
});

test("an ask parked for a released subagent fails once for its asker on another node when the owner goes away (#4992)", async () => {
	const scene = await parkedAskScene();
	scene.b.sessions.delete(scene.owner.info.id);
	scene.b.router.sessionLeft(scene.owner, undefined, false);
	await toldOnce(scene);
});

test("an ask parked for a released subagent fails once for its asker on another node when the owner drops the subagent (#4992)", async () => {
	const scene = await parkedAskScene();
	scene.b.router.restoringReleased(releasedReservationKey("child"), scene.owner.info.id);
	await toldOnce(scene);
});

test(
	"a recipient that ends fails an away asker's ask even when the asker's queue is full (#4992)",
	async () => {
		const [a, b] = await cluster();
		const returnAddress = randomUUID();
		const asker = await a!.connect("asker", { returnAddress });
		const recipient = await b!.connect("recipient");
		const ask = await savedAsk(a!, asker, b!, recipient);
		a!.sessions.delete(asker.info.id);
		a!.router.sessionLeft(asker, undefined, false);
		await waitOffline(b!, asker);
		// The away asker's queue reaches its cap.
		const filler = (id: string) =>
			b!.opened.state.outbox.enqueue({
				targetIdentity: deliveryTargetIdentity(asker),
				originBrokerId: b!.name,
				digest: id,
				frame: { type: "message", from: recipient.info, message: { id, timestamp: 1, content: { text: id } } },
			});
		const queued: string[] = [];
		for (let index = 0; index < OUTBOX_TARGET_MAX_ROWS; index++) {
			const id = `filler-${index}`;
			assert.equal((await filler(id)).status, "inserted");
			queued.push(id);
		}
		assert.equal((await filler("one-too-many")).status, "full");

		b!.leave(recipient);
		// The ask's route ends only once its failure is queued.
		await vi.waitFor(
			async () =>
				assert.deepEqual(
					await a!.opened.state.pendingAsks.matchesReply({
						replySenderSessionId: recipient.info.id,
						replyTargetSessionId: asker.info.id,
						replyTo: ask.id,
					}),
					{ status: "no-match" },
				),
			{ timeout: CROSS_NODE_WAIT_MS },
		);
		const back = await a!.connect("asker", { returnAddress, id: asker.info.id });
		await waitFor(() => (failuresOf(back, ask.id).length > 0 ? true : undefined), 3 * CROSS_NODE_WAIT_MS);
		const delivered = framesOf(back).flatMap((frame) => (frame.type === "message" ? [frame.message.id] : []));
		assert.deepEqual(
			delivered.filter((id) => id.startsWith("filler-")),
			queued,
			"every queued message is still delivered",
		);
		assert.equal(failuresOf(back, ask.id).length, 1);
	},
	FULL_QUEUE_BUDGET_MS,
);

test(
	"a recipient that turns terminal fails an away asker's ask even when the asker's queue is full (#4992)",
	async () => {
		const [a, b] = await cluster();
		const returnAddress = randomUUID();
		const asker = await a!.connect("asker", { returnAddress });
		const child = await b!.connect("child");
		const ask = await savedAsk(a!, asker, b!, child);
		a!.sessions.delete(asker.info.id);
		a!.router.sessionLeft(asker, undefined, false);
		await waitOffline(b!, asker);
		for (let index = 0; index < OUTBOX_TARGET_MAX_ROWS; index++) {
			const id = `filler-${index}`;
			const queued = await b!.opened.state.outbox.enqueue({
				targetIdentity: deliveryTargetIdentity(asker),
				originBrokerId: b!.name,
				digest: id,
				frame: { type: "message", from: child.info, message: { id, timestamp: 1, content: { text: id } } },
			});
			assert.equal(queued.status, "inserted");
		}

		child.info.replyCapability = "terminal";
		b!.router.sessionUpdated(child);
		await vi.waitFor(
			async () => {
				const row = await b!.opened.state.outbox.read(`terminal:${ask.id}`);
				assert.equal(row.status === "found" && row.row.targetIdentity, deliveryTargetIdentity(asker));
			},
			{ timeout: CROSS_NODE_WAIT_MS },
		);
		const back = await a!.connect("asker", { returnAddress, id: asker.info.id });
		await waitFor(() => (failuresOf(back, ask.id).length > 0 ? true : undefined), 3 * CROSS_NODE_WAIT_MS);
		const failures = failuresOf(back, ask.id);
		assert.equal(failures.length, 1);
		const failure = failures[0]!;
		assert.ok(failure.type === "message");
		assert.equal(failure.message.replyError, TERMINAL_CHILD_ASK_REFUSAL);
	},
	FULL_QUEUE_BUDGET_MS,
);

test("an ask whose replier ends right after replying gets only the reply on another node (#4992)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const replier = await b!.connect("replier");
	const ask = await savedAsk(a!, asker, b!, replier);
	const answer = message({ replyTo: ask.id, content: { text: "port 8080" } });
	b!.send(replier, asker.info.id, answer, { requirePendingReply: true });
	b!.leave(replier);
	const replied = await waitFor(() => messageFrames(asker, answer.id)[0]);
	assert.equal(replied.type, "message");
	await new Promise((resolve) => setTimeout(resolve, 20 * BUS_POLL_INTERVAL_MS));
	assert.deepEqual(failuresOf(asker, ask.id), [], "the reply is the ask's only outcome");
});

test("an away asker of a child that turned terminal and then ended gets only the terminal failure (#4992)", async () => {
	const [a, b] = await cluster();
	const returnAddress = randomUUID();
	const asker = await a!.connect("asker", { returnAddress });
	const child = await b!.connect("child");
	const ask = await savedAsk(a!, asker, b!, child);
	a!.sessions.delete(asker.info.id);
	a!.router.sessionLeft(asker, undefined, false);
	await waitOffline(b!, asker);
	child.info.replyCapability = "terminal";
	b!.router.sessionUpdated(child);
	await vi.waitFor(
		async () => {
			const row = await b!.opened.state.outbox.read(`terminal:${ask.id}`);
			assert.equal(row.status, "found");
		},
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	b!.leave(child);
	await vi.waitFor(
		async () =>
			assert.deepEqual(await a!.opened.state.pendingAsks.listForTarget(child.info.id), {
				status: "listed",
				asks: [],
			}),
		{ timeout: CROSS_NODE_WAIT_MS },
	);
	assert.deepEqual(await b!.opened.state.outbox.read(`ended:${ask.id}`), { status: "missing" }, "not failed again");
	const back = await a!.connect("asker", { returnAddress, id: asker.info.id });
	await waitFor(() => (failuresOf(back, ask.id).length > 0 ? true : undefined));
	await new Promise((resolve) => setTimeout(resolve, 10 * BUS_POLL_INTERVAL_MS));
	assert.deepEqual(
		failuresOf(back, ask.id).map((frame) => (frame.type === "message" ? frame.message.replyError : undefined)),
		[TERMINAL_CHILD_ASK_REFUSAL],
	);
});

test("a recipient that is only away keeps the asks from another node open (#4992)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const recipient = await b!.connect("recipient");
	const ask = await savedAsk(a!, asker, b!, recipient);
	b!.sessions.delete(recipient.info.id);
	b!.router.sessionLeft(recipient, undefined, false);
	await waitOffline(a!, recipient);
	await new Promise((resolve) => setTimeout(resolve, 10 * BUS_POLL_INTERVAL_MS));
	assert.deepEqual(failuresOf(asker, ask.id), []);
	assert.deepEqual(
		await a!.opened.state.pendingAsks.matchesReply({
			replySenderSessionId: recipient.info.id,
			replyTargetSessionId: asker.info.id,
			replyTo: ask.id,
		}),
		{ status: "match" },
	);
	assert.deepEqual(await a!.opened.state.pendingAsks.listEnded(0), { status: "listed", asks: [] });
});

test("an ask parked for a subagent Intercom no longer knows fails as sent by its session id when the owner ends (#4992)", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const owner = await b!.connect("owner");
	const forgotten = randomUUID();
	const ask = { senderSessionId: asker.info.id, targetSessionId: forgotten, messageId: randomUUID() };
	await b!.opened.state.pendingAsks.record(ask);
	await b!.opened.state.pendingAsks.parkForTarget(forgotten, {
		ownerSessionId: owner.info.id,
		reservationKey: releasedReservationKey("forgotten"),
	});
	b!.leave(owner);
	const failure = await waitFor(() => failuresOf(asker, ask.messageId)[0]);
	assert.ok(failure.type === "message");
	assert.equal(failure.message.replyError, `Session "${forgotten}" ended before replying`);
	assert.deepEqual(failure.from, {
		id: forgotten,
		cwd: "",
		model: "",
		pid: 0,
		startedAt: 0,
		lastActivity: failure.from.lastActivity,
	});
});

test("a cross-node send whose routing queries consume part of the client response wait extends the sender before its deadline instead of timing out", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const leases = a!.opened.state.leases;
	const listLive = leases.listLive.bind(leases);
	let delayRouting = true;
	const spy = vi.spyOn(leases, "listLive").mockImplementation(async (kind, staleAfterMs) => {
		if (delayRouting && kind === "presence") {
			delayRouting = false;
			await new Promise((resolve) => setTimeout(resolve, 3_000));
		}
		return listLive(kind, staleAfterMs);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		const sent = message();
		const sentAt = Date.now();
		a!.send(sender, "recipient", sent);
		// Routing consumes 3 s; advance past enqueue and wait for b's wake-up poll to deliver before 10 s.
		await advance(4_000);
		await waitFor(() => (messageFrames(recipient, sent.id).length === 1 ? true : undefined));
		await advance(SEND_RESPONSE_TIMEOUT_MS - 500 - (Date.now() - sentAt));
		assert.ok(
			holdsOf(sender, sent.id).length >= 1,
			`expected send_held before client deadline (${Date.now() - sentAt} ms elapsed)`,
		);
		// Recipient confirms at 10.5 s (> SEND_RESPONSE_TIMEOUT_MS, < T_enqueue + RECIPIENT_RECEIPT_TIMEOUT_MS).
		await advance(1_000);
		assert.equal(b!.router.received(recipient, sent.id), true);
		const delivered = await advanceUntil(() => outcomeOf(sender, sent.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(delivered?.value.type, "delivered", JSON.stringify(delivered));
		assert.equal(
			framesOf(sender).filter((frame) => frame.type === "delivery_failed" && frame.messageId === sent.id).length,
			0,
		);
	} finally {
		perfSpy.mockRestore();
		spy.mockRestore();
		vi.useRealTimers();
	}
});

test("a cross-node send whose routing queries make slow progress past 18 s keeps extending without shrinking and succeeds, while hung and fast-then-hung databases emit no holds", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	// Create an open ask so the reply walks leases.listLive -> knownSessions.binding -> outbox.read ->
	// pendingAsks.matchesReply -> reserveAndEnqueue -> pendingAsks.markReplied (6 sequential store steps).
	const ask = await savedAsk(a!, sender, b!, recipient);
	const state = b!.opened.state;
	const leases = state.leases;
	const known = state.knownSessions;
	const outbox = state.outbox;
	const pendingAsks = state.pendingAsks;
	const listLive = leases.listLive.bind(leases);
	const binding = known.binding.bind(known);
	const readOutbox = outbox.read.bind(outbox);
	const matchesReply = pendingAsks.matchesReply.bind(pendingAsks);
	const markReplied = pendingAsks.markReplied.bind(pendingAsks);
	const reserveAndEnqueue = state.reserveAndEnqueue!.bind(state);
	const STEP_MS = 3_500;
	let mode: "slow-21s" | "hung" | "fast-then-hang" | "mid-hang" | "off" = "slow-21s";
	const unblocks: Array<() => void> = [];
	const stepPause = () =>
		new Promise<void>((resolve) => {
			unblocks.push(resolve);
			setTimeout(resolve, STEP_MS);
		});
	const parkForever = () =>
		new Promise<void>((resolve) => {
			unblocks.push(resolve);
		});
	const leaseSpy = vi.spyOn(leases, "listLive").mockImplementation(async (kind, staleAfterMs) => {
		if (kind === "presence") {
			if (mode === "hung") {
				await parkForever();
				return [];
			}
			if (mode === "slow-21s" || mode === "mid-hang") await stepPause();
		}
		return listLive(kind, staleAfterMs);
	});
	const bindingSpy = vi.spyOn(known, "binding").mockImplementation(async (id, retentionMs) => {
		if (mode === "mid-hang" || mode === "fast-then-hang") {
			await parkForever();
			return { status: "unbound" as const };
		}
		if (mode === "slow-21s") await stepPause();
		return binding(id, retentionMs);
	});
	const outboxSpy = vi.spyOn(outbox, "read").mockImplementation(async (id) => {
		if (mode === "slow-21s") await stepPause();
		return readOutbox(id);
	});
	const matchSpy = vi.spyOn(pendingAsks, "matchesReply").mockImplementation(async (route) => {
		if (mode === "slow-21s") await stepPause();
		return matchesReply(route);
	});
	const enqueueSpy = vi.spyOn(state, "reserveAndEnqueue").mockImplementation(async (reservation, req) => {
		if (mode === "slow-21s") await stepPause();
		return reserveAndEnqueue(reservation, req);
	});
	const markSpy = vi.spyOn(pendingAsks, "markReplied").mockImplementation(async (route) => {
		if (mode === "slow-21s") {
			await stepPause();
			mode = "off";
		}
		return markReplied(route);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		// Part 1: 6 steps * 3.5 s = 21 s (> 18 s) of continuous routing progress; simulate legacy (shrinking) client.
		const slow = message({ replyTo: ask.id, content: { text: "slow-reply" } });
		let legacyClientDeadline = Date.now() + SEND_RESPONSE_TIMEOUT_MS;
		let seenHolds = 0;
		const startedAt = Date.now();
		b!.send(recipient, sender.info.id, slow, { requirePendingReply: true });
		for (let elapsed = 0; elapsed < 22_000; elapsed += 500) {
			await advance(500);
			const holds = holdsOf(recipient, slow.id);
			while (seenHolds < holds.length) {
				const frame = holds[seenHolds++]!;
				assert.equal(frame.type, "send_held");
				assert.ok(frame.timeoutMs > 0 && frame.timeoutMs <= RECIPIENT_RECEIPT_TIMEOUT_MS);
				const nextDeadline = Date.now() + frame.timeoutMs + HELD_SEND_GRACE_MS;
				assert.ok(nextDeadline > legacyClientDeadline, "progress hold must strictly extend even a legacy client");
				legacyClientDeadline = nextDeadline;
			}
			assert.ok(Date.now() < legacyClientDeadline, `client would have timed out at ${Date.now() - startedAt} ms`);
		}
		assert.ok(Date.now() - startedAt >= 21_000, "routing spanned past 18 s");
		assert.ok(seenHolds >= 3, `expected progress holds across 21 s, got ${seenHolds}`);
		await waitFor(() => (messageFrames(sender, slow.id).length === 1 ? true : undefined));
		assert.equal(a!.router.received(sender, slow.id), true);
		const delivered = await advanceUntil(() => outcomeOf(recipient, slow.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(delivered?.value.type, "delivered", JSON.stringify(delivered));

		// Part 2: permanently hung database emits zero holds past SEND_RESPONSE_TIMEOUT_MS.
		mode = "hung";
		const hung = message();
		b!.send(recipient, sender.info.id, hung);
		await advance(SEND_RESPONSE_TIMEOUT_MS + RECIPIENT_SAVING_REPORT_INTERVAL_MS);
		assert.deepEqual(holdsOf(recipient, hung.id), [], "a hung database must not extend the sender");

		// Part 3: fast step 1 (< 1 s) followed by hang on step 2 emits zero holds (keeps main's 10 s timeout).
		mode = "fast-then-hang";
		const fastHung = message();
		b!.send(recipient, sender.info.id, fastHung);
		await advance(SEND_RESPONSE_TIMEOUT_MS + RECIPIENT_SAVING_REPORT_INTERVAL_MS);
		assert.deepEqual(
			holdsOf(recipient, fastHung.id),
			[],
			"a fast step 1 followed by a hang must not extend past main's 10 s bound",
		);

		// Part 4: slow step 1 (3.5 s) then hang emits at most one hold and stops extending without new progress.
		mode = "mid-hang";
		const midHung = message();
		b!.send(recipient, sender.info.id, midHung);
		await advance(STEP_MS + RECIPIENT_RECEIPT_TIMEOUT_MS + 2 * RECIPIENT_SAVING_REPORT_INTERVAL_MS);
		assert.equal(holdsOf(recipient, midHung.id).length, 1, "slow step 1 then hang emits exactly one hold");
		await advance(3 * RECIPIENT_SAVING_REPORT_INTERVAL_MS);
		assert.equal(holdsOf(recipient, midHung.id).length, 1, "no further holds once progress stops");
	} finally {
		mode = "off";
		for (const release of unblocks.splice(0)) release();
		perfSpy.mockRestore();
		markSpy.mockRestore();
		enqueueSpy.mockRestore();
		matchSpy.mockRestore();
		outboxSpy.mockRestore();
		bindingSpy.mockRestore();
		leaseSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("a slow sent-message acceptance near the client deadline extends the sender, while a hung acceptance after fast delivery emits no holds", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const sentMessages = a!.opened.state.sentMessages;
	const accept = sentMessages.accept.bind(sentMessages);
	let acceptMode: "normal" | "stall-3s" | "hang" = "normal";
	let acceptEntered = false;
	const unblocks: Array<() => void> = [];
	const acceptSpy = vi.spyOn(sentMessages, "accept").mockImplementation(async (args) => {
		acceptEntered = true;
		if (acceptMode === "stall-3s") {
			acceptMode = "normal";
			await new Promise<void>((resolve) => {
				unblocks.push(resolve);
				setTimeout(resolve, 3_000);
			});
		} else if (acceptMode === "hang") {
			await new Promise<void>((resolve) => {
				unblocks.push(resolve);
			});
		}
		return accept(args);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		// Case 1: fast delivery (< 1 s) then hung sentMessages.accept emits zero holds (matches main's 10 s bound).
		acceptMode = "hang";
		acceptEntered = false;
		const fastHung = message();
		a!.send(sender, "recipient", fastHung);
		await waitFor(() => (messageFrames(recipient, fastHung.id).length > 0 ? true : undefined));
		assert.equal(b!.router.received(recipient, fastHung.id), true);
		await waitFor(() => (acceptEntered ? true : undefined));
		await advance(SEND_RESPONSE_TIMEOUT_MS + RECIPIENT_SAVING_REPORT_INTERVAL_MS);
		assert.deepEqual(
			holdsOf(sender, fastHung.id),
			[],
			"hung sentMessages.accept after fast delivery must not emit send_held",
		);
		acceptMode = "normal";
		for (const release of unblocks.splice(0)) release();
		await advanceUntil(() => outcomeOf(sender, fastHung.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);

		// Case 2: slow delivery (7.5 s) then 3 s sentMessages.accept emits send_held before 10 s and delivers.
		const sent = message();
		a!.send(sender, "recipient", sent);
		await waitFor(() => (messageFrames(recipient, sent.id).length > 0 ? true : undefined));
		await advance(RECIPIENT_RECEIPT_TIMEOUT_MS - 500);
		acceptMode = "stall-3s";
		assert.equal(b!.router.received(recipient, sent.id), true);
		await advance(2_000);
		assert.ok(holdsOf(sender, sent.id).length >= 1, "slow sentMessages.accept emitted send_held before 10 s");
		await advance(1_500);
		const delivered = await advanceUntil(() => outcomeOf(sender, sent.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(delivered?.value.type, "delivered", JSON.stringify(delivered));
	} finally {
		acceptMode = "normal";
		for (const release of unblocks.splice(0)) release();
		perfSpy.mockRestore();
		acceptSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("holdForRemoteReservation stops routing progress reporting before writing its 20 s hold during a slow wake", async () => {
	const [a, b] = await cluster();
	const supervisor = await b!.connect("supervisor", { group: "crew" });
	const sender = await a!.connect("sender", { group: "crew" });
	const key = releasedReservationKey("released-child-id");
	await b!.router.restoringReserved(key, supervisor.info.id, "restored-child", normalizeGroup("crew"), [], true, {
		wake: true,
	});
	await vi.waitFor(async () => {
		const lookup = await a!.opened.state.reservations.lookup(
			"restored-child",
			{ sessionId: sender.info.id, groups: [normalizeGroup("crew")] },
			30_000,
		);
		assert.equal(lookup.status, "reserved");
	});
	// Make heldSends.hold take 3.5 s (so routing progress arms a hold) and requestWake take 4 s after send_held(20 s).
	const heldSends = a!.opened.state.heldSends;
	const reservations = a!.opened.state.reservations;
	const origHold = heldSends.hold.bind(heldSends);
	const origRequestWake = reservations.requestWake.bind(reservations);
	const unblocks: Array<() => void> = [];
	const holdSpy = vi.spyOn(heldSends, "hold").mockImplementation(async (entry) => {
		await new Promise<void>((resolve) => {
			unblocks.push(resolve);
			setTimeout(resolve, 3_500);
		});
		return origHold(entry);
	});
	const wakeSpy = vi.spyOn(reservations, "requestWake").mockImplementation(async (reservationKey, wake) => {
		await new Promise<void>((resolve) => {
			unblocks.push(resolve);
			setTimeout(resolve, 4_000);
		});
		return origRequestWake(reservationKey, wake);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		const sent = message();
		a!.send(sender, "restored-child", sent, { awaitRestoringRecipient: true });
		await advance(10_000);
		const holds = holdsOf(sender, sent.id);
		const restoreIdx = holds.findIndex((frame) => frame.timeoutMs === RESTORING_RECIPIENT_HOLD_MS);
		assert.ok(
			restoreIdx !== -1,
			`expected a ${RESTORING_RECIPIENT_HOLD_MS} ms restoring hold, got ${JSON.stringify(holds)}`,
		);
		assert.equal(
			holds.length,
			restoreIdx + 1,
			`no shorter progress hold may follow the 20 s restoring hold: ${JSON.stringify(holds)}`,
		);
	} finally {
		for (const release of unblocks.splice(0)) release();
		perfSpy.mockRestore();
		wakeSpy.mockRestore();
		holdSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("progress timers never arm without store progress and clear cleanly when the router closes", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	await b!.connect("recipient");
	const leases = a!.opened.state.leases;
	const listLive = leases.listLive.bind(leases);
	const known = a!.opened.state.knownSessions;
	const binding = known.binding.bind(known);
	let mode: "hung" | "slow-then-hang" = "hung";
	const unblocks: Array<() => void> = [];
	const park = () =>
		new Promise<void>((resolve) => {
			unblocks.push(resolve);
		});
	const leaseSpy = vi.spyOn(leases, "listLive").mockImplementation(async (kind, staleAfterMs) => {
		if (kind === "presence") {
			if (mode === "hung") {
				await park();
				return [];
			}
			await new Promise<void>((resolve) => {
				unblocks.push(resolve);
				setTimeout(resolve, 3_500);
			});
		}
		return listLive(kind, staleAfterMs);
	});
	const bindingSpy = vi.spyOn(known, "binding").mockImplementation(async (id, retentionMs) => {
		if (mode === "slow-then-hang") {
			await park();
			return { status: "unbound" as const };
		}
		return binding(id, retentionMs);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		const progressStops = (a!.router as unknown as { progressStops: Set<() => void> }).progressStops;
		// 50 hung sends must arm 0 progress timers.
		for (let i = 0; i < 50; i++) a!.send(sender, "recipient", message());
		await advance(100);
		assert.equal(progressStops.size, 0, "hung sends with no store progress must arm zero progress timers");

		// Slow sends that answered step 1 at 3.5 s arm one-shot timers that close() must clear immediately.
		mode = "slow-then-hang";
		for (let i = 0; i < 5; i++) a!.send(sender, "recipient", message());
		await advance(3_600);
		assert.equal(progressStops.size, 5, "each slow-progressing send armed one pending hold timer");
		await a!.router.close();
		assert.equal(progressStops.size, 0, "router.close() must cancel every active progress timer");
	} finally {
		for (const release of unblocks.splice(0)) release();
		perfSpy.mockRestore();
		bindingSpy.mockRestore();
		leaseSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("routing that exceeds RECIPIENT_SAVE_MAX_WAIT_MS before enqueue fails without writing an outbox row", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	const leases = a!.opened.state.leases;
	const listLive = leases.listLive.bind(leases);
	let stallOnce = true;
	const unblocks: Array<() => void> = [];
	const spy = vi.spyOn(leases, "listLive").mockImplementation(async (kind, staleAfterMs) => {
		if (stallOnce && kind === "presence") {
			stallOnce = false;
			await new Promise<void>((resolve) => {
				unblocks.push(resolve);
				setTimeout(resolve, RECIPIENT_SAVE_MAX_WAIT_MS + 1_000);
			});
		}
		return listLive(kind, staleAfterMs);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		const sent = message();
		a!.send(sender, "recipient", sent);
		await advance(RECIPIENT_SAVE_MAX_WAIT_MS + 2_000, 5_000);
		const outcome = outcomeOf(sender, sent.id);
		assert.equal(outcome?.type, "delivery_failed", JSON.stringify(outcome));
		const row = await a!.opened.state.outbox.read(sent.id);
		assert.equal(row.status, "missing", "must not write an outbox row once the save cap has passed");
		assert.deepEqual(messageFrames(recipient, sent.id), [], "no late delivery after cap");
	} finally {
		for (const release of unblocks.splice(0)) release();
		perfSpy.mockRestore();
		spy.mockRestore();
		vi.useRealTimers();
	}
});

test("two concurrent slow replies in the same sender reply lane both extend past 10 s and deliver without Send timeout, while hung replies emit no holds", async () => {
	const [a, b] = await cluster();
	const asker = await a!.connect("asker");
	const replier = await b!.connect("replier");
	const ask1 = await savedAsk(a!, asker, b!, replier);
	const ask2 = await savedAsk(a!, asker, b!, replier);
	const state = b!.opened.state;
	const leases = state.leases;
	const known = state.knownSessions;
	const outbox = state.outbox;
	const pendingAsks = state.pendingAsks;
	const listLive = leases.listLive.bind(leases);
	const binding = known.binding.bind(known);
	const readOutbox = outbox.read.bind(outbox);
	const matchesReply = pendingAsks.matchesReply.bind(pendingAsks);
	const markReplied = pendingAsks.markReplied.bind(pendingAsks);
	const reserveAndEnqueue = state.reserveAndEnqueue!.bind(state);
	const STEP_MS = 2_000;
	let mode: "slow" | "hung" | "off" = "slow";
	const unblocks: Array<() => void> = [];
	const pause = () =>
		new Promise<void>((resolve) => {
			unblocks.push(resolve);
			setTimeout(resolve, STEP_MS);
		});
	const park = () =>
		new Promise<void>((resolve) => {
			unblocks.push(resolve);
		});
	const leaseSpy = vi.spyOn(leases, "listLive").mockImplementation(async (kind, staleAfterMs) => {
		if (kind === "presence") {
			if (mode === "hung") {
				await park();
				return [];
			}
			if (mode === "slow") await pause();
		}
		return listLive(kind, staleAfterMs);
	});
	const bindingSpy = vi.spyOn(known, "binding").mockImplementation(async (id, retentionMs) => {
		if (mode === "slow") await pause();
		return binding(id, retentionMs);
	});
	const outboxSpy = vi.spyOn(outbox, "read").mockImplementation(async (id) => {
		if (mode === "slow") await pause();
		return readOutbox(id);
	});
	const matchSpy = vi.spyOn(pendingAsks, "matchesReply").mockImplementation(async (route) => {
		if (mode === "slow") await pause();
		return matchesReply(route);
	});
	const enqueueSpy = vi.spyOn(state, "reserveAndEnqueue").mockImplementation(async (reservation, req) => {
		if (mode === "slow") await pause();
		return reserveAndEnqueue(reservation, req);
	});
	const markSpy = vi.spyOn(pendingAsks, "markReplied").mockImplementation(async (route) => {
		if (mode === "slow") await pause();
		return markReplied(route);
	});
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		const r1 = message({ replyTo: ask1.id, content: { text: "reply-1" } });
		const r2 = message({ replyTo: ask2.id, content: { text: "reply-2" } });
		let d1 = Date.now() + SEND_RESPONSE_TIMEOUT_MS;
		let d2 = Date.now() + SEND_RESPONSE_TIMEOUT_MS;
		let seen1 = 0;
		let seen2 = 0;
		b!.send(replier, asker.info.id, r1, { requirePendingReply: true });
		b!.send(replier, asker.info.id, r2, { requirePendingReply: true });
		let r1Confirmed = false;
		let r2Confirmed = false;
		// r1 takes ~12 s (6 * 2 s > 10 s) while r2 waits in serial("reply:replier"), then r2 takes ~12 s (~24 s total < 30 s lease TTL).
		for (let elapsed = 0; elapsed < 26_000; elapsed += 500) {
			await advance(500);
			for (const [id, update] of [
				[r1.id, (next: number) => (d1 = next)],
				[r2.id, (next: number) => (d2 = next)],
			] as const) {
				const holds = holdsOf(replier, id);
				const seen = id === r1.id ? seen1 : seen2;
				for (let i = seen; i < holds.length; i++) {
					const frame = holds[i]!;
					update(Date.now() + frame.timeoutMs + HELD_SEND_GRACE_MS);
				}
				if (id === r1.id) seen1 = holds.length;
				else seen2 = holds.length;
			}
			if (!r1Confirmed && (await readOutbox(r1.id)).status === "found") {
				await waitFor(() => (messageFrames(asker, r1.id).length === 1 ? true : undefined));
				assert.equal(a!.router.received(asker, r1.id), true);
				r1Confirmed = true;
			}
			if (!r2Confirmed && (await readOutbox(r2.id)).status === "found") {
				await waitFor(() => (messageFrames(asker, r2.id).length === 1 ? true : undefined));
				assert.equal(a!.router.received(asker, r2.id), true);
				r2Confirmed = true;
			}
			if (outcomeOf(replier, r1.id) === undefined) assert.ok(Date.now() < d1, "r1 must stay inside client deadline");
			if (outcomeOf(replier, r2.id) === undefined) assert.ok(Date.now() < d2, "r2 must stay inside client deadline");
			if (r1Confirmed && r2Confirmed) {
				mode = "off";
				break;
			}
		}
		assert.equal(r1Confirmed, true, "r1 arrived and was confirmed");
		assert.equal(r2Confirmed, true, "r2 arrived and was confirmed");
		const o1 = await advanceUntil(() => outcomeOf(replier, r1.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		const o2 = await advanceUntil(() => outcomeOf(replier, r2.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(o1?.value.type, "delivered", JSON.stringify(o1));
		assert.equal(o2?.value.type, "delivered", JSON.stringify(o2));

		// Control: when the first reply in the lane hangs with no store progress, neither reply emits send_held.
		mode = "hung";
		const hung1 = message({ replyTo: randomUUID(), content: { text: "hung-reply-1" } });
		const hung2 = message({ replyTo: randomUUID(), content: { text: "hung-reply-2" } });
		b!.send(replier, asker.info.id, hung1, { requirePendingReply: true });
		b!.send(replier, asker.info.id, hung2, { requirePendingReply: true });
		await advance(SEND_RESPONSE_TIMEOUT_MS + RECIPIENT_SAVING_REPORT_INTERVAL_MS);
		assert.deepEqual(holdsOf(replier, hung1.id), [], "hung first reply emits no holds");
		assert.deepEqual(holdsOf(replier, hung2.id), [], "reply queued behind a hung reply emits no holds");
	} finally {
		mode = "off";
		for (const release of unblocks.splice(0)) release();
		perfSpy.mockRestore();
		markSpy.mockRestore();
		enqueueSpy.mockRestore();
		matchSpy.mockRestore();
		outboxSpy.mockRestore();
		bindingSpy.mockRestore();
		leaseSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("re-entrant local-to-remote fallback enables progress reporting and queued remote sends inherit blocker progress without extending behind hung sends", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipientA = await a!.connect("target", { returnAddress: "stable-target" });
	const state = a!.opened.state;
	const leases = state.leases;
	const known = state.knownSessions;
	const outbox = state.outbox;
	const listLive = leases.listLive.bind(leases);
	const binding = known.binding.bind(known);
	const readOutbox = outbox.read.bind(outbox);
	const reserveAndEnqueue = state.reserveAndEnqueue!.bind(state);
	let blockFirstRead: (() => void) | undefined;
	let slowStep = false;
	const unblocks: Array<() => void> = [];
	const stepDelay = () =>
		new Promise<void>((resolve) => {
			unblocks.push(resolve);
			setTimeout(resolve, 3_500);
		});
	const outboxSpy = vi.spyOn(outbox, "read").mockImplementation(async (id) => {
		if (blockFirstRead === undefined && slowStep === false && id === m1.id) {
			await new Promise<void>((resolve) => {
				blockFirstRead = resolve;
				unblocks.push(resolve);
			});
		} else if (slowStep && id === m1.id) {
			await stepDelay();
		}
		return readOutbox(id);
	});
	const leaseSpy = vi.spyOn(leases, "listLive").mockImplementation(async (kind, staleAfterMs) => {
		if (kind === "presence" && slowStep) await stepDelay();
		return listLive(kind, staleAfterMs);
	});
	const bindingSpy = vi.spyOn(known, "binding").mockImplementation(async (id, retentionMs) => {
		if (slowStep) await stepDelay();
		return binding(id, retentionMs);
	});
	const enqueueSpy = vi.spyOn(state, "reserveAndEnqueue").mockImplementation(async (reservation, req) => {
		if (slowStep && reservation.messageId === m1.id) await stepDelay();
		return reserveAndEnqueue(reservation, req);
	});
	const m1 = message({ content: { text: "reentrant-m1" } });
	const m2 = message({ content: { text: "queued-m2" } });
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], shouldAdvanceTime: true });
	const now = performance.now.bind(performance);
	const basePerf = now();
	const baseDate = Date.now();
	const perfSpy = vi.spyOn(performance, "now").mockImplementation(() => basePerf + (Date.now() - baseDate));
	try {
		// m1 starts as localTarget = recipientA; while its outbox lookup runs, recipient moves to broker b.
		a!.send(sender, "target", m1);
		await settleFileIo();
		a!.leave(recipientA);
		const recipientB = await b!.connect("target", { returnAddress: "stable-target" });
		slowStep = true;
		// Release m1's local lookup so commitLocalNotFound re-enters remote routing on slow DB,
		// and concurrently send m2 directly to remote target so m2 queues in SendOrderGate.waitForEarlier behind m1.
		blockFirstRead?.();
		await advance(100, 100);
		a!.send(sender, "target", m2);
		let d1 = Date.now() + SEND_RESPONSE_TIMEOUT_MS;
		let d2 = Date.now() + SEND_RESPONSE_TIMEOUT_MS;
		let seen1 = 0;
		let seen2 = 0;
		for (let elapsed = 0; elapsed < 20_000; elapsed += 500) {
			await advance(500);
			const h1 = holdsOf(sender, m1.id);
			while (seen1 < h1.length) d1 = Date.now() + h1[seen1++]!.timeoutMs + HELD_SEND_GRACE_MS;
			const h2 = holdsOf(sender, m2.id);
			while (seen2 < h2.length) d2 = Date.now() + h2[seen2++]!.timeoutMs + HELD_SEND_GRACE_MS;
			if (outcomeOf(sender, m1.id) === undefined) assert.ok(Date.now() < d1, "re-entered m1 stayed inside deadline");
			if (outcomeOf(sender, m2.id) === undefined) assert.ok(Date.now() < d2, "queued m2 stayed inside deadline");
			if (messageFrames(recipientB, m1.id).length === 1 && messageFrames(recipientB, m2.id).length === 1) {
				slowStep = false;
				break;
			}
		}
		assert.equal(messageFrames(recipientB, m1.id).length, 1);
		assert.equal(messageFrames(recipientB, m2.id).length, 1);
		// Verify delivery order m1 before m2 is preserved!
		const texts = framesOf(recipientB)
			.filter((frame) => frame.type === "message")
			.map((frame) => frame.message.content.text);
		assert.deepEqual(texts, ["reentrant-m1", "queued-m2"]);
		assert.equal(b!.router.received(recipientB, m1.id), true);
		assert.equal(b!.router.received(recipientB, m2.id), true);
		const o1 = await advanceUntil(() => outcomeOf(sender, m1.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		const o2 = await advanceUntil(() => outcomeOf(sender, m2.id), CROSS_NODE_WAIT_MS, DECISION_STEP_MS);
		assert.equal(o1?.value.type, "delivered", JSON.stringify(o1));
		assert.equal(o2?.value.type, "delivered", JSON.stringify(o2));
	} finally {
		slowStep = false;
		for (const release of unblocks.splice(0)) release();
		perfSpy.mockRestore();
		enqueueSpy.mockRestore();
		bindingSpy.mockRestore();
		leaseSpy.mockRestore();
		outboxSpy.mockRestore();
		vi.useRealTimers();
	}
});

test("an already-settled cross-node retry releases its send-order ticket before slow sentMessages.accept so later sends do not block", async () => {
	const [a, b] = await cluster();
	const sender = await a!.connect("sender");
	const recipient = await b!.connect("recipient");
	// Deliver m1 first so its outbox row is already in state="delivered".
	const m1 = message({ content: { text: "already-delivered" } });
	a!.send(sender, "recipient", m1);
	await waitFor(() => (messageFrames(recipient, m1.id).length === 1 ? true : undefined));
	assert.equal(b!.router.received(recipient, m1.id), true);
	await waitFor(() => (outcomeOf(sender, m1.id)?.type === "delivered" ? true : undefined));

	// Now stall sentMessages.accept on the retry of m1, and send m2 immediately behind it.
	const sentMessages = a!.opened.state.sentMessages;
	const origAccept = sentMessages.accept.bind(sentMessages);
	let releaseAccept: (() => void) | undefined;
	const acceptSpy = vi.spyOn(sentMessages, "accept").mockImplementation(async (args) => {
		if (args.messageId === m1.id) {
			await new Promise<void>((resolve) => {
				releaseAccept = resolve;
			});
		}
		return origAccept(args);
	});
	try {
		const m2 = message({ content: { text: "not-blocked-by-accept" } });
		a!.send(sender, "recipient", m1);
		a!.send(sender, "recipient", m2);
		// m2 must arrive on recipient while m1's sentMessages.accept is still stalled!
		await waitFor(() => (messageFrames(recipient, m2.id).length === 1 ? true : undefined));
		assert.ok(releaseAccept !== undefined, "m1 retry was still awaiting sentMessages.accept when m2 arrived");
		assert.equal(b!.router.received(recipient, m2.id), true);
		await waitFor(() => (outcomeOf(sender, m2.id)?.type === "delivered" ? true : undefined));
		releaseAccept!();
	} finally {
		releaseAccept?.();
		acceptSpy.mockRestore();
	}
});

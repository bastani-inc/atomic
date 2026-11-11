import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import {
	DEPARTED_CHILD_HOLD_MS,
	DepartedChildren,
	type HeldSendRefusal,
	validateEndedChildrenFrame,
} from "../../packages/intercom/broker/departed-children.js";
import {
	isSubagentRecipientDisconnectedError,
	isSubagentRecipientEndedError,
} from "../../packages/intercom/broker/recipient-gone-errors.js";
import { type HeldSend, RESTORING_RECIPIENT_HOLD_MS } from "../../packages/intercom/broker/restoring-recipients.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

afterEach(() => {
	vi.useRealTimers();
});

const OWNER = "owner-session";
const CHILD = "subagent-worker-aabcf28b-1";
const CHILD_INTERCOM_ID = "11111111-2222-4333-8444-555555555555";
const CHILD_SESSION_ID = "01a1c1d9-bebd-73e1-a79d-668cf0bd43b8";

function sender(id: string, groups: string[] = ["default"]): { id: string; info: SessionInfo } {
	return { id, info: { id, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, groups } };
}

function send(messageId: string, senderId = "sender", to = CHILD): HeldSend {
	return { socket: {} as net.Socket, senderId, messageId, clientMessage: { type: "send", to } };
}

function departed(): { children: DepartedChildren; expired: HeldSendRefusal[] } {
	const expired: HeldSendRefusal[] = [];
	const children = new DepartedChildren((refusals) => expired.push(...refusals));
	return { children, expired };
}

function depart(children: DepartedChildren, childName = CHILD, owner = OWNER): HeldSend[] {
	return children.depart({
		ownerSessionId: owner,
		childName,
		group: "default",
		aliases: [CHILD_INTERCOM_ID, CHILD_SESSION_ID],
	});
}

test("a send to a subagent whose session just left waits as long as a restoring subagent's (#4639)", () => {
	assert.equal(DEPARTED_CHILD_HOLD_MS, RESTORING_RECIPIENT_HOLD_MS);
	vi.useFakeTimers();
	const { children } = departed();
	assert.deepEqual(depart(children), []);
	vi.advanceTimersByTime(5_000);
	const admission = children.admit(CHILD, sender("sender"), send("m1"), true);
	assert.deepEqual(admission, { kind: "held", timeoutMs: DEPARTED_CHILD_HOLD_MS - 5_000 });
	assert.equal(children.heldSendCount, 1);
	assert.equal(children.size, 1);
});

test("the owner's verdict refuses the held sends, each with the target it was addressed to, and answers later ones at once (#4639)", () => {
	const { children } = departed();
	depart(children);
	const byName = send("m1");
	const byIntercomId = send("m2", "sender", ` ${CHILD_INTERCOM_ID.toUpperCase()} `);
	assert.equal(children.admit(CHILD, sender("sender"), byName, true).kind, "held");
	assert.equal(children.admit(CHILD_INTERCOM_ID.toUpperCase(), sender("sender"), byIntercomId, true).kind, "held");

	const marked = children.mark(OWNER, [
		{ childName: CHILD, group: "default", aliases: [], outcome: "completed", childId: "aabcf28b:0" },
	]);
	assert.deepEqual(marked.evicted, []);
	assert.deepEqual(
		marked.refused.map(({ held, error }) => ({ id: held.messageId, code: error.code, fields: error.fields })),
		[
			{ id: "m1", code: "recipient_completed", fields: { target: CHILD, childName: CHILD, childId: "aabcf28b:0" } },
			{
				id: "m2",
				code: "recipient_completed",
				fields: { target: CHILD_INTERCOM_ID.toUpperCase(), childName: CHILD, childId: "aabcf28b:0" },
			},
		],
	);
	assert.ok(marked.refused.every(({ error }) => isSubagentRecipientEndedError(error)));
	assert.equal(children.heldSendCount, 0);

	const later = children.admit(CHILD_SESSION_ID, sender("sender"), send("m3", "sender", CHILD_SESSION_ID), true);
	assert.equal(later.kind, "refused");
	assert.ok(later.kind === "refused" && isSubagentRecipientEndedError(later.error));
	assert.equal(later.kind === "refused" && later.error.target, CHILD_SESSION_ID);
	assert.equal(children.heldSendCount, 0);
});

test("a verdict without a child id, and one given before the disconnect reached the broker, still answers (#4639)", () => {
	vi.useFakeTimers();
	const { children, expired } = departed();
	children.mark(OWNER, [{ childName: CHILD, group: "default", aliases: [], outcome: "cancelled" }]);
	depart(children);
	const refused = children.admit(CHILD, sender("sender"), send("m1"), true);
	assert.ok(refused.kind === "refused" && isSubagentRecipientEndedError(refused.error));
	assert.equal(refused.error.code, "recipient_cancelled");
	assert.deepEqual(refused.error.fields, { target: CHILD, childName: CHILD });
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS * 2);
	assert.deepEqual(expired, [], "an ended verdict is not replaced by the disconnect's wait");
	assert.equal(children.admit(CHILD, sender("sender"), send("m2"), true).kind, "refused");
});

test("a subagent nobody says anything about is refused as disconnected, retryably, when the wait ends (#4639)", () => {
	vi.useFakeTimers();
	const { children, expired } = departed();
	depart(children);
	children.admit(CHILD, sender("sender"), send("m1"), true);
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS - 1);
	assert.equal(expired.length, 0);
	vi.advanceTimersByTime(1);
	assert.equal(expired.length, 1);
	assert.equal(expired[0]!.held.messageId, "m1");
	assert.ok(isSubagentRecipientDisconnectedError(expired[0]!.error));
	assert.equal(expired[0]!.error.retryable, true);
	assert.equal(children.heldSendCount, 0);

	const later = children.admit(CHILD, sender("sender"), send("m2"), true);
	assert.ok(later.kind === "refused" && isSubagentRecipientDisconnectedError(later.error));
	children.mark(OWNER, [{ childName: CHILD, group: "default", aliases: [], outcome: "failed" }]);
	const afterVerdict = children.admit(CHILD, sender("sender"), send("m3"), true);
	assert.ok(afterVerdict.kind === "refused" && afterVerdict.error.code === "recipient_failed");
});

test("an expiry with nothing held reports nothing, and a later departure waits again (#4639)", () => {
	vi.useFakeTimers();
	const { children, expired } = departed();
	depart(children);
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS);
	assert.equal(expired.length, 0);
	depart(children);
	assert.equal(children.admit(CHILD, sender("sender"), send("m1"), true).kind, "held");
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS);
	assert.equal(expired.length, 1);
});

test("a client that cannot wait, or a full hold, is refused as disconnected instead of held (#4639)", () => {
	const { children } = departed();
	depart(children);
	const cannotWait = children.admit(CHILD, sender("sender"), send("m0"), false);
	assert.ok(cannotWait.kind === "refused" && isSubagentRecipientDisconnectedError(cannotWait.error));
	for (let index = 0; index < 256; index++)
		assert.equal(children.admit(CHILD, sender("sender"), send(`m${index}`), true).kind, "held");
	const overflow = children.admit(CHILD, sender("sender"), send("overflow"), true);
	assert.ok(overflow.kind === "refused" && isSubagentRecipientDisconnectedError(overflow.error));
	assert.equal(children.heldSendCount, 256);
});

test("only the owner and senders in the subagent's group are held or told anything (#4639)", () => {
	const { children } = departed();
	children.depart({ ownerSessionId: OWNER, childName: CHILD, group: "workflow:run", aliases: [] });
	assert.deepEqual(children.admit(CHILD, sender("outsider", ["default"]), send("m1", "outsider"), true), {
		kind: "none",
	});
	assert.equal(children.admit(CHILD, sender(OWNER, ["default"]), send("m2", OWNER), true).kind, "held");
	assert.equal(
		children.admit(CHILD, sender("member", ["default", "workflow:run"]), send("m3", "member"), true).kind,
		"held",
	);
	assert.deepEqual(children.admit("someone-else", sender(OWNER), send("m4", OWNER, "someone-else"), true), {
		kind: "none",
	});
});

test("the subagent registering again under its owner takes its held sends, in order; nobody else's registration does (#4639)", () => {
	const { children } = departed();
	depart(children);
	children.admit(CHILD, sender("sender"), send("m1"), true);
	children.admit(CHILD, sender("sender"), send("m2"), true);
	assert.deepEqual(children.registered(CHILD, new Set(["default"]), "rival"), []);
	assert.deepEqual(children.registered(CHILD, new Set(["elsewhere"]), OWNER), []);
	assert.equal(children.heldSendCount, 2);
	const taken = children.registered(` ${CHILD.toUpperCase()} `, new Set(["default"]), OWNER);
	assert.deepEqual(
		taken.map((held) => held.messageId),
		["m1", "m2"],
	);
	assert.equal(children.heldSendCount, 0);
	assert.equal(children.size, 0);
	assert.deepEqual(children.admit(CHILD_INTERCOM_ID, sender("sender"), send("m3"), true), { kind: "none" });
});

test("a released reservation of the subagent, and its owner leaving, hand the held sends back (#4639)", () => {
	const { children } = departed();
	depart(children);
	depart(children, "subagent-worker-other-1");
	children.admit(CHILD, sender("sender"), send("m1"), true);
	children.admit("subagent-worker-other-1", sender("sender"), send("m2", "sender", "subagent-worker-other-1"), true);
	assert.deepEqual(children.supersede("rival", CHILD), []);
	assert.deepEqual(
		children.supersede(OWNER, CHILD).map((held) => held.messageId),
		["m1"],
	);
	assert.equal(children.size, 1);
	assert.deepEqual(children.dropOwner("rival"), []);
	assert.deepEqual(
		children.dropOwner(OWNER).map((held) => held.messageId),
		["m2"],
	);
	assert.equal(children.size, 0);
	assert.equal(children.heldSendCount, 0);
	assert.deepEqual(children.dropOwner(OWNER), []);
});

test("a sender that leaves stops waiting; the other senders keep theirs (#4639)", () => {
	const { children } = departed();
	depart(children);
	children.admit(CHILD, sender("a"), send("a1", "a"), true);
	children.admit(CHILD, sender("b"), send("b1", "b"), true);
	children.admit(CHILD, sender("a"), send("a2", "a"), true);
	children.dropSender("a");
	assert.equal(children.heldSendCount, 1);
	assert.deepEqual(
		children.supersede(OWNER, CHILD).map((held) => held.messageId),
		["b1"],
	);
});

test("an owner keeps answers for a bounded number of subagents, forgetting the oldest first (#4639)", () => {
	const expired: HeldSendRefusal[] = [];
	const children = new DepartedChildren((refusals) => expired.push(...refusals), DEPARTED_CHILD_HOLD_MS, 2);
	children.depart({ ownerSessionId: OWNER, childName: "first", group: "default", aliases: [] });
	children.admit("first", sender("sender"), send("m1", "sender", "first"), true);
	children.mark(OWNER, [{ childName: "second", group: "default", aliases: [], outcome: "completed" }]);
	children.depart({ ownerSessionId: "other-owner", childName: "elsewhere", group: "default", aliases: [] });
	const evicted = children.mark(OWNER, [{ childName: "third", group: "default", aliases: [], outcome: "failed" }]);
	assert.deepEqual(
		evicted.evicted.map((held) => held.messageId),
		["m1"],
	);
	assert.deepEqual(children.admit("first", sender("sender"), send("m2", "sender", "first"), true), { kind: "none" });
	assert.equal(children.admit("second", sender("sender"), send("m3", "sender", "second"), true).kind, "refused");
	assert.equal(children.size, 3);
	const departingEvicts = children.depart({
		ownerSessionId: OWNER,
		childName: "fourth",
		group: "default",
		aliases: [],
	});
	assert.deepEqual(departingEvicts, []);
	assert.deepEqual(children.admit("second", sender("sender"), send("m4", "sender", "second"), true), { kind: "none" });
	assert.equal(children.size, 3);
	children.clear();
	assert.equal(children.size, 0);
	assert.equal(children.heldSendCount, 0);
});

test("a verdict updates the subagent's group and adds its ids; blank ids are ignored (#4639)", () => {
	const { children } = departed();
	children.mark(OWNER, [{ childName: CHILD, group: "default", aliases: [], outcome: "stopped" }]);
	children.mark(OWNER, [
		{
			childName: CHILD,
			group: "workflow:run",
			aliases: ["  ", CHILD_SESSION_ID],
			outcome: "stopped",
			childId: "a:1",
		},
	]);
	assert.deepEqual(children.admit(CHILD, sender("sender", ["default"]), send("m1"), true), { kind: "none" });
	const byId = children.admit(CHILD_SESSION_ID, sender("member", ["workflow:run"]), send("m2", "member"), true);
	assert.ok(byId.kind === "refused" && byId.error.code === "recipient_stopped");
	assert.equal(byId.error.childId, "a:1");
	assert.deepEqual(children.admit("", sender("member", ["workflow:run"]), send("m3", "member", ""), true), {
		kind: "none",
	});
});

test("an ended-children frame is validated as a whole, naming the first invalid child and why (#4639)", () => {
	const valid = {
		childName: ` ${CHILD} `,
		group: "lane",
		aliases: [CHILD_SESSION_ID],
		outcome: "completed",
		childId: "aabcf28b:0",
	};
	assert.deepEqual(validateEndedChildrenFrame([valid, { childName: "other", outcome: "stopped" }], " workflow:run "), {
		ok: true,
		children: [
			{ childName: CHILD, group: "lane", aliases: [CHILD_SESSION_ID], outcome: "completed", childId: "aabcf28b:0" },
			{ childName: "other", group: "workflow:run", aliases: [], outcome: "stopped", childId: undefined },
		],
	});
	const refusal = (children: unknown) => {
		const validation = validateEndedChildrenFrame(children as never, "default");
		return validation.ok ? undefined : validation.refusal;
	};
	assert.deepEqual(refusal(undefined), { code: "invalid_frame" });
	assert.deepEqual(refusal([]), { code: "invalid_frame" });
	assert.deepEqual(refusal({}), { code: "invalid_frame" });
	assert.deepEqual(refusal(Array.from({ length: 501 }, () => valid)), { code: "invalid_frame" });
	assert.deepEqual(refusal([valid, "child"]), { code: "invalid_frame" });
	assert.deepEqual(refusal([null]), { code: "invalid_frame" });
	assert.deepEqual(refusal([[valid]]), { code: "invalid_frame" });
	assert.deepEqual(refusal([{ ...valid, childName: "   " }]), { code: "invalid_child_name", childName: "   " });
	assert.deepEqual(refusal([{ ...valid, childName: "*" }]), { code: "invalid_child_name", childName: "*" });
	assert.deepEqual(refusal([{ ...valid, childName: 3 }]), { code: "invalid_child_name" });
	assert.deepEqual(refusal([{ ...valid, outcome: "released" }]), {
		code: "invalid_frame",
		childName: valid.childName,
	});
	assert.deepEqual(refusal([{ ...valid, outcome: undefined }]), { code: "invalid_frame", childName: valid.childName });
	assert.deepEqual(refusal([{ ...valid, outcome: 3 }]), { code: "invalid_frame", childName: valid.childName });
	assert.deepEqual(refusal([{ ...valid, childId: 7 }]), { code: "invalid_frame", childName: valid.childName });
	assert.deepEqual(refusal([{ ...valid, childId: "x".repeat(257) }]), {
		code: "invalid_frame",
		childName: valid.childName,
	});
	assert.equal(refusal([{ ...valid, childId: "x".repeat(256) }]), undefined);
	assert.deepEqual(refusal([{ ...valid, group: 4 }]), { code: "invalid_group", childName: valid.childName });
	assert.deepEqual(refusal([{ ...valid, aliases: "id" }]), { code: "invalid_alias", childName: valid.childName });
	assert.deepEqual(refusal([{ ...valid, aliases: [4] }]), { code: "invalid_alias", childName: valid.childName });
	assert.deepEqual(refusal([{ ...valid, aliases: ["not-an-id"] }]), {
		code: "invalid_alias",
		childName: valid.childName,
	});
	assert.deepEqual(refusal([{ ...valid, aliases: Array.from({ length: 5 }, () => CHILD_SESSION_ID) }]), {
		code: "too_many_aliases",
		childName: valid.childName,
	});
	assert.equal(refusal([{ ...valid, aliases: Array.from({ length: 4 }, () => CHILD_SESSION_ID) }]), undefined);
	assert.equal(refusal(Array.from({ length: 500 }, () => valid)), undefined);
	for (const outcome of ["completed", "failed", "stopped", "cancelled"])
		assert.equal(refusal([{ ...valid, outcome }]), undefined, outcome);
});

function validateGroup(group: string): string {
	const validation = validateEndedChildrenFrame([{ childName: "probe", outcome: "completed" }], group);
	assert.ok(validation.ok);
	return validation.children[0]!.group;
}

test("a child with no group takes the owner's registration group, normalized (#4639)", () => {
	assert.equal(validateGroup(" Team-A "), "Team-A");
	assert.equal(validateGroup("   "), "default");
	const validation = validateEndedChildrenFrame([{ childName: "probe", outcome: "completed", group: " own " }], "x");
	assert.ok(validation.ok);
	assert.equal(validation.children[0]!.group, "own");
});

test("a second departure of the same subagent starts its wait again (#4639)", () => {
	vi.useFakeTimers();
	const { children, expired } = departed();
	depart(children);
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS / 2);
	depart(children);
	assert.equal(children.sizes().timers, 1, "the first wait's timer was cleared");
	children.admit(CHILD, sender("sender"), send("m1"), true);
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS - 1);
	assert.equal(expired.length, 0, "the first departure's deadline no longer applies");
	vi.advanceTimersByTime(1);
	assert.equal(expired.length, 1);
});

test("a verdict ends the wait for good: its deadline passing changes nothing (#4639)", () => {
	vi.useFakeTimers();
	const { children, expired } = departed();
	depart(children);
	children.admit(CHILD, sender("sender"), send("m1"), true);
	children.mark(OWNER, [{ childName: CHILD, group: "default", aliases: [], outcome: "completed" }]);
	assert.equal(children.sizes().timers, 0);
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS * 2);
	assert.equal(expired.length, 0);
	const later = children.admit(CHILD, sender("sender"), send("m2"), true);
	assert.ok(later.kind === "refused" && later.error.code === "recipient_completed");
});

test("an expiry with nothing held calls nobody (#4639)", () => {
	vi.useFakeTimers();
	let calls = 0;
	const children = new DepartedChildren(() => {
		calls += 1;
	});
	depart(children);
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS);
	assert.equal(calls, 0);
	assert.equal(children.sizes().timers, 0);
});

test("the subagent's name is kept trimmed, and a disconnected refusal names it and the target (#4639)", () => {
	const { children } = departed();
	children.depart({ ownerSessionId: OWNER, childName: `  ${CHILD}  `, group: "default", aliases: [] });
	const refused = children.admit(` ${CHILD} `, sender("sender"), send("m1"), false);
	assert.ok(refused.kind === "refused" && isSubagentRecipientDisconnectedError(refused.error));
	assert.deepEqual(refused.error.fields, { target: ` ${CHILD} `, childName: CHILD });
});

test("subagents of two owners under one name are each found by the senders of their own group (#4639)", () => {
	const { children } = departed();
	children.depart({ ownerSessionId: "owner-a", childName: CHILD, group: "team-a", aliases: [] });
	children.depart({ ownerSessionId: "owner-b", childName: CHILD, group: "team-b", aliases: [] });
	children.mark("owner-a", [{ childName: CHILD, group: "team-a", aliases: [], outcome: "completed" }]);
	children.mark("owner-b", [{ childName: CHILD, group: "team-b", aliases: [], outcome: "failed" }]);
	const a = children.admit(CHILD, sender("a", ["team-a"]), send("m1"), true);
	const b = children.admit(CHILD, sender("b", ["team-b"]), send("m2"), true);
	assert.ok(a.kind === "refused" && a.error.code === "recipient_completed");
	assert.ok(b.kind === "refused" && b.error.code === "recipient_failed");
	assert.deepEqual(children.sizes(), { departures: 2, byTarget: 1, byOwner: 2, heldSends: 0, timers: 0 });
	children.dropOwner("owner-a");
	assert.deepEqual(children.sizes(), { departures: 1, byTarget: 1, byOwner: 1, heldSends: 0, timers: 0 });
	assert.deepEqual(children.admit(CHILD, sender("a", ["team-a"]), send("m3"), true), { kind: "none" });
});

test("forgetting a subagent leaves no index entry, held send or timer behind (#4639)", () => {
	const { children } = departed();
	depart(children);
	children.admit(CHILD, sender("sender"), send("m1"), true);
	assert.deepEqual(children.sizes(), { departures: 1, byTarget: 3, byOwner: 1, heldSends: 1, timers: 1 });
	children.supersede(OWNER, CHILD);
	assert.deepEqual(children.sizes(), { departures: 0, byTarget: 0, byOwner: 0, heldSends: 0, timers: 0 });
	depart(children);
	children.registered(CHILD, new Set(["default"]), OWNER);
	assert.deepEqual(children.sizes(), { departures: 0, byTarget: 0, byOwner: 0, heldSends: 0, timers: 0 });
});

const HOST = "host-session-a";
const NEW_OWNER = "owner-session-back";

function ended(childName = CHILD, outcome: "completed" | "failed" = "completed") {
	return { childName, group: "default", aliases: [], outcome, childId: "aabcf28b:0" } as const;
}

test("what an owner reported outlives its connection for its host session, and answers senders meanwhile (#4639)", () => {
	const { children } = departed();
	children.mark(OWNER, [ended()]);

	assert.deepEqual(children.dropOwner(OWNER, HOST), []);

	const refused = children.admit(CHILD, sender("sender"), send("m1"), true);
	assert.ok(refused.kind === "refused" && isSubagentRecipientEndedError(refused.error));
	assert.equal(refused.error.code, "recipient_completed");
	assert.equal(children.orphanCount, 1);
});

test("without a host session to come back to, an owner's departure forgets what it reported as before (#4639)", () => {
	const { children } = departed();
	children.mark(OWNER, [ended()]);

	children.dropOwner(OWNER);

	assert.equal(children.admit(CHILD, sender("sender"), send("m1"), true).kind, "none");
	assert.deepEqual(children.sizes(), { departures: 0, byTarget: 0, byOwner: 0, heldSends: 0, timers: 0 });
});

test("a subagent that leaves after its owner did is held for the owner's host session, and refused as disconnected when no verdict comes (#4639)", () => {
	vi.useFakeTimers();
	const { children, expired } = departed();
	children.depart({
		ownerSessionId: OWNER,
		childName: CHILD,
		group: "default",
		aliases: [CHILD_INTERCOM_ID],
		ownerHostSession: HOST,
	});

	assert.equal(children.admit(CHILD, sender("sender"), send("m1"), true).kind, "held");
	assert.equal(children.orphanCount, 1);
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS);

	assert.equal(expired.length, 1);
	assert.ok(isSubagentRecipientDisconnectedError(expired[0]!.error));
	assert.equal(expired[0]!.error.retryable, true);
});

test("an owner dropped while sends wait keeps them waiting for its host session, not routed on (#4639)", () => {
	vi.useFakeTimers();
	const { children, expired } = departed();
	depart(children);
	children.admit(CHILD, sender("sender"), send("m1"), true);

	assert.deepEqual(children.dropOwner(OWNER, HOST), []);
	assert.equal(children.heldSendCount, 1);
	vi.advanceTimersByTime(DEPARTED_CHILD_HOLD_MS);

	assert.deepEqual(
		expired.map(({ held }) => held.messageId),
		["m1"],
	);
});

test("the owner's host session coming back takes over its subagents' answers and the sends held for them (#4639)", () => {
	const { children } = departed();
	depart(children);
	children.admit(CHILD, sender("sender"), send("m1"), true);
	children.dropOwner(OWNER, HOST);

	assert.deepEqual(children.adoptOrphans(NEW_OWNER, HOST), []);
	assert.equal(children.orphanCount, 0);
	const marked = children.mark(NEW_OWNER, [ended(CHILD, "failed")]);

	assert.deepEqual(
		marked.refused.map(({ held, error }) => ({ id: held.messageId, code: error.code })),
		[{ id: "m1", code: "recipient_failed" }],
	);
	assert.deepEqual(children.sizes(), { departures: 1, byTarget: 3, byOwner: 1, heldSends: 0, timers: 0 });
	assert.deepEqual(children.registered(CHILD, new Set(["default"]), NEW_OWNER), []);
	assert.deepEqual(children.sizes(), { departures: 0, byTarget: 0, byOwner: 0, heldSends: 0, timers: 0 });
});

test("another host session cannot take over an owner's orphaned subagents (#4639)", () => {
	const { children } = departed();
	children.mark(OWNER, [ended()]);
	children.dropOwner(OWNER, HOST);

	children.adoptOrphans(NEW_OWNER, "another-host");

	assert.equal(children.orphanCount, 1);
	children.mark(NEW_OWNER, [ended(CHILD, "failed")]);
	const answer = children.admit(CHILD, sender("sender"), send("m1"), true);
	assert.ok(answer.kind === "refused" && answer.error.code === "recipient_completed");
});

test("a subagent the returning owner already knows keeps its own answer, and the orphan's held sends go on (#4639)", () => {
	const { children } = departed();
	depart(children);
	children.admit(CHILD, sender("sender"), send("m1"), true);
	children.dropOwner(OWNER, HOST);
	children.mark(NEW_OWNER, [ended(CHILD, "failed")]);

	const released = children.adoptOrphans(NEW_OWNER, HOST);

	assert.deepEqual(
		released.map((held) => held.messageId),
		["m1"],
	);
	assert.equal(children.size, 1);
	const answer = children.admit(CHILD, sender("sender"), send("m2"), true);
	assert.ok(answer.kind === "refused" && answer.error.code === "recipient_failed");
	assert.equal(children.heldSendCount, 0);
});

test("a run's end forgets the orphaned subagents of its groups and returns their held sends (#4639)", () => {
	const { children } = departed();
	depart(children);
	children.admit(CHILD, sender("sender"), send("m1"), true);
	children.dropOwner(OWNER, HOST);
	children.mark("other-owner", [{ ...ended("subagent-worker-elsewhere-1"), group: "elsewhere" }]);
	children.dropOwner("other-owner", "other-host");

	const released = children.dropOrphans((group) => group === "default");

	assert.deepEqual(
		released.map((held) => held.messageId),
		["m1"],
	);
	assert.equal(children.orphanCount, 1);
	assert.equal(children.size, 1);
});

test("orphaned subagents are bounded: the oldest is forgotten first and its held sends go on (#4639)", () => {
	vi.useFakeTimers();
	const bounded = new DepartedChildren(() => {}, DEPARTED_CHILD_HOLD_MS, 8, 2);
	for (const [index, owner] of ["o1", "o2"].entries())
		bounded.depart({ ownerSessionId: owner, childName: `subagent-worker-${index}-1`, group: "default", aliases: [] });
	bounded.admit("subagent-worker-0-1", sender("sender"), send("m1", "sender", "subagent-worker-0-1"), true);
	assert.deepEqual(bounded.dropOwner("o1", HOST), []);
	assert.deepEqual(bounded.dropOwner("o2", HOST), []);
	bounded.depart({ ownerSessionId: "o3", childName: "subagent-worker-2-1", group: "default", aliases: [] });

	const released = bounded.dropOwner("o3", HOST);

	assert.deepEqual(
		released.map((held) => held.messageId),
		["m1"],
	);
	assert.equal(bounded.orphanCount, 2);
	assert.equal(bounded.size, 2);
	bounded.clear();
	assert.deepEqual(bounded.sizes(), { departures: 0, byTarget: 0, byOwner: 0, heldSends: 0, timers: 0 });
});

test("an owner that returns under the Intercom id it had keeps its subagents without being re-keyed (#4639)", () => {
	const { children } = departed();
	children.mark(OWNER, [ended()]);
	children.dropOwner(OWNER, HOST);

	assert.deepEqual(children.adoptOrphans(OWNER, HOST), []);

	assert.equal(children.orphanCount, 0);
	assert.equal(children.size, 1);
	const answer = children.admit(CHILD, sender("sender"), send("m1"), true);
	assert.ok(answer.kind === "refused" && answer.error.code === "recipient_completed");
});

test("taking over orphans moves only the host session's subagents and leaves the old owner's others (#4639)", () => {
	const { children } = departed();
	children.depart({ ownerSessionId: OWNER, childName: "subagent-worker-live-1", group: "default", aliases: [] });
	children.depart({ ownerSessionId: OWNER, childName: CHILD, group: "default", aliases: [], ownerHostSession: HOST });
	assert.equal(children.sizes().byOwner, 1);

	children.adoptOrphans(NEW_OWNER, HOST);

	assert.equal(children.sizes().byOwner, 2);
	assert.equal(children.dropOwner(NEW_OWNER).length, 0);
	assert.equal(children.size, 1, "the new owner's answer went with it");
	assert.equal(children.admit("subagent-worker-live-1", sender("sender"), send("m1"), true).kind, "held");
	assert.equal(children.dropOwner(OWNER).length, 1, "the old owner still owns what stayed with it");
	assert.deepEqual(children.sizes(), { departures: 0, byTarget: 0, byOwner: 0, heldSends: 0, timers: 0 });
});

test("an owner back with more subagents than it may keep forgets its oldest, and one at the limit forgets none (#4639)", () => {
	const bounded = new DepartedChildren(() => {}, DEPARTED_CHILD_HOLD_MS, 2);
	bounded.depart({ ownerSessionId: NEW_OWNER, childName: "subagent-worker-known-1", group: "default", aliases: [] });
	bounded.admit("subagent-worker-known-1", sender("sender"), send("m1", "sender", "subagent-worker-known-1"), true);
	bounded.depart({ ownerSessionId: OWNER, childName: CHILD, group: "default", aliases: [], ownerHostSession: HOST });

	assert.deepEqual(bounded.adoptOrphans(NEW_OWNER, HOST), [], "two subagents are at the limit of two");
	assert.equal(bounded.size, 2);

	bounded.depart({
		ownerSessionId: "o3",
		childName: "subagent-worker-3-1",
		group: "default",
		aliases: [],
		ownerHostSession: HOST,
	});
	const released = bounded.adoptOrphans(NEW_OWNER, HOST);

	assert.deepEqual(
		released.map((held) => held.messageId),
		["m1"],
	);
	assert.equal(bounded.size, 2);
	bounded.clear();
});

test("a departure that adds an orphan beyond the bound returns the sends of the one it forgets (#4639)", () => {
	const bounded = new DepartedChildren(() => {}, DEPARTED_CHILD_HOLD_MS, 8, 1);
	bounded.depart({ ownerSessionId: "o1", childName: CHILD, group: "default", aliases: [], ownerHostSession: HOST });
	bounded.admit(CHILD, sender("sender"), send("m1"), true);

	const released = bounded.depart({
		ownerSessionId: "o2",
		childName: "subagent-worker-2-1",
		group: "default",
		aliases: [],
		ownerHostSession: HOST,
	});

	assert.deepEqual(
		released.map((held) => held.messageId),
		["m1"],
	);
	assert.equal(bounded.orphanCount, 1);
	bounded.clear();
});

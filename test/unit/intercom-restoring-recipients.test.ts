import assert from "node:assert/strict";
import type net from "node:net";
import { afterEach, test, vi } from "vitest";
import { type HeldSend, RestoringRecipients } from "../../packages/intercom/broker/restoring-recipients.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

afterEach(() => {
	vi.useRealTimers();
});

const CHILD = "subagent-worker-run1-1";

function sender(id: string, groups: string[] = ["default"]): { id: string; info: SessionInfo } {
	return { id, info: { id, cwd: "/repo", model: "m", pid: 1, startedAt: 1, lastActivity: 1, groups } };
}

function send(messageId: string, senderId: string, to = CHILD): HeldSend {
	return { socket: {} as net.Socket, senderId, messageId, clientMessage: { type: "send", to } };
}

test("a send held for a subagent that does not come back within 20 seconds is told to try again, not Session not found (#3760)", () => {
	vi.useFakeTimers();
	const expired: Array<{ messageId: string; reason: string }> = [];
	const recipients = new RestoringRecipients((held, reason) => expired.push({ messageId: held.messageId, reason }));
	recipients.reserve("capability", "owner", CHILD, "default", []);

	const held = send("held-1", "third-party");
	assert.deepEqual(recipients.admit("Subagent-Worker-Run1-1", sender("third-party"), held, true), {
		kind: "held",
		timeoutMs: 20_000,
	});
	vi.advanceTimersByTime(19_999);
	assert.equal(expired.length, 0);
	vi.advanceTimersByTime(1);
	assert.equal(expired.length, 1);
	assert.equal(expired[0]!.messageId, "held-1");
	assert.match(expired[0]!.reason, /`subagent-worker-run1-1` is still being restored after the restart.*try again/);
	assert.doesNotMatch(expired[0]!.reason, /Session not found/);

	const legacy = recipients.admit(CHILD, sender("old-client"), send("legacy-1", "old-client"), false);
	assert.equal(legacy.kind, "refused", "a client that cannot wait past its own timeout is answered at once");
	assert.match(legacy.kind === "refused" ? legacy.reason : "", /still being restored.*try again/);
	assert.deepEqual(recipients.consume("capability"), [], "an expired send is never delivered later as well");
});

test("only senders that could reach the restored subagent, or its owner, are held for it (#3760)", () => {
	const recipients = new RestoringRecipients(() => {});
	recipients.reserve("capability", "owner", CHILD, "lane-group", []);
	assert.deepEqual(recipients.admit(CHILD, sender("outsider"), send("outside-1", "outsider"), true), {
		kind: "none",
	});
	assert.equal(recipients.admit(CHILD, sender("peer", ["lane-group"]), send("peer-1", "peer"), true).kind, "held");
	assert.equal(recipients.admit(CHILD, sender("owner"), send("owner-1", "owner"), true).kind, "held");
	assert.deepEqual(
		recipients.consume("capability").map((held) => held.messageId),
		["peer-1", "owner-1"],
		"held sends are handed back in the order they arrived",
	);
});

test("a dormant owner's reservation is handed to the supervisor that restores the child, keeping every held send once and in order (#3760)", () => {
	const recipients = new RestoringRecipients(() => {});
	recipients.reserve("dormant-capability", "launching-session", CHILD, "workflow:run", ["stage-session-id"], {
		dormant: true,
	});
	assert.equal(
		recipients.admit(CHILD, sender("third", ["workflow:run"]), send("before-1", "third"), true).kind,
		"held",
	);
	assert.equal(
		recipients.admit(
			"stage-session-id",
			sender("third", ["workflow:run"]),
			send("before-2", "third", "stage-session-id"),
			true,
		).kind,
		"held",
	);

	// The resumed stage's own connection reserves the same child under its own capability.
	recipients.reserve("stage-capability", "stage-session", CHILD, "workflow:run", ["previous-intercom-id"]);
	assert.equal(
		recipients.admit(CHILD, sender("third", ["workflow:run"]), send("after-1", "third"), true).kind,
		"held",
	);
	assert.deepEqual(
		recipients.release("dormant-capability", "launching-session", undefined),
		undefined,
		"the dormant owner no longer holds anything for this child once the stage took it over",
	);
	assert.equal(
		recipients.admit(
			"previous-intercom-id",
			sender("third", ["workflow:run"]),
			send("after-2", "third", "previous-intercom-id"),
			true,
		).kind,
		"held",
		"the stage's reservation covers the dormant owner's targets and its own",
	);
	assert.deepEqual(
		recipients.consume("stage-capability").map((held) => held.messageId),
		["before-1", "before-2", "after-1", "after-2"],
		"nothing held before, during or after the handover is lost or repeated",
	);
	assert.deepEqual(recipients.consume("dormant-capability"), []);
});

test("only a dormant reservation can be taken over by another supervisor of the same child and group (#3760)", () => {
	const recipients = new RestoringRecipients(() => {});
	recipients.reserve("live-capability", "restoring-owner", CHILD, "workflow:run", []);
	assert.equal(recipients.admit(CHILD, sender("third", ["workflow:run"]), send("held-1", "third"), true).kind, "held");
	recipients.reserve("rival-capability", "rival-owner", CHILD, "workflow:run", []);
	assert.deepEqual(
		recipients.consume("rival-capability"),
		[],
		"a live reservation keeps its held sends when another session reserves the same name",
	);
	assert.deepEqual(
		recipients.consume("live-capability").map((held) => held.messageId),
		["held-1"],
	);

	recipients.reserve("dormant-capability", "launching-session", CHILD, "workflow:run", [], { dormant: true });
	assert.equal(recipients.admit(CHILD, sender("third", ["workflow:run"]), send("held-2", "third"), true).kind, "held");
	recipients.reserve("elsewhere-capability", "other-owner", CHILD, "another-group", []);
	assert.deepEqual(
		recipients.consume("elsewhere-capability"),
		[],
		"a reservation for the same name in another group does not take over a dormant one",
	);
	assert.deepEqual(
		recipients.release("dormant-capability", "launching-session", undefined)?.held.map((held) => held.messageId),
		["held-2"],
	);
});

test("an owner that ends a hold with a refusal gives its held senders that reason and leaves no gone marker (#3760)", () => {
	const recipients = new RestoringRecipients(() => {});
	recipients.reserve("capability", "owner", CHILD, "default", [], { dormant: true });
	assert.equal(recipients.admit(CHILD, sender("third"), send("held-1", "third"), true).kind, "held");
	const released = recipients.release("capability", "owner", undefined, "resumed in another Atomic session");
	assert.deepEqual(
		released?.held.map((held) => held.messageId),
		["held-1"],
	);
	assert.equal(released?.refusal, "resumed in another Atomic session");
	assert.equal(released?.gone, undefined);
	assert.deepEqual(
		recipients.admit(CHILD, sender("third"), send("later-1", "third"), true),
		{ kind: "none" },
		"later sends are routed normally instead of being told the child is gone",
	);
});

test("a dormant reservation the restoring stage never replaced ends with the child's registration, delivering what it held once (#3760)", () => {
	const recipients = new RestoringRecipients(() => {});
	recipients.reserve("dormant-capability", "launching-session", CHILD, "workflow:run", [], { dormant: true });
	assert.equal(recipients.admit(CHILD, sender("third", ["workflow:run"]), send("held-1", "third"), true).kind, "held");
	assert.deepEqual(
		recipients
			.consume("stage-capability-never-reserved", { childName: CHILD, groups: new Set(["workflow:run"]) })
			.map((held) => held.messageId),
		["held-1"],
	);
	assert.deepEqual(recipients.admit(CHILD, sender("third", ["workflow:run"]), send("later", "third"), true), {
		kind: "none",
	});
});

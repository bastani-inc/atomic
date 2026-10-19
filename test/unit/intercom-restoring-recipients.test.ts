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

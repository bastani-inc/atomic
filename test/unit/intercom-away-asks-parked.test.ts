import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { AwayAsks } from "../../packages/intercom/broker/away-asks.js";
import type { SessionInfo } from "../../packages/intercom/types.js";

/**
 * #4992: the durable file a broker keeps for away sessions also links a released subagent's session to its owner, so
 * the asks to it end with the owner, and a message held for a released subagent wakes it, after a restart too.
 */

const NOW = 1_000;
const reason = (name: string, id: string) => `Session "${name || id}" ended before replying`;
const replier: SessionInfo = {
	id: "replier",
	name: "replier",
	cwd: "/",
	model: "m",
	pid: 1,
	startedAt: 0,
	lastActivity: 0,
};

function store(path?: string): AwayAsks {
	return new AwayAsks(path, () => NOW);
}

test("an owner leaving fails each kept ask to its released subagents once, with a message held for its asker (#4992)", () => {
	const away = store();
	away.park("owner", " Worker ", "worker-session");
	away.park("owner", "other", "other-session");
	away.park("another-owner", "worker", "foreign-session");
	away.keep([{ messageId: "q1", senderSessionId: "asker", targetSessionId: "worker-session" }], "asker-address");
	away.keep([{ messageId: "q2", senderSessionId: "asker-2", targetSessionId: "other-session" }], "asker-2-address");
	away.keep([{ messageId: "q3", senderSessionId: "asker", targetSessionId: "foreign-session" }], "asker-address");
	// An asker that kept no return address cannot be told: its ask still ends with the owner.
	away.keep([{ messageId: "q4", senderSessionId: "nobody", targetSessionId: "worker-session" }]);

	const failed = away.failParked("owner", undefined, reason, "ended");
	assert.deepEqual(
		failed.map(({ askerSessionId, askerReturnAddress, from, message }) => ({
			askerSessionId,
			askerReturnAddress,
			from,
			replyTo: message.replyTo,
			replyError: message.replyError,
			text: message.content.text,
		})),
		[
			{
				askerSessionId: "asker",
				askerReturnAddress: "asker-address",
				from: {
					id: "worker-session",
					name: " Worker ",
					cwd: "",
					model: "",
					pid: 0,
					startedAt: 0,
					lastActivity: NOW,
				},
				replyTo: "q1",
				replyError: 'Session " Worker " ended before replying',
				text: 'Session " Worker " ended before replying',
			},
			{
				askerSessionId: "asker-2",
				askerReturnAddress: "asker-2-address",
				from: { id: "other-session", name: "other", cwd: "", model: "", pid: 0, startedAt: 0, lastActivity: NOW },
				replyTo: "q2",
				replyError: 'Session "other" ended before replying',
				text: 'Session "other" ended before replying',
			},
		],
	);
	assert.ok(failed.every((held) => held.message.id.startsWith("ended:")));
	assert.deepEqual(
		away.held("asker-address").map((held) => held.message.replyTo),
		["q1"],
		"held until the asker saves it",
	);
	assert.deepEqual(away.failParked("owner", undefined, reason, "ended"), [], "failed once");
	assert.equal(away.question("q4", "worker-session"), undefined, "the unaddressed ask ended too");
	// Another owner's subagent keeps its ask.
	assert.equal(away.failParked("another-owner", undefined, reason, "ended").length, 1);
});

test("an owner dropping one released subagent fails only that subagent's kept asks (#4992)", () => {
	const away = store();
	away.park("owner", "Worker", "worker-session");
	away.park("owner", "other", "other-session");
	away.keep([{ messageId: "q1", senderSessionId: "asker", targetSessionId: "worker-session" }], "asker-address");
	away.keep([{ messageId: "q2", senderSessionId: "asker", targetSessionId: "other-session" }], "asker-address");

	// The name is matched as the owner reserved it, whatever its case or padding.
	assert.deepEqual(
		away.failParked("owner", "  wORKER ", reason, "ended").map((held) => held.message.replyTo),
		["q1"],
	);
	assert.deepEqual(
		away.failParked("owner", undefined, reason, "ended").map((held) => held.message.replyTo),
		["q2"],
	);
});

test("the owner link outlives the broker, so an owner leaving after a restart still fails the kept asks (#4992)", () => {
	const path = join(mkdtempSync(join(tmpdir(), "away-parked-")), "away.sqlite");
	const first = store(path);
	first.park("owner", "worker", "worker-session");
	first.keep([{ messageId: "q1", senderSessionId: "asker", targetSessionId: "worker-session" }], "asker-address");
	first.close();
	const next = store(path);
	assert.deepEqual(
		next.failParked("owner", undefined, reason, "ended").map((held) => held.message.replyTo),
		["q1"],
	);
	next.close();
});

test("a message held for a released subagent wakes it through its owner until the subagent is back (#4992)", () => {
	const away = store();
	const woken: string[] = [];
	away.onHeldForReleasedAsker((owner, childName) => woken.push(`${owner}/${childName}`));
	away.keepReleasedAsker("", "owner", "nameless");
	assert.equal(away.releasedAsker(""), undefined, "a subagent with no return address cannot be woken for it");
	away.keepReleasedAsker("child-address", "owner", "Worker");
	assert.deepEqual(away.releasedAsker("child-address"), { ownerSessionId: "owner", childName: "Worker" });
	assert.equal(away.hasHeldForReleasedAsker("owner", " worker "), false, "nothing held yet");

	const question = {
		messageId: "q1",
		senderSessionId: "child",
		targetSessionId: "replier",
		senderReturnAddress: "child-address",
	};
	away.hold(question, replier, { id: "reply-1", timestamp: 1, replyTo: "q1", content: { text: "8080" } });
	assert.deepEqual(woken, ["owner/Worker"]);
	assert.equal(away.hasHeldForReleasedAsker("owner", " worker "), true);
	assert.equal(away.hasHeldForReleasedAsker("another-owner", "worker"), false);
	assert.equal(away.hasHeldForReleasedAsker("owner", "other"), false);

	// A message held for a session that is not a released subagent wakes nobody.
	away.hold(
		{ ...question, messageId: "q2", senderSessionId: "asker", senderReturnAddress: "asker-address" },
		replier,
		{
			id: "reply-2",
			timestamp: 1,
			replyTo: "q2",
			content: { text: "9090" },
		},
	);
	assert.deepEqual(woken, ["owner/Worker"]);

	away.forgetReleasedAsker(undefined);
	away.forgetReleasedAsker("child-address");
	assert.equal(away.releasedAsker("child-address"), undefined);
	assert.equal(away.hasHeldForReleasedAsker("owner", "worker"), false);
});

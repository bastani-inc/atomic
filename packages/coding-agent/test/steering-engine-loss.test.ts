import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { setSubagentChatQueueSink } from "../src/modes/interactive/subagent-chat-queue-report.js";
import { stripAnsi } from "../src/utils/ansi.js";
import { createGate, createRig, holdTool, type Rig, releaseOpenGates, waitFor } from "./helpers/busy-submission-rig.js";
import { pressAltEnter } from "./helpers/interactive-submission-host.js";
import { type SubagentSteeringChat, subagentChat, userTexts } from "./helpers/steering-chats.js";

/**
 * An isolated engine that crashes takes its queue with it. The main chat gives its queued messages back to its editor
 * with a notice; a subagent chat the engine drew went down with it, so the main chat lists its queued messages in full.
 * Nothing is sent twice.
 */

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	releaseOpenGates();
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The queue the engine last listed to the host, as `steering|…/followUp|…`. */
function listed(rig: Rig): string {
	return `${rig.host.session.getSteeringMessages().join("|")}/${rig.host.session.getFollowUpMessages().join("|")}`;
}

/**
 * The main chat on an isolated engine whose turn holds in a tool round until `finishTurn`. With `holdAnswer`, the
 * answer to the first message delivered after that round also waits until it is released.
 */
async function mainChatOnEngine(
	options: { holdAnswer?: Promise<void> } = {},
): Promise<{ rig: Rig; finishTurn: () => void; rows: () => string[] }> {
	const toolHold = createGate();
	const rig = await createRig("isolated", "quiet", { tools: [holdTool(toolHold)] });
	cleanups.push(() => rig.stop());
	Object.assign(rig.host, { isInitialized: true, footer: { invalidate() {} }, programStatus: { handleEvent() {} } });
	const handleEvent: (this: Rig["host"], event: object) => Promise<void> = Reflect.get(
		InteractiveMode.prototype,
		"handleEvent",
	);
	rig.host.session.subscribe((event) => {
		if (event.type === "queue_update") void handleEvent.call(rig.host, event);
	});
	const attach: (this: Rig["host"]) => () => void = Reflect.get(
		InteractiveMode.prototype,
		"attachSteeringEngineRecovery",
	);
	cleanups.push(attach.call(rig.host));
	const holdAnswer = options.holdAnswer;
	rig.engine.setResponses([
		fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" }),
		holdAnswer
			? async () => {
					await holdAnswer;
					return fauxAssistantMessage("answer 1");
				}
			: fauxAssistantMessage("answer 1"),
		...Array.from({ length: 6 }, (_, index) => fauxAssistantMessage(`answer ${index + 2}`)),
	]);
	await rig.host.defaultEditor.onSubmit?.("first");
	await toolHold.entered.promise;
	await waitFor("the host to see the engine work", () => rig.host.session.isStreaming);
	const rows = () =>
		rig.host.pendingMessagesContainer
			.render(120)
			.map((line) => stripAnsi(line).trim())
			.filter((line) => /^(Steering|Follow-up): /.test(line));
	return { rig, finishTurn: () => toolHold.release.resolve(), rows };
}

test("a crashed engine's queued messages come back to the main chat's editor, steering first, with a notice", async () => {
	const { rig, finishTurn, rows } = await mainChatOnEngine();
	await rig.host.defaultEditor.onSubmit?.("steer alpha");
	await rig.host.defaultEditor.onSubmit?.("steer beta");
	await pressAltEnter(rig.host, "follow gamma");
	await waitFor(
		"the engine to list all three to the host",
		() => listed(rig) === "steer alpha|steer beta/follow gamma",
	);

	rig.host.editor.setText("half typed");
	rig.pair!.crash();
	finishTurn();
	await waitFor("the restore notice", () => rig.host.notices.some((notice) => notice.includes("Engine restarted")));

	assert.equal(rig.host.editor.getText(), "steer alpha\n\nsteer beta\n\nfollow gamma\n\nhalf typed");
	assert.deepEqual(rows(), [], "nothing is shown as queued any more");
	assert.deepEqual(
		rig.host.notices.filter((notice) => notice.includes("Engine restarted")),
		["warning: Engine restarted; 3 queued messages weren't sent and are back in the editor"],
	);
	await rig.pair!.drain();
	assert.deepEqual(userTexts(rig.engine), ["first"], "no queued message reached the model");
});

test("a message the crashed engine already delivered is not given back, though the host still listed it", async () => {
	const answer = Promise.withResolvers<void>();
	cleanups.push(() => answer.resolve());
	const { rig, finishTurn, rows } = await mainChatOnEngine({ holdAnswer: answer.promise });
	await rig.host.defaultEditor.onSubmit?.("steer alpha");
	await rig.host.defaultEditor.onSubmit?.("steer beta");
	await waitFor("the engine to list both to the host", () => listed(rig) === "steer alpha|steer beta/");
	// The engine takes the first steer into its next request; the host never hears it did.
	rig.pair!.holdHostTrafficFrom(() => true);
	finishTurn();
	await waitFor("the engine to deliver the first steer", () => userTexts(rig.engine).includes("steer alpha"));
	assert.deepEqual(rows(), ["Steering: steer alpha", "Steering: steer beta"], "the host still lists both");

	// The engine dies while its model answers the first steer: the second is still in its queue.
	rig.pair!.crash();
	answer.resolve();
	await waitFor("the restore notice", () => rig.host.notices.some((notice) => notice.includes("Engine restarted")));

	assert.equal(rig.host.editor.getText(), "steer beta");
	assert.deepEqual(
		rig.host.notices.filter((notice) => notice.includes("Engine restarted")),
		["warning: Engine restarted; 1 queued message wasn't sent and is back in the editor"],
	);
	assert.equal(userTexts(rig.engine).filter((text) => text === "steer alpha").length, 1);
});

test("a deliberate engine stop gives nothing back", async () => {
	const { rig, rows } = await mainChatOnEngine();
	await rig.host.defaultEditor.onSubmit?.("steer alpha");
	await waitFor("the engine to list it to the host", () => listed(rig) === "steer alpha/");
	rig.pair!.endGeneration({ expected: true });
	await rig.pair!.drain();
	assert.deepEqual(rows(), ["Steering: steer alpha"], "the row stays as it was");
	assert.equal(rig.host.editor.getText(), "");
	assert.deepEqual(
		rig.host.notices.filter((notice) => notice.includes("Engine restarted")),
		[],
	);
});

test("a subagent chat lost with the engine has its queued messages listed in full in the main chat; none is sent", async () => {
	const { rig } = await mainChatOnEngine();
	cleanups.push(
		setSubagentChatQueueSink((report) =>
			rig.pair!.engineMessage({
				type: "engine_subagent_chat_queue",
				chatId: report.chatId,
				agent: report.agent,
				steering: [...report.steering],
				followUp: [...report.followUp],
			}),
		),
	);
	const chat: SubagentSteeringChat = await subagentChat();
	cleanups.push(() => chat.stop());
	await chat.startBusyTurn();
	await chat.enter("check the second file");
	await chat.enter("steer beta");
	await chat.followUp("follow gamma");
	await waitFor("the subagent to queue all three", () => chat.queuedRows().length === 4);

	rig.pair!.crash();
	await waitFor("the notice", () => rig.host.notices.some((notice) => notice.includes(" to worker ")));

	assert.deepEqual(
		rig.host.notices.filter((notice) => notice.includes(" to worker ")),
		[
			"warning: Engine restarted; 3 queued messages to worker weren't sent:\ncheck the second file\nsteer beta\nfollow gamma",
		],
	);
	assert.deepEqual(userTexts(chat.engine), ["first"], "nothing was sent to the subagent");
});

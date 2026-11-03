import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import {
	createRig,
	DUPLICATE_DELIVERY_SETTLE_MS,
	isIdleAfterAnswering,
	type Rig,
	releaseOpenGates,
	sleep,
	waitFor,
} from "./helpers/busy-submission-rig.ts";
import { pressAltEnter, showUserMessagesInChat } from "./helpers/interactive-submission-host.ts";
import { getUserTexts } from "./suite/harness.ts";

const MESSAGE = "sent as the turn ends";

describe.each(["local", "isolated"] as const)("a message submitted as the turn ends (%s host)", (wiring) => {
	const rigs: Rig[] = [];
	afterEach(async () => {
		releaseOpenGates();
		while (rigs.length > 0) await rigs.pop()?.stop();
	});

	test.each(["Enter", "Alt+Enter"] as const)("with %s is shown once and sent once (#4272)", async (key) => {
		const rig = await createRig(wiring, "quiet", {});
		rigs.push(rig);
		const chat = showUserMessagesInChat(rig.host);
		rig.engine.setResponses([
			fauxAssistantMessage("first answer"),
			fauxAssistantMessage("answer to the message"),
			fauxAssistantMessage("unexpected extra reply"),
		]);
		const submit = (): Promise<void> =>
			key === "Enter"
				? Promise.resolve(rig.host.defaultEditor.onSubmit?.(MESSAGE))
				: pressAltEnter(rig.host, MESSAGE);
		let submitted: Promise<void> | undefined;

		if (rig.pair) {
			// The engine ends and settles the turn while its agent_end is still on the way, so the host still shows
			// the agent working and routes the message as one typed during a turn.
			rig.pair.holdHostTrafficFrom((record) => record.type === "agent_end");
			await rig.host.defaultEditor.onSubmit?.("first question");
			await waitFor(
				"the engine to settle the turn",
				() => rig.engine.eventsOfType("agent_settled").length === 1 && isIdleAfterAnswering(rig.engine),
			);
			await rig.pair.drain();
			assert.equal(rig.host.session.isStreaming, true, "the host must not have seen the turn end yet");
			submitted = submit();
			await waitFor(
				"the engine to answer the message",
				() => getUserTexts(rig.engine).includes(MESSAGE) && isIdleAfterAnswering(rig.engine),
			);
			// The engine's answer to the prompt and the first events of the turn it started arrive in one read.
			await rig.pair.releaseHostTraffic();
		} else {
			// In-process, the message is typed the moment the host hears the turn end.
			rig.host.session.subscribe((event) => {
				if (event.type === "agent_end" && submitted === undefined) {
					setImmediate(() => {
						submitted = submit();
					});
				}
			});
			await rig.host.defaultEditor.onSubmit?.("first question");
			await waitFor(
				"the message to be answered",
				() => getUserTexts(rig.engine).includes(MESSAGE) && isIdleAfterAnswering(rig.engine),
			);
		}
		await submitted;
		if (rig.pair) await rig.pair.drain();
		await sleep(DUPLICATE_DELIVERY_SETTLE_MS);

		assert.deepEqual(getUserTexts(rig.engine), ["first question", MESSAGE], "the model must get the message once");
		assert.deepEqual(chat(), ["first question", MESSAGE], "the chat must show the message once");
		assert.deepEqual(
			Reflect.get(rig.host, "deferredRenderedUserInputs"),
			[],
			"no echo of the message may be left to show again",
		);
		assert.deepEqual(rig.host.notices, [], "a notice was shown for an accepted message");
	});
});

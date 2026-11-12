import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import type { ExtensionFactory } from "../../packages/coding-agent/src/core/extensions/index.js";
import { stripAnsi } from "../../packages/coding-agent/src/utils/ansi.js";
import type { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { createStageSkillFixture, submitStageSkillText } from "../fixtures/stage-chat-skill-session.js";

const TYPED = "typed while busy";

/** An `input` hook that holds TYPED until released, as a stage busy with other work delays it. */
function slowInputHook(entered: PromiseWithResolvers<void>, release: Promise<void>): ExtensionFactory {
	return (pi) => {
		pi.on("input", async (event) => {
			if (event.text !== TYPED) return { action: "continue" };
			entered.resolve();
			await release;
			return { action: "continue" };
		});
	};
}

function queuedRows(view: StageChatView): string[] {
	return view
		.render(120)
		.map((line) => stripAnsi(line).trim())
		.filter((line) => line.startsWith("Steering:") || line.startsWith("Follow-up:"));
}

/** Start a turn that stays open until `release` resolves, so input typed meanwhile queues. */
async function holdStage(fixture: Awaited<ReturnType<typeof createStageSkillFixture>>, release: Promise<void>) {
	const started = Promise.withResolvers<void>();
	fixture.stage.appendResponses([
		async () => {
			started.resolve();
			await release;
			return fauxAssistantMessage("Hold released.");
		},
		fauxAssistantMessage("Queued message acknowledged."),
	]);
	const turn = fixture.handle.sendUserMessage!("Hold the stage.");
	await started.promise;
	return { turn };
}

const lanes = [
	{ lane: "steering", key: "\r", row: `Steering: ${TYPED}`, queue: "getSteeringMessages" },
	{ lane: "follow-up", key: "\x06", row: `Follow-up: ${TYPED}`, queue: "getFollowUpMessages" },
] as const;

for (const { lane, key, row, queue } of lanes) {
	test(`a stage chat shows a ${lane} message as queued at submit, before the stage confirms it (#4696)`, async () => {
		const entered = Promise.withResolvers<void>();
		const releaseInput = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		const fixture = await createStageSkillFixture({
			extensionFactories: [slowInputHook(entered, releaseInput.promise)],
		});
		let turn: Promise<unknown> | undefined;
		try {
			({ turn } = await holdStage(fixture, releaseTurn.promise));
			const view = fixture.mount();

			submitStageSkillText(view, TYPED, key);
			assert.deepEqual(queuedRows(view), [row], "the row must be there in the frame that clears the composer");

			await entered.promise;
			assert.deepEqual(fixture.stage.session[queue](), [], "the stage has not queued it yet");
			assert.deepEqual(queuedRows(view), [row]);

			releaseInput.resolve();
			await vi.waitFor(() => assert.deepEqual(fixture.stage.session[queue](), [TYPED]));
			assert.deepEqual(queuedRows(view), [row], "the confirmed message is listed once");
		} finally {
			releaseInput.resolve();
			releaseTurn.resolve();
			await turn;
			await fixture.cleanup();
		}
	});
}

test("a stage chat stops showing a refused message as queued and gives it back to the composer (#4696)", async () => {
	const releaseTurn = Promise.withResolvers<void>();
	const fixture = await createStageSkillFixture();
	let turn: Promise<unknown> | undefined;
	try {
		({ turn } = await holdStage(fixture, releaseTurn.promise));
		const view = fixture.mount();
		const refuse = Promise.withResolvers<void>();
		const session = fixture.stage.session;
		const prompt = session.prompt.bind(session);
		session.prompt = async (text, options) => {
			if (text !== TYPED) return prompt(text, options);
			await refuse.promise;
			throw new Error("the stage refused the message");
		};

		submitStageSkillText(view, TYPED, "\r");
		assert.deepEqual(queuedRows(view), [`Steering: ${TYPED}`]);

		refuse.resolve();
		await vi.waitFor(() => assert.deepEqual(queuedRows(view), []));
		const rendered = view
			.render(120)
			.map((line) => stripAnsi(line))
			.join("\n");
		assert.match(rendered, /the stage refused the message/);
		assert.match(rendered, new RegExp(`❯ ${TYPED}`), "the message is back in the composer");
	} finally {
		releaseTurn.resolve();
		await turn;
		await fixture.cleanup();
	}
});

import assert from "node:assert/strict";
import { createSyntheticSourceInfo, type PromptTemplate } from "@bastani/atomic";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { test, vi } from "vitest";
import type { StageControlHandle } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createStageSkillFixture, submitStageSkillText } from "../fixtures/stage-chat-skill-session.js";

// The stage composer expands only `/skill:` commands; every other submission reaches the
// stage literally, whether the stage was idle, streaming, or still preparing a turn.
const reviewTemplate: PromptTemplate = {
	name: "review",
	description: "Review template",
	content: "Review this code: $1",
	filePath: "/virtual/review.md",
	sourceInfo: createSyntheticSourceInfo("/virtual/review.md", {
		source: "local",
		scope: "temporary",
		origin: "top-level",
	}),
};

function assertNothingExpanded(texts: readonly string[]): void {
	assert.deepEqual(
		texts.filter((text) => text.startsWith("Review this code")),
		[],
	);
}

test("typed template-like text reaches a streaming stage literally, as it does an idle one", async () => {
	const fixture = await createStageSkillFixture({ prompts: [reviewTemplate] });
	const started = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let streaming: Promise<unknown> | undefined;
	try {
		fixture.stage.appendResponses([
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("Hold released.");
			},
			fauxAssistantMessage("Steer acknowledged."),
			fauxAssistantMessage("Follow-up acknowledged."),
			fauxAssistantMessage("Continued."),
			fauxAssistantMessage("Idle acknowledged."),
		]);
		streaming = fixture.handle.sendUserMessage!("Hold the stage.");
		await started.promise;
		const view = fixture.mount();
		submitStageSkillText(view, "/review steer.ts");
		await vi.waitFor(() => assert.equal(fixture.stage.session.getSteeringMessages().length, 1));
		submitStageSkillText(view, "/review follow.ts", "\x06");
		await vi.waitFor(() => assert.equal(fixture.stage.session.getFollowUpMessages().length, 1));
		assert.deepEqual(fixture.stage.session.getSteeringMessages(), ["/review steer.ts"]);
		assert.deepEqual(fixture.stage.session.getFollowUpMessages(), ["/review follow.ts"]);
		release.resolve();
		await streaming;
		await vi.waitFor(() => assert.equal(fixture.stage.session.isStreaming, false));

		submitStageSkillText(view, "/review idle.ts");
		await vi.waitFor(() => assert.ok(fixture.userTexts().includes("/review idle.ts")));
		for (const text of ["/review steer.ts", "/review follow.ts"]) assert.ok(fixture.userTexts().includes(text));
		assertNothingExpanded(fixture.userTexts());
	} finally {
		release.resolve();
		await streaming;
		await fixture.cleanup();
	}
});

test("text typed while the stage is still preparing its turn reaches it literally", async () => {
	const preflight = Promise.withResolvers<void>();
	const releasePreflight = Promise.withResolvers<void>();
	const fixture = await createStageSkillFixture({
		prompts: [reviewTemplate],
		extensionFactories: [
			(pi) => {
				pi.on("input", async (event) => {
					if (event.text !== "Prepare slowly.") return;
					preflight.resolve();
					await releasePreflight.promise;
				});
			},
		],
	});
	try {
		fixture.stage.appendResponses([
			fauxAssistantMessage("Prepared."),
			fauxAssistantMessage("Steer read."),
			fauxAssistantMessage("Continued."),
		]);
		// Records what the chat hands the stage, so the slow turn is released only once it has.
		const submitted: string[] = [];
		const target = fixture.handle;
		const handle: StageControlHandle = Object.create(target);
		handle.sendUserMessage = (text, options, beforeDelivery) => {
			submitted.push(text);
			return target.sendUserMessage!(text, options, beforeDelivery);
		};
		handle.steer = (text) => {
			submitted.push(text);
			return target.steer(text);
		};
		const view = fixture.mount({ handle });
		submitStageSkillText(view, "Prepare slowly.");
		await preflight.promise;
		assert.equal(fixture.stage.session.isStreaming, false);
		submitStageSkillText(view, "/review preparing.ts");
		await vi.waitFor(() => assert.ok(submitted.includes("/review preparing.ts")));
		releasePreflight.resolve();
		await vi.waitFor(() => assert.ok(fixture.userTexts().some((text) => text.includes("preparing.ts"))));
		assert.ok(fixture.userTexts().includes("/review preparing.ts"));
		assertNothingExpanded(fixture.userTexts());
	} finally {
		releasePreflight.resolve();
		await fixture.cleanup();
	}
});

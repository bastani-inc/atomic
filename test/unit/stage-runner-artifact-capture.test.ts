import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import {
	createHarness,
	createHarnessWithExtensions,
	fauxModel,
} from "../../packages/coding-agent/test/test-harness.js";
import {
	createStageContext,
	type StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { StageSessionController } from "../../packages/workflows/src/runs/foreground/stage-runner-controller.js";
import { readText, removePathSync } from "../helpers/runtime.js";
import { assistantMessageWithUsage, makeMockSession } from "./stage-runner-helpers.js";

const usage = { input: 950, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 };

test("artifact answers survive real pre-prompt compaction and later compaction", async () => {
	let compactions = 0;
	const report = "Current report; no history should enter the artifact.";
	const clarification = "Material clarification after compaction.";
	const harness = await createHarnessWithExtensions({
		settings: {
			compaction: { enabled: true, reserveTokens: 100, preserve_recent: 2 },
			retry: { enabled: false },
			sessionSummary: { enabled: false },
		},
		model: { ...fauxModel, contextWindow: 1000, maxTokens: 100 },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => {
					compactions += 1;
					return { compactedText: "[User]: old context compacted" };
				});
			},
		],
		responses: [
			{ text: report, usage: { input: 10, output: 10 } },
			{ text: clarification, usage: { input: 10, output: 10 } },
		],
	});
	await harness.session.bindExtensions({});
	for (let index = 0; index < 5; index += 1) {
		harness.sessionManager.appendMessage({
			role: "user",
			content: `Old question ${index}: ${"context\n".repeat(30)}`,
			timestamp: Date.now(),
		});
		const historicalAnswer = assistantMessageWithUsage(`Old answer ${index}: ${"history\n".repeat(30)}`, usage);
		assert.ok(historicalAnswer.role === "assistant");
		harness.sessionManager.appendMessage(historicalAnswer);
	}
	harness.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	assert.equal(harness.session.messages.length, 10);
	const output = join(harness.tempDir, "report.md");
	const context = createStageContext({
		stageId: "report",
		stageName: "report",
		runId: `capture-${harness.session.sessionId}`,
		adapters: {
			agentSession: {
				async create() {
					return harness.session as unknown as StageSessionRuntime;
				},
			},
		},
	});
	let transcriptPath: string | undefined;
	try {
		const receipt = await context.prompt("Return the report", { output, outputMode: "file-only" });
		transcriptPath = receipt.match(/^Transcript saved to: (.+) \([^\n]+\)\./m)?.[1];
		assert.ok(compactions > 0);
		assert.ok(harness.session.messages.length < 10);
		assert.equal(harness.session.getLastAssistantText(), report);
		assert.equal(await readText(output), report);
		await harness.session.compact({ preserve_recent: 0 });
		assert.equal(compactions, 2);
		assert.equal(harness.session.getLastAssistantText(), undefined);
		await context.__continuePrompt("Clarify the report");
		await context.__closeGeneration();
		assert.equal(await readText(output), `${report}\n\n## Supplement 1\n\n${clarification}`);
		assert.equal(await context.__closeGeneration(), context.getLastAssistantText());
	} finally {
		await context.__dispose();
		harness.cleanup();
		if (transcriptPath) removePathSync(transcriptPath, { force: true });
	}
});

test("continuation fallback retains accepted report but discards failed attempt answers", async () => {
	const harness = await createHarness();
	const output = join(harness.tempDir, "report.md");
	const report = "# Previously successful complete report";
	const clarification = "Material clarification from fallback";
	let primaryCalls = 0;
	const context = createStageContext({
		stageId: "report",
		stageName: "report",
		runId: `capture-fallback-${harness.session.sessionId}`,
		stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
		adapters: {
			agentSession: {
				async create(options) {
					const model =
						typeof options.model === "string" ? options.model : `${options.model?.provider}/${options.model?.id}`;
					const primary = model === "anthropic/primary";
					const messages: StageSessionRuntime["messages"] = [assistantMessageWithUsage("Restored history", usage)];
					return makeMockSession({
						messages,
						async prompt() {
							if (primary && ++primaryCalls > 1) {
								messages.push(assistantMessageWithUsage("Provisional failed answer", usage));
								throw new Error("429 rate limit exceeded");
							}
							messages.push(assistantMessageWithUsage(primary ? report : clarification, usage));
						},
					}).session;
				},
			},
		},
	});
	let transcriptPath: string | undefined;
	try {
		const receipt = await context.prompt("Report", { output, outputMode: "file-only" });
		transcriptPath = receipt.match(/^Transcript saved to: (.+) \([^\n]+\)\./m)?.[1];
		assert.equal(await readText(output), report);
		await context.__continuePrompt("Add the material clarification");
		await context.__closeGeneration();
		assert.equal(await readText(output), `${report}\n\n## Supplement 1\n\n${clarification}`);
		assert.equal(await context.__closeGeneration(), context.getLastAssistantText());
	} finally {
		await context.__dispose();
		harness.cleanup();
		if (transcriptPath) removePathSync(transcriptPath, { force: true });
	}
});

test("closed generation capture ignores retained chat and resets for the next authored generation", async () => {
	const report = "Original report";
	const replacement = "New authored report";
	const harness = await createHarnessWithExtensions({
		settings: { compaction: { enabled: false }, retry: { enabled: false }, sessionSummary: { enabled: false } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => ({ compactedText: "[User]: retained chat was compacted" }));
			},
		],
		responses: [
			report,
			...Array.from({ length: 8 }, (_, index) => `Later chat ${index}\n${"Context\n".repeat(100)}`),
			replacement,
		],
	});
	await harness.session.bindExtensions({});
	const options = {
		stageId: "closed-capture",
		stageName: "closed-capture",
		runId: `closed-capture-${harness.session.sessionId}`,
		adapters: {
			agentSession: {
				async create() {
					return harness.session as unknown as StageSessionRuntime;
				},
			},
		},
	};
	const controller = new StageSessionController(
		options,
		{ ...options, stageOptions: undefined },
		undefined,
		undefined,
	);
	try {
		controller.beginOutputGeneration();
		await controller.promptWithFallback("Report", undefined);
		await controller.closeGeneration();
		const captured = structuredClone(controller.outputGenerationMessages());
		assert.equal(captured.length, 1);
		for (let index = 0; index < 8; index += 1) await harness.session.sendUserMessage(`Later question ${index}`);
		assert.equal(harness.faux.callCount, 9);
		await harness.session.compact({ preserve_recent: 0 });
		assert.equal(harness.session.messages.filter((message) => message.role === "assistant").length, 0);
		assert.deepEqual(controller.outputGenerationMessages(), captured, "closed capture must not retain later chat");
		await controller.closeGeneration();
		assert.deepEqual(controller.outputGenerationMessages(), captured);
		controller.beginOutputGeneration();
		await controller.promptWithFallback("A new authored report", undefined);
		await controller.closeGeneration();
		assert.equal(controller.outputGenerationMessages().length, 1);
		assert.equal(controller.lastAssistantText(undefined), replacement);
		const answer = controller.outputGenerationMessages()[0];
		assert.ok(answer?.role === "assistant");
		assert.deepEqual(answer.content, [{ type: "text", text: replacement }]);
	} finally {
		await controller.disposeAll();
		harness.cleanup();
	}
});

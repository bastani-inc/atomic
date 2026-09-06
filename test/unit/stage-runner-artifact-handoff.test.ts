import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "vitest";
import { createHarness } from "../../packages/coding-agent/test/test-harness.js";
import {
	createStageContext,
	type StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { readText, removePathSync } from "../helpers/runtime.js";
import { assistantMessageWithUsage, makeMockSession } from "./stage-runner-helpers.js";

// The completed handoff is immutable even though its retained conversation is not.
test.each(["unrelated notice", "post-mortem acknowledgement"])(
	"repeated close and %s keep the completed artifact receipt",
	async (followUpKind) => {
		const report = "# Final report\n\nVerified findings and recommendations.";
		const acknowledgement = "Acknowledged the clarification.";
		const harness = await createHarness({
			settings: {
				compaction: { enabled: false },
				retry: { enabled: false },
				sessionSummary: { enabled: false },
			},
			responses: [report, acknowledgement],
		});
		const output = join(harness.tempDir, "report.md");
		const context = createStageContext({
			stageId: "report-stage",
			stageName: "report",
			runId: `artifact-handoff-${harness.session.sessionId}`,
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
			assert.ok(transcriptPath);
			assert.equal(await readText(output), report);
			await context.__closeGeneration();
			await context.__closeGeneration();
			assert.equal(context.getLastAssistantText(), receipt);

			if (followUpKind === "unrelated notice") {
				// A display-only entry changes message count without producing any result.
				await harness.session.sendCustomMessage(
					{
						customType: "artifact-test-notice",
						content: "Unrelated display-only notice",
						display: true,
					},
					{ triggerTurn: false },
				);
			} else {
				// Retained-session chat is not an implicit replacement of a handoff.
				await context.sendUserMessage("Explain the clarification after completion");
				assert.equal(harness.session.getLastAssistantText(), acknowledgement);
			}
			await context.__closeGeneration();
			await context.__closeGeneration();
			assert.equal(await readText(output), report);
			assert.equal(context.__getLastAssistantText(), receipt);
			assert.equal(context.getLastAssistantText(), receipt);
			assert.equal(harness.faux.callCount, followUpKind === "unrelated notice" ? 1 : 2);
		} finally {
			await context.__dispose();
			harness.cleanup();
			if (transcriptPath) removePathSync(transcriptPath, { force: true });
		}
	},
);

test("continuations retain equal answers in order; an authored prompt starts a replacement", async () => {
	const report = "  short result\n";
	const replacement = "Intentional replacement";
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false }, sessionSummary: { enabled: false } },
		responses: [report, report, replacement],
	});
	const output = join(harness.tempDir, "report.md");
	const context = createStageContext({
		stageId: "report",
		stageName: "report",
		runId: `handoff-${harness.session.sessionId}`,
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
		const initial = await context.prompt("Report", { output, outputMode: "file-only" });
		transcriptPath = initial.match(/^Transcript saved to: (.+) \([^\n]+\)\./m)?.[1];
		assert.equal(await readText(output), report);
		const continued = await context.__continuePrompt("Confirm the result");
		assert.equal(await readText(output), `${report}\n\n## Supplement 1\n\n${report}`);
		assert.equal(await context.__closeGeneration(), continued);
		assert.equal(await context.__closeGeneration(), continued);
		const revised = await context.prompt("Replace the report", { output, outputMode: "file-only" });
		assert.equal(await readText(output), replacement);
		assert.equal(await context.__closeGeneration(), revised);
	} finally {
		await context.__dispose();
		harness.cleanup();
		if (transcriptPath) removePathSync(transcriptPath, { force: true });
	}
});

test("a clarification drained during generation close is exported exactly once", async () => {
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false }, sessionSummary: { enabled: false } },
		responses: ["Report", "A much longer material clarification than the report"],
	});
	const output = join(harness.tempDir, "report.md");
	const session = harness.session as unknown as StageSessionRuntime;
	const originalClose = session.closeWorkflowStageGeneration?.bind(session);
	let drained = false;
	session.closeWorkflowStageGeneration = async () => {
		if (!drained) {
			drained = true;
			await harness.session.prompt("Admitted clarification");
		}
		await originalClose?.();
	};
	const context = createStageContext({
		stageId: "report",
		stageName: "report",
		runId: `handoff-${harness.session.sessionId}`,
		adapters: {
			agentSession: {
				async create() {
					return session;
				},
			},
		},
	});
	let transcriptPath: string | undefined;
	try {
		const initial = await context.prompt("Report", { output, outputMode: "file-only" });
		transcriptPath = initial.match(/^Transcript saved to: (.+) \([^\n]+\)\./m)?.[1];
		const final = await context.__closeGeneration();
		assert.notEqual(final, initial);
		assert.equal(
			await readText(output),
			"Report\n\n## Supplement 1\n\nA much longer material clarification than the report",
		);
		assert.equal(await context.__closeGeneration(), final);
		assert.equal(context.getLastAssistantText(), final);
		assert.equal(harness.faux.callCount, 2);
	} finally {
		await context.__dispose();
		harness.cleanup();
		if (transcriptPath) removePathSync(transcriptPath, { force: true });
	}
});

test("a fallback artifact excludes failed candidate answers and restored history", async () => {
	const harness = await createHarness();
	const output = join(harness.tempDir, "fallback.md");
	const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const context = createStageContext({
		stageId: "report",
		stageName: "report",
		runId: `fallback-${harness.session.sessionId}`,
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
							messages.push(
								assistantMessageWithUsage(primary ? "Failed candidate report" : "Fallback report", usage),
							);
							if (primary) throw new Error("429 rate limit exceeded");
							messages.push(assistantMessageWithUsage("Fallback clarification", usage));
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
		assert.equal(await readText(output), "Fallback report\n\n## Supplement 1\n\nFallback clarification");
		assert.deepEqual(context.__modelFallbackMeta().attemptedModels, ["anthropic/primary", "openai/fallback"]);
		assert.equal(await context.__closeGeneration(), receipt);
	} finally {
		await context.__dispose();
		harness.cleanup();
		if (transcriptPath) removePathSync(transcriptPath, { force: true });
	}
});

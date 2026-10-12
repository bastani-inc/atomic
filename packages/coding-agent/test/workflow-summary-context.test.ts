import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { injectWorkflowResumeSummary } from "../../workflows/src/extension/workflow-resume-summary.js";
import { convertToLlm } from "../src/core/messages.js";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness | undefined;
afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	vi.restoreAllMocks();
});

test("workflow summaries use the owning session credentials and stream without adding a turn", async () => {
	harness = await createHarness();
	const session = harness.session;
	vi.spyOn(session.modelRuntime, "getAuth").mockResolvedValue({
		auth: { apiKey: "workflow-key", baseUrl: "https://credential.example", headers: { "x-test": "summary" } },
	});
	const before = harness.sessionManager.getEntries().length;
	const expectedModel = session.model;
	let calls = 0;
	session.agent.streamFunction = async (model, context, options) => {
		calls++;
		assert.equal(model.baseUrl, "https://credential.example");
		assert.equal(model.id, expectedModel?.id);
		assert.equal(model.provider, expectedModel?.provider);
		assert.equal(options?.apiKey, "workflow-key");
		assert.equal(options?.headers?.["x-test"], "summary");
		assert.equal(context.tools?.length ?? 0, 0);
		assert.match(JSON.stringify(context.messages), /workflow objective/i);
		const stream = createAssistantMessageEventStream();
		stream.end({
			role: "assistant",
			content: [{ type: "text", text: "Build feature; tests underway." }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		return stream;
	};
	const ctx = session.extensionRunner.createContext();
	assert.equal(ctx.isSessionSummaryEnabled?.(), true);
	assert.equal(
		await ctx.generateWorkflowSummary?.("Objective: build feature", new AbortController().signal),
		"Build feature; tests underway.",
	);
	assert.equal(calls, 1);
	assert.equal(harness.sessionManager.getEntries().length, before);
	const controller = new AbortController();
	controller.abort();
	assert.equal(await ctx.generateWorkflowSummary?.("ignored", controller.signal), undefined);
	assert.equal(calls, 1);
	session.agent.streamFunction = async () => {
		throw new Error("provider unavailable");
	};
	assert.equal(await ctx.generateWorkflowSummary?.("failure", new AbortController().signal), undefined);
	vi.spyOn(session.settingsManager, "getSessionSummarySettings").mockReturnValue({ enabled: false });
	assert.equal(ctx.isSessionSummaryEnabled?.(), false);
	assert.equal(await ctx.generateWorkflowSummary?.("disabled", new AbortController().signal), undefined);
	assert.equal(calls, 1);
});

test("resumed workflow summary enters model context without starting a turn", async () => {
	harness = await createHarness();
	const session = harness.session;
	const ctx = session.extensionRunner.createContext();
	const pi = { sendMessage: session.sendCustomMessage.bind(session) };
	const run = {
		id: "resume-summary",
		name: "Feature workflow",
		inputs: {},
		status: "paused" as const,
		stages: [],
		startedAt: 1,
		summary: "Feature implemented; review remains",
		summarizedThrough: 1000,
	};
	await injectWorkflowResumeSummary(pi, ctx, run.id, run);
	await injectWorkflowResumeSummary(pi, ctx, run.id, run);
	const context = convertToLlm(session.messages);
	const text = JSON.stringify(context);
	assert.match(text, /Feature implemented; review remains/);
	assert.match(text, /1970-01-01T00:00:01.000Z/);
	assert.equal(session.messages.filter((message) => message.role === "custom").length, 1);
	assert.equal(harness.eventsOfType("agent_start").length, 0);
});

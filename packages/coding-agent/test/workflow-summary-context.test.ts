import assert from "node:assert/strict";
import { createAssistantMessageEventStream } from "@bastani/pi-ai";
import { afterEach, test, vi } from "vitest";
import { createInMemoryTestBackend } from "../../workflows/src/durable/factory.js";
import { injectWorkflowResumeSummary } from "../../workflows/src/extension/workflow-resume-summary.js";
import { createWorkflowSummaryService } from "../../workflows/src/extension/workflow-summary.js";
import { createStore } from "../../workflows/src/shared/store.js";
import { convertToLlm } from "../src/core/messages.js";
import { WORKFLOW_SUMMARY_SHUTDOWN_GRACE_MS } from "../src/core/workflow-summary-lifecycle.js";
import { createHarness, type Harness } from "./suite/harness.js";

let harness: Harness | undefined;
afterEach(async () => {
	await harness?.cleanup();
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

for (const responds of [true, false]) {
	test(`headless disposal after a stalled heartbeat ${responds ? "persists an admitted terminal summary" : "bounds a stalled terminal summary and rejects its late result"}`, async () => {
		harness = await createHarness();
		const session = harness.session;
		vi.spyOn(session.modelRuntime, "getAuth").mockResolvedValue({ auth: { apiKey: "workflow-key" } });
		let admitted!: () => void;
		const started = new Promise<void>((resolve) => {
			admitted = resolve;
		});
		let finish!: () => void;
		let signal: AbortSignal | undefined;
		let heartbeatAdmitted!: () => void;
		const heartbeatStarted = new Promise<void>((resolve) => {
			heartbeatAdmitted = resolve;
		});
		let heartbeatSignal: AbortSignal | undefined;
		let calls = 0;
		session.agent.streamFunction = async (model, _context, options) => {
			calls++;
			if (calls === 1) {
				heartbeatSignal = options?.signal;
				heartbeatAdmitted();
				return createAssistantMessageEventStream();
			}
			signal = options?.signal;
			const stream = createAssistantMessageEventStream();
			finish = () =>
				stream.end({
					role: "assistant",
					content: [{ type: "text", text: "Terminal work complete" }],
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
			admitted();
			return stream;
		};
		const store = createStore();
		const backend = createInMemoryTestBackend();
		backend.registerWorkflow({ workflowId: "terminal", name: "build", inputs: {}, status: "running", createdAt: 1 });
		store.recordRunStart({
			id: "terminal",
			name: "build",
			inputs: {},
			status: "running",
			stages: [],
			toolNodes: [],
			startedAt: 1,
		});
		const service = createWorkflowSummaryService({
			store,
			resolveContext: () => session.extensionRunner.createContext(),
			persist: async (id, summary, through) => {
				await backend.persistSummary!(id, summary, through);
			},
		});
		service.request("terminal");
		await heartbeatStarted;
		store.recordRunEnd("terminal", "completed");
		const startedAt = Date.now();
		const disposal = session.dispose();
		await started;
		assert.equal(heartbeatSignal?.aborted, true);
		assert.equal(calls, 2);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(signal?.aborted, false);
		if (responds) finish();
		await disposal;
		assert.ok(Date.now() - startedAt < WORKFLOW_SUMMARY_SHUTDOWN_GRACE_MS + 1500);
		if (responds) assert.equal(backend.getWorkflow("terminal")?.summary, "Terminal work complete");
		else {
			assert.ok(Date.now() - startedAt >= WORKFLOW_SUMMARY_SHUTDOWN_GRACE_MS);
			assert.equal(signal?.aborted, true);
			finish();
			await new Promise((resolve) => setTimeout(resolve, 20));
			assert.equal(backend.getWorkflow("terminal")?.summary, undefined);
		}
		service.dispose();
	});
}

test("a workflow resumed while streaming reaches the next provider request without an extra turn", async () => {
	harness = await createHarness();
	const session = harness.session;
	let admitted!: () => void;
	const started = new Promise<void>((resolve) => {
		admitted = resolve;
	});
	let finish!: () => void;
	const requests: string[] = [];
	session.agent.streamFunction = async (model, context) => {
		requests.push(JSON.stringify(context.messages));
		const stream = createAssistantMessageEventStream();
		const complete = () =>
			stream.end({
				role: "assistant",
				content: [{ type: "text", text: "Done" }],
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
		if (requests.length === 1) {
			finish = complete;
			admitted();
		} else complete();
		return stream;
	};
	const turn = session.prompt("Start foreground work");
	await started;
	const run = {
		id: "stream-resume",
		name: "Streaming workflow",
		inputs: {},
		status: "paused" as const,
		stages: [],
		startedAt: 1,
		summary: "Implementation done; review remains",
		summarizedThrough: 1000,
	};
	const ctx = session.extensionRunner.createContext();
	const pi = { sendMessage: session.sendCustomMessage.bind(session) };
	await injectWorkflowResumeSummary(pi, ctx, run.id, run);
	await injectWorkflowResumeSummary(pi, ctx, run.id, run);
	assert.equal(requests.length, 1);
	finish();
	await turn;
	assert.equal(requests.length, 1);
	await session.prompt("Continue with the resumed workflow");
	assert.equal(requests.length, 2);
	assert.match(requests[1], /Implementation done; review remains/);
	assert.match(requests[1], /Streaming workflow/);
	assert.match(requests[1], /1970-01-01T00:00:01.000Z/);
	assert.equal(session.messages.filter((message) => message.role === "custom").length, 1);
});

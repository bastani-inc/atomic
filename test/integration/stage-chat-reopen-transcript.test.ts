import assert from "node:assert/strict";
import { initTheme } from "@bastani/atomic";
import { createAssistantMessageEventStream } from "@bastani/atomic-ai";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { test, vi } from "vitest";
import { stripAnsi } from "../../packages/coding-agent/src/utils/ansi.js";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { workflowTranscriptResult } from "../../packages/workflows/src/extension/workflow-tool-inspection.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import {
	createStageControlRegistry,
	type StageControlHandle,
} from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import { PooledStageHandle } from "../../packages/workflows/src/workers/pooled-stage-handle.js";
import { WorkerStageWatches } from "../../packages/workflows/src/workers/stage-watch.js";
import type { WatchId } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { createStageSkillFixture } from "../fixtures/stage-chat-skill-session.js";
import { createMemoryTestBackend } from "../helpers/workflow-journal.js";

type Fixture = Awaited<ReturnType<typeof createStageSkillFixture>>;

/** Open the stage as another process's chat does: through a worker watch whose snapshot seeds a mirror handle. */
function withWorkerView<T>(
	fixture: Pick<Fixture, "registry" | "runId" | "stageId">,
	use: (mirror: PooledStageHandle) => T,
): T {
	const attempt = { workId: "work", generation: 1 };
	const watch = "watch-1" as WatchId;
	let mirror: PooledStageHandle | undefined;
	const watches = new WorkerStageWatches(
		fixture.registry,
		() => attempt,
		(message) => {
			if (message.kind !== "stage-command-result" || message.snapshot === undefined) return;
			const snapshot = structuredClone(message.snapshot);
			// Reading needs no transport: nothing here delivers to the stage.
			mirror = new PooledStageHandle(
				fixture.runId,
				fixture.stageId,
				"inspect",
				watch,
				snapshot,
				attempt,
				() => {},
				{} as never,
			);
		},
	);
	const target = { runId: fixture.runId, stageId: fixture.stageId };
	try {
		watches.serve({ kind: "stage-command", commandId: 1, attempt, op: "watch", watch, ...target });
		assert.ok(mirror, "the watch answers with a snapshot");
		return use(mirror);
	} finally {
		watches.serve({ kind: "stage-command", commandId: 2, attempt, op: "unwatch", watch });
		mirror?.dispose();
	}
}

const text = (view: StageChatView) => view.render(120).map(stripAnsi).join("\n");

/** The stage's transcript as the `workflow` tool returns it to the parent session. */
function stageTranscript(fixture: Fixture, options: { readonly tail?: number } = {}) {
	const result = workflowTranscriptResult(
		{ action: "transcript", runId: fixture.runId, stageId: fixture.stageId, ...options },
		{ store: fixture.store, stageControlRegistry: fixture.registry },
	);
	if (result.action !== "transcript") throw new Error(`Expected a transcript, got ${result.action}`);
	return result;
}

/** A failed request the stage retried: saved, then left out of its context, so its transcript differs from it. */
async function retriedFailure(fixture: Fixture): Promise<void> {
	const manager = fixture.stage.session.sessionManager;
	const failure = fauxAssistantMessage([], { stopReason: "error", errorMessage: "529 overloaded" });
	await manager.appendContextEdit(await manager.appendMessage(failure), null);
	fixture.stage.session.refreshContext();
}

test.each([
	{ kind: "provider error", reason: "error", content: "", output: 0, liveTokens: 24 },
	{ kind: "provider error with billed output", reason: "error", content: "", output: 12, liveTokens: 36 },
	{ kind: "whitespace completion", reason: "stop", content: "   ", output: 0, liveTokens: 25 },
	{ kind: "canned refusal", reason: "stop", content: "I cannot assist with this request.", output: 0, liveTokens: 33 },
] as const)(
	"reopened stage chats still show requesting before the retry's first token after a $kind (#5613)",
	async ({ reason, content, output, liveTokens }) => {
		initTheme("dark", false);
		const stage = await createHarness({
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 25 } },
			tools: [
				{
					name: "read_value",
					label: "Read",
					description: "Read a value",
					parameters: Type.Object({}),
					async execute() {
						return { content: [{ type: "text", text: "Value." }], details: {} };
					},
				},
			],
		});
		const started = Promise.withResolvers<void>();
		const fail = Promise.withResolvers<void>();
		const retryStarted = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const call = fauxAssistantMessage(fauxToolCall("read_value", {}), { stopReason: "toolUse" });
		call.usage = { ...call.usage, output: 24, totalTokens: 24 };
		let requests = 0;
		stage.session.agent.streamFunction = async () => {
			const stream = createAssistantMessageEventStream();
			switch (++requests) {
				case 1:
					stream.push({ type: "done", reason: "toolUse", message: call });
					break;
				case 2: {
					started.resolve();
					await fail.promise;
					const failure = fauxAssistantMessage(content || [], {
						stopReason: reason,
						...(reason === "error" ? { errorMessage: "529 overloaded" } : {}),
					});
					failure.usage = { ...failure.usage, output, totalTokens: output };
					if (reason === "error") stream.push({ type: "error", reason, error: failure });
					else stream.push({ type: "done", reason, message: failure });
					break;
				}
				default:
					retryStarted.resolve();
					await finish.promise;
					stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("Done.") });
			}
			stream.end();
			return stream;
		};
		const registry = createStageControlRegistry();
		const store = createStore();
		let target: { runId: string; stageId: string } | undefined;
		const execution = run(
			workflow({
				name: "retry-direction",
				description: "",
				inputs: {},
				outputs: {},
				async run(ctx) {
					await ctx.stage("inspect", { releaseWhenWaiting: false }).complete("Get the value.");
					return {};
				},
			}),
			{},
			{
				durableBackend: await createMemoryTestBackend(),
				store,
				stageControlRegistry: registry,
				adapters: {
					agentSession: {
						async create() {
							return stage.session as StageSessionRuntime;
						},
					},
				},
				onStageStart(runId, snapshot) {
					target = { runId, stageId: snapshot.id };
				},
			},
		);
		const views: StageChatView[] = [];
		function mount(handle: StageControlHandle): StageChatView {
			assert.ok(target);
			const view = new StageChatView({
				...target,
				store,
				graphTheme: deriveGraphTheme({}),
				workflowName: "retry-direction",
				handle,
				onDetach() {},
				onClose() {},
			});
			views.push(view);
			return view;
		}
		try {
			await Promise.race([
				started.promise,
				execution.then((outcome) =>
					assert.fail(`Stage ended before the failed request: ${JSON.stringify(outcome)}`),
				),
			]);
			assert.ok(target);
			const handle = registry.get(target.runId, target.stageId);
			assert.ok(handle);
			const live = mount(handle);
			fail.resolve();
			await Promise.race([
				retryStarted.promise,
				execution.then(() => assert.fail("Stage ended before the retry request")),
			]);
			const attached = text(mount(handle));
			const pooled = withWorkerView({ ...target, registry }, (mirror) => text(mount(mirror)));
			const segment = (body: string) => body.match(/[↑↓] [\d.kM]+ tokens/u)?.[0];
			const requesting = segment(text(live));
			assert.equal(requesting, `↑ ${liveTokens} tokens`, "the open chat counted the attempt it saw");
			assert.deepEqual(
				[segment(attached), segment(pooled)],
				["↑ 24 tokens", "↑ 24 tokens"],
				"a reopened meter counts the request context, not a restored attempt",
			);
			if (reason === "error" || content.trim()) {
				const restored = reason === "error" ? "Error: 529 overloaded" : content;
				for (const body of [attached, pooled]) assert.equal(body.split(restored).length - 1, 1);
			}
		} finally {
			for (const view of views) view.dispose();
			fail.resolve();
			finish.resolve();
			await execution;
			registry.clear();
			await stage.cleanup();
		}
	},
);

const histories = [
	{ history: "a plain history", retried: false },
	{ history: "a retried failure", retried: true },
];

test.each(histories)(
	"a stage reopened after its prompt could not be saved shows that prompt once on either host, after $history (#5613)",
	async ({ retried }) => {
		const fixture = await createStageSkillFixture();
		try {
			if (retried) await retriedFailure(fixture);
			const live = fixture.mount();
			const manager = fixture.stage.session.sessionManager;
			const append = manager.appendMessage.bind(manager);
			const prompt = "Prompt the full disk could not hold";
			vi.spyOn(manager, "appendMessage").mockImplementation(async (message) => {
				if (message.role === "user" && JSON.stringify(message.content).includes(prompt))
					throw new Error("ENOSPC: no space left on device");
				return append(message);
			});
			fixture.stage.appendResponses([fauxAssistantMessage("Never requested.")]);
			await fixture.handle.prompt(prompt).catch(() => {});
			const count = (view: StageChatView) => text(view).split(prompt).length - 1;
			assert.equal(count(live), 1);
			assert.equal(count(fixture.mount()), 1);
			withWorkerView(fixture, (mirror) => assert.equal(count(fixture.mount({ handle: mirror })), 1));
		} finally {
			await fixture.cleanup();
		}
	},
);

test.each(histories)(
	"a stage opened on a call saved without its result shows the call was interrupted on either host, after $history (#5613)",
	async ({ retried }) => {
		const fixture = await createStageSkillFixture();
		try {
			if (retried) await retriedFailure(fixture);
			const session = fixture.stage.session;
			const call = fauxToolCall("bash", { command: "echo saved-call" }, { id: "call-without-result" });
			await session.sessionManager.appendMessage(fauxAssistantMessage([call], { stopReason: "toolUse" }));
			session.refreshContext();
			assert.match(text(fixture.mount()), /interrupted after it started/);
			withWorkerView(fixture, (mirror) =>
				assert.match(text(fixture.mount({ handle: mirror })), /interrupted after it started/),
			);
		} finally {
			await fixture.cleanup();
		}
	},
);

test("a reopened stage still shows shell output recorded for this run only after a retry (#5613)", async () => {
	// The result was added directly to the running session, after its model-context filter.
	const fixture = await createStageSkillFixture({
		initialContextTransform: (rows) => rows.filter((m) => m.role !== "bashExecution").map((m) => ({ ...m })),
	});
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let turn: Promise<unknown> | undefined;
	try {
		await retriedFailure(fixture);
		const session = fixture.stage.session;
		const output = "Output for this run only";
		await session.recordBashResult(
			"echo result",
			{ output, exitCode: 0, cancelled: false, truncated: false },
			{ persist: false, defer: false },
		);
		const count = (view: StageChatView) => text(view).split(output).length - 1;
		assert.equal(session.messages.filter((m) => m.role === "bashExecution" && m.output === output).length, 1);
		assert.equal(count(fixture.mount()), 1);
		withWorkerView(fixture, (mirror) => assert.equal(count(fixture.mount({ handle: mirror })), 1));
		assert.equal(
			session.sessionManager.buildSessionContext().messages.some((m) => m.role === "bashExecution"),
			false,
		);
		const manager = session.sessionManager;
		const append = manager.appendMessage.bind(manager);
		vi.spyOn(manager, "appendMessage").mockImplementation(async (message) => {
			if (message.role === "user") {
				entered.resolve();
				await release.promise;
			}
			return append(message);
		});
		const prompt = "Prompt after shell";
		fixture.stage.appendResponses([fauxAssistantMessage("Done.")]);
		turn = fixture.handle.prompt(prompt);
		await entered.promise;
		const rows = (view: StageChatView) =>
			view.render(120).flatMap((line) => [output, prompt].filter((s) => stripAnsi(line).includes(s)));
		assert.deepEqual(rows(fixture.mount()), [output, prompt]);
		withWorkerView(fixture, (mirror) => assert.deepEqual(rows(fixture.mount({ handle: mirror })), [output, prompt]));
		release.resolve();
		await turn;
		assert.deepEqual(rows(fixture.mount()), [output, prompt]);
	} finally {
		release.resolve();
		await turn;
		await fixture.cleanup();
	}
});

test("the workflow transcript of a stage never returns a hidden row left out of its context (#5613)", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const session = fixture.stage.session;
		const id = await session.sessionManager.appendCustomMessageEntry("note", "HIDDEN NOTE FOR THE MODEL", false);
		await session.sessionManager.appendContextEdit(id, null);
		session.refreshContext();
		const result = stageTranscript(fixture, { tail: 1 });
		assert.equal(result.source, "live");
		assert.deepEqual(
			result.entries.map((entry) => entry.text),
			["Stage ready for skill commands."],
		);
	} finally {
		await fixture.cleanup();
	}
});

test("a worker view of a stage holds no hidden rows left out of its context (#5613)", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const session = fixture.stage.session;
		for (let index = 0; index < 4; index++) {
			const id = await session.sessionManager.appendCustomMessageEntry(
				"note",
				`${index}:${"x".repeat(32_768)}`,
				false,
			);
			await session.sessionManager.appendContextEdit(id, null);
		}
		session.refreshContext();
		withWorkerView(fixture, (mirror) => {
			assert.deepEqual(
				mirror.messages.filter((message) => message.role === "custom" && message.customType === "note"),
				[],
			);
			assert.equal(mirror.messages.length, session.messages.length);
		});
	} finally {
		await fixture.cleanup();
	}
});

test("switching away from an edited stage branch restores path-only inspection without reading history (#5613)", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const session = fixture.stage.session;
		const manager = session.sessionManager;
		const fork = manager.getLeafId();
		assert.ok(fork);
		await retriedFailure(fixture);
		const edited = manager.getLeafId();
		assert.ok(edited);
		await manager.branch(fork);
		for (let index = 0; index < 64; index++)
			await manager.appendMessage({ role: "user", content: `active branch ${index}`, timestamp: index });
		session.refreshContext();
		const reads = vi.spyOn(manager, "getEntries");
		const result = stageTranscript(fixture);
		assert.equal(result.inlineMode, "path_only");
		assert.equal(result.entryCount, session.messages.length);
		assert.deepEqual(result.entries, []);
		assert.equal(fixture.handle.messages, session.messages);
		assert.equal(reads.mock.calls.length, 0);
		await manager.branch(edited);
		session.refreshContext();
		assert.match(text(fixture.mount()), /529 overloaded/);
	} finally {
		await fixture.cleanup();
	}
});

test.each([false, true])(
	"a path-only workflow transcript still reads no entries with an active edit (displayed: %s) (#5613)",
	async (displayed) => {
		const fixture = await createStageSkillFixture();
		try {
			const session = fixture.stage.session;
			const manager = session.sessionManager;
			if (displayed) await retriedFailure(fixture);
			else {
				const id = await manager.appendCustomMessageEntry("note", "omitted hidden note", false);
				await manager.appendContextEdit(id, null);
				session.refreshContext();
			}
			const reads = vi.spyOn(manager, "getEntries");
			const result = stageTranscript(fixture);
			assert.equal(result.inlineMode, "path_only");
			assert.deepEqual(result.entries, []);
			assert.equal(reads.mock.calls.length, 0);
			assert.equal(result.entryCount, session.messages.length);
			const emptyPreview = stageTranscript(fixture, { tail: 0 });
			assert.deepEqual(emptyPreview.entries, []);
			assert.equal(reads.mock.calls.length, 0);
			assert.equal(emptyPreview.entryCount, session.messages.length);
			if (!displayed) {
				assert.equal(fixture.handle.messages, session.messages);
				assert.equal(reads.mock.calls.length, 0);
			} else {
				assert.match(text(fixture.mount()), /529 overloaded/);
				assert.equal(stageTranscript(fixture, { tail: 1 }).entryCount, session.messages.length + 1);
			}
		} finally {
			await fixture.cleanup();
		}
	},
);

test("a path-only workflow transcript of a stage reads none of its saved entries (#5613)", async () => {
	const fixture = await createStageSkillFixture();
	try {
		const session = fixture.stage.session;
		for (let index = 0; index < 64; index++)
			await session.sessionManager.appendMessage({ role: "user", content: `message ${index}`, timestamp: index });
		session.refreshContext();
		const reads = vi.spyOn(session.sessionManager, "getEntries");
		const result = stageTranscript(fixture);
		assert.equal(result.inlineMode, "path_only");
		assert.equal(result.entryCount, session.messages.length);
		assert.equal(reads.mock.calls.length, 0);
	} finally {
		await fixture.cleanup();
	}
});

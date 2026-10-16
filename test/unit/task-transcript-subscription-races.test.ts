import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createAgentSession, DefaultResourceLoader } from "@bastani/atomic";
import { type AssistantMessage, getModel } from "@bastani/pi-ai/compat";
import { AssistantMessageEventStream } from "@bastani/pi-ai/utils/event-stream";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../../packages/coding-agent/src/core/agent-session.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import type { MessageStartEvent, MessageUpdateEvent } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { readTaskTranscript } from "../../packages/coding-agent/src/core/tasks/transcript.js";
import { TaskInspector } from "../../packages/coding-agent/src/modes/interactive/components/task-inspector.js";
import { TaskLiveTranscript } from "../../packages/coding-agent/src/modes/interactive/components/task-live-transcript.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { SubagentControlRuntime } from "../../packages/subagents/src/runs/inprocess/runner.js";
import { taskFixture } from "../helpers/task-projection.js";

// Only replace SDK discovery/construction: each run below uses the actual Agent,
// AgentSession event queue, extension dispatch, persistence and subagent runner.
vi.mock("@bastani/atomic", async (original) => ({
	...(await original<typeof import("@bastani/atomic")>()),
	createAgentSession: vi.fn(),
}));

const assistant = (text: string): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "fixture",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
});
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const rendered = (inspector: TaskInspector) => stripVTControlCharacters(inspector.renderViewport(100, 100).join("\n"));

test("opening a transcript receives the final message queued during its history read", async () => {
	initTheme("dark");
	const keys = getKeybindings();
	setKeybindings(new KeybindingsManager());
	const fixture = taskFixture();
	const session = SessionManager.inMemory();
	await session.appendMessage({ role: "user", content: "Inspect the subscription race", timestamp: 0 });
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	let finalDuringRead: string | undefined;
	let listenersAtFinal = -1;
	let finalId: string | undefined;
	const inspector = new TaskInspector(
		fixture.store,
		() => {},
		() => {},
	);
	try {
		const lease = await fixture.start();
		fixture.runners[0].context.bindTranscript({
			getSessionId: () => session.getSessionId(),
			getEntries: () => {
				const entries = session.getEntries();
				const text = finalDuringRead;
				finalDuringRead = undefined;
				if (text !== undefined)
					queueMicrotask(async () => {
						const message = assistant(text);
						listenersAtFinal = listeners.size;
						for (const listener of listeners) listener({ type: "message_end", message });
						// AgentSession persists after notifying public listeners.
						finalId = await session.appendMessage(message);
					});
				return entries;
			},
			subscribe: (listener) => {
				listeners.add(listener);
				return () => {
					listeners.delete(listener);
				};
			},
		});

		// Negative control: the former awaited API returns the old page after
		// message_end has already passed, with no streaming message left to hydrate.
		finalDuringRead = "BEFORE-SUBSCRIBE";
		const oldPage = await readTaskTranscript(lease);
		assert.ok(oldPage.ok);
		await vi.waitFor(() => assert.ok(finalId));
		assert.equal(listenersAtFinal, 0);
		assert.ok(oldPage.value.items.every((item) => item.source.entryId !== finalId));

		inspector.handleInput("\r");
		await flush();
		finalDuringRead = "FINAL-AT-HISTORY-BOUNDARY";
		inspector.handleInput("\r");
		await flush();
		assert.equal(listenersAtFinal, 1, "the viewer must subscribe before yielding to the queued final");
		assert.equal((rendered(inspector).match(/FINAL-AT-HISTORY-BOUNDARY/g) ?? []).length, 1);
		await fixture.settle();
		assert.equal((rendered(inspector).match(/FINAL-AT-HISTORY-BOUNDARY/g) ?? []).length, 1);
		inspector.handleInput("\x1b");
		assert.equal(listeners.size, 0);
	} finally {
		inspector.dispose();
		await fixture.dispose();
		setKeybindings(keys);
	}
});

const messageText = (message: AgentMessage | undefined) => {
	if (!message || !("content" in message)) return "";
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
};
const liveText = (viewer: TaskLiveTranscript) => stripVTControlCharacters(viewer.render(100).join("\n"));

async function queuedRunner() {
	const root = mkdtempSync(join(tmpdir(), "atomic-transcript-races-"));
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const credentials = AuthStorage.inMemory();
	await credentials.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	vi.spyOn(SettingsManager, "create").mockReturnValue(settings);
	vi.spyOn(DefaultResourceLoader.prototype, "reload").mockResolvedValue(undefined);
	const stream = new AssistantMessageEventStream();
	const ready = Promise.withResolvers<void>();
	let session!: AgentSession;
	let source!: TaskTranscriptSource;
	const held: Array<ReturnType<typeof Promise.withResolvers<void>>> = [];
	let intercept: (event: MessageStartEvent | MessageUpdateEvent) => void | Promise<void> = () => {};
	const extensionsResult = await createTestExtensionsResult(
		[
			(pi) => {
				pi.on("message_start", (event) => intercept(event));
				pi.on("message_update", (event) => intercept(event));
			},
		],
		root,
	);
	vi.mocked(createAgentSession).mockImplementation(async (options) => {
		const agent = new Agent({
			initialState: { model, systemPrompt: "Test", tools: [] },
			getApiKey: () => "test-key",
			streamFn: () => {
				ready.resolve();
				return stream;
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: options!.sessionManager!,
			settingsManager: settings,
			cwd: root,
			modelRuntime,
			resourceLoader: createTestResourceLoader({ extensionsResult }),
			initialActiveToolNames: [],
		});
		return { session, extensionsResult };
	});
	const runtime = new SubagentControlRuntime({ path: "transcript-races", depth: 0 }, join(root, "sessions"));
	const agent = {
		name: "worker",
		description: "Transcript fixture",
		systemPrompt: "",
		systemPromptMode: "append" as const,
		source: "user" as const,
		filePath: join(root, "worker.md"),
		inheritSkills: false,
		inheritProjectContext: false,
	};
	runtime.registerAgents([agent]);
	const admission = runtime.admitChildSession({ taskName: "race", task: "Stream a response", cwd: root, agent });
	assert.ok(admission.admitted);
	const running = runtime.runChildAttempt(
		admission.admitted,
		{ model },
		{
			abort: new AbortController().signal,
			interrupt: new AbortController().signal,
		},
		undefined,
		{
			reportActivity: () => {},
			bindTranscript: (bound) => {
				if (bound.subscribe) source = bound;
			},
		},
	);
	await Promise.race([
		ready.promise,
		running.then((result) => {
			throw new Error(`Runner ended before provider stream: ${JSON.stringify(result)}`);
		}),
	]);
	assert.ok(source?.subscribe);
	return {
		session,
		source,
		stream,
		block(predicate: (event: MessageStartEvent | MessageUpdateEvent) => boolean) {
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			held.push(release);
			intercept = async (event) => {
				if (!predicate(event)) return;
				entered.resolve();
				await release.promise;
			};
			return { entered: entered.promise, release: () => release.resolve() };
		},
		once(predicate: (event: AgentSessionEvent) => boolean) {
			const done = Promise.withResolvers<void>();
			const unsubscribe = session.subscribe((event) => {
				if (!predicate(event)) return;
				// Do not splice the live dispatch array while other listeners need this event.
				queueMicrotask(unsubscribe);
				done.resolve();
			});
			return done.promise;
		},
		async finish(text: string) {
			for (const release of held) release.resolve();
			stream.push({ type: "done", reason: "stop", message: assistant(text) });
			return running;
		},
		async dispose() {
			for (const release of held) release.resolve();
			stream.push({ type: "done", reason: "stop", message: assistant("cleanup") });
			await running;
			vi.restoreAllMocks();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("late subscribers hydrate only public deltas while the real AgentSession queue is blocked", async () => {
	initTheme("dark");
	const run = await queuedRunner();
	const viewers: TaskLiveTranscript[] = [];
	try {
		const partial = assistant("");
		const started = run.once((event) => event.type === "message_start" && event.message.role === "assistant");
		run.stream.push({ type: "start", partial });
		await started;
		const first = run.once(
			(event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
		);
		assert.equal(partial.content[0].type, "text");
		partial.content[0].text = "alpha";
		run.stream.push({ type: "text_delta", contentIndex: 0, delta: "alpha", partial });
		await first;
		const blocked = run.block(
			(event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
		);
		partial.content[0].text = "alpha beta";
		run.stream.push({ type: "text_delta", contentIndex: 0, delta: " beta", partial });
		await blocked.entered;
		assert.equal(messageText(run.session.agent.state.streamingMessage), "alpha beta", "raw state really is ahead");
		assert.equal(
			messageText(run.source.getStreamingMessage?.()),
			"alpha",
			"snapshot must stop at the public boundary",
		);
		for (let i = 0; i < 2; i++) viewers.push(new TaskLiveTranscript(run.source, [], () => {}));
		for (const viewer of viewers) {
			assert.match(liveText(viewer), /alpha/);
			assert.doesNotMatch(liveText(viewer), /beta/);
		}
		const delivered = run.once(
			(event) => event.type === "message_update" && event.assistantMessageEvent.type === "text_delta",
		);
		blocked.release();
		await delivered;
		assert.equal(messageText(run.source.getStreamingMessage?.()), "alpha beta");
		for (const viewer of viewers) {
			assert.equal(
				(liveText(viewer).match(/beta/g) ?? []).length,
				1,
				"queued delta must not be replayed atop raw hydration",
			);
			assert.match(liveText(viewer), /alpha beta/);
		}
		assert.equal((await run.finish("alpha beta")).status, "ok");
		assert.equal(run.source.getStreamingMessage?.(), undefined);
		for (const viewer of viewers) assert.equal((liveText(viewer).match(/alpha beta/g) ?? []).length, 1);
	} finally {
		for (const viewer of viewers) viewer.dispose();
		await run.dispose();
	}
});

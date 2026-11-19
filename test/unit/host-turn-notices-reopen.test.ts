import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { createAssistantMessageEventStream } from "@bastani/atomic-ai";
import { fauxAssistantMessage } from "@bastani/atomic-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeAll, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../packages/coding-agent/src/core/agent-session-runtime.js";
import { convertToLlm } from "../../packages/coding-agent/src/core/messages.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.js";
import {
	releaseStartupChatOutput,
	StartupChatContainer,
} from "../../packages/coding-agent/src/modes/interactive/interactive-startup-chat-container.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createEngineHostPair } from "../../packages/coding-agent/test/helpers/in-process-engine-pair.js";
import { RecordingTerminal } from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.js";
import { createHarness, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { createHarnessWithExtensions } from "../../packages/coding-agent/test/test-harness.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
import { editorTheme, plainStyle } from "./chat-session-host-working-lifecycle-fixture.js";

beforeAll(() => initTheme("dark", false));
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

function chat(session: Harness["session"]): InteractiveMode {
	const host = {
		session,
		services: { agentDir: tmpdir() },
		diagnostics: [],
		setBeforeSessionInvalidate() {},
		setRebindSession() {},
		async dispose() {},
	} as unknown as AgentSessionRuntime;
	const terminal = new RecordingTerminal();
	terminal.columns = 180;
	terminal.rows = 40;
	const mode = new InteractiveMode(host, { terminal });
	(mode as unknown as { isInitialized: boolean }).isInitialized = true;
	releaseStartupChatOutput(mode);
	cleanups.push(() => mode.stop());
	return mode;
}
const rows = (mode: InteractiveMode) =>
	mode.chatContainer
		.render(180)
		.map((line) => stripVTControlCharacters(line).trim())
		.filter(Boolean);

test.each(["in-process", "isolated"])(
	"the %s host attributes a live miss and thinking drop to the published reply's own predecessor (#5681)",
	async (host) => {
		const pair = await createEngineHostPair({ settings: { showCacheMissNotices: true } });
		pair.hostHarness.settingsManager.setShowCacheMissNotices(true);
		cleanups.push(() => pair.cleanup());
		const session = host === "isolated" ? pair.runtime.session : pair.engine.session;
		const mode = chat(session);
		cleanups.push(session.subscribe((e) => void mode.handleEvent(e as never)));
		let call = 0;
		pair.engine.session.agent.streamFunction = () => {
			const stream = createAssistantMessageEventStream();
			const second = ++call === 2;
			const m = fauxAssistantMessage(second ? "switched reply" : "warm reply");
			m.model = second ? "model-b" : "model-a";
			m.usage = { ...m.usage, input: second ? 25_000 : 0, cacheRead: second ? 0 : 25_000 };
			if (second)
				m.diagnostics = [
					{ type: "anthropic_input_transformations", timestamp: m.timestamp, details: { droppedBlockCount: 2 } },
				];
			stream.push({ type: "done", reason: "stop", message: m });
			stream.end();
			return stream;
		};
		await pair.engine.session.prompt("warm");
		await pair.drain();
		if (host === "isolated")
			await vi.waitFor(() =>
				assert.ok(
					session.sessionManager
						.getEntries()
						.some((e) => e.type === "message" && e.message.role === "assistant" && e.message.model === "model-a"),
				),
			);
		await pair.engine.session.prompt("switch");
		await pair.drain();
		const notices = rows(mode).filter((l) => l.includes("Prompt cache miss") || l.includes("Anthropic dropped"));
		assert.equal(notices.length, 2);
		assert.match(notices[0]!, /Anthropic dropped 2 thinking blocks/);
		assert.match(notices[1]!, /Prompt cache miss after model switch: 25,000 tokens re-billed/);
	},
);

test("a refused display reader never masks the ordinary synchronous chat render (#5649)", async () => {
	const h = await createHarness({});
	cleanups.push(() => h.cleanup());
	await h.sessionManager.appendMessage({ role: "user", content: "An ordinary saved prompt", timestamp: 1 });
	const scope = h.sessionManager.chatRecordScope();
	assert.ok(scope);
	const refused = vi.spyOn(scope.store, "has").mockImplementation(() => {
		throw new Error("display read refused");
	});
	const mode = chat(h.session);
	mode.renderInitialMessages();
	assert.ok(rows(mode).some((line) => line.includes("An ordinary saved prompt")));
	mode.rebuildChatFromMessages();
	assert.equal(refused.mock.calls.length, 1);
});

test("a fullscreen chat reads repeated diagnostics only at painted anchors (#5649)", async () => {
	const h = await createHarness({});
	cleanups.push(() => h.cleanup());
	const manager = h.sessionManager;
	const first = await manager.appendMessage({ role: "user", content: "offscreen prompt", timestamp: 1 });
	for (let i = 0; i < 80; i++)
		await manager.appendMessage({ role: "user", content: `middle prompt ${i}`, timestamp: i + 2 });
	const last = await manager.appendMessage({ role: "user", content: "last prompt", timestamp: 100 });
	const scope = manager.chatRecordScope();
	assert.ok(scope);
	for (const id of [first, last])
		for (let n = 0; n < 40; n++)
			await scope.store.append(scope.owner, id, { kind: "line", level: "error", text: `diagnostic-${id}-${n}` });
	const read = vi.spyOn(scope.store, "read");
	const mode = chat(h.session);
	mode.renderInitialMessages();
	const chatContainer = mode.chatContainer;
	assert.ok(chatContainer instanceof StartupChatContainer);
	const window = () => {
		const win = chatContainer.layoutWindow({
			width: 140,
			top: 0,
			height: 8,
			followEnd: true,
			requestRender: () => {},
		});
		return Array.from({ length: 8 }, (_, n) => stripVTControlCharacters(win.at(win.top + n) ?? "")).join("\n");
	};
	await vi.waitFor(() => assert.ok(window().includes(`diagnostic-${last}-39`)));
	assert.ok(read.mock.calls.some(([, ids]) => ids.includes(last)));
	assert.ok(!read.mock.calls.some(([, ids]) => ids.includes(first)));
	const seen = read.mock.calls.length;
	window();
	await new Promise<void>((r) => setImmediate(r));
	assert.equal(read.mock.calls.length, seen);
});

test("the visible end of a long overtaking group does not leave its prompt below that group (#5668)", async () => {
	const h = await createHarness({});
	cleanups.push(() => h.cleanup());
	const manager = h.sessionManager;
	let first = "";
	for (let i = 0; i < 60; i++) {
		const id = await manager.appendCustomMessageEntry("note", `Saved notice number ${i}`, true, undefined, true);
		first ||= id;
	}
	const p = await manager.appendMessage({ role: "user", content: "ADMITTED PROMPT", timestamp: 1 });
	const scope = manager.chatRecordScope();
	assert.ok(scope);
	await scope.store.append(scope.owner, first, { kind: "promptBefore", promptId: p });
	const mode = chat(h.session);
	mode.renderInitialMessages();
	const container = mode.chatContainer;
	assert.ok(container instanceof StartupChatContainer);
	const viewport = () => {
		const win = container.layoutWindow({ width: 140, top: 0, height: 8, followEnd: true, requestRender: () => {} });
		return Array.from({ length: 8 }, (_, n) => stripVTControlCharacters(win.at(win.top + n) ?? "")).join("\n");
	};
	await vi.waitFor(() => {
		const end = viewport();
		assert.match(end, /Saved notice number 59/);
		assert.doesNotMatch(end, /ADMITTED PROMPT/);
	});
});

test("a refused second cancellation record never hides the earlier saved line at the same anchor (#5649)", async () => {
	const h = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", () => ({ cancel: true }));
			},
		],
	});
	cleanups.push(() => h.cleanup());
	h.setResponses([fauxAssistantMessage("seed")]);
	await h.session.prompt("original conversation");
	await assert.rejects(h.session.compact(), /cancel/i);
	const mode = chat(h.session);
	cleanups.push(h.session.subscribe((e) => void mode.handleEvent(e as never)));
	mode.renderInitialMessages();
	const count = () => rows(mode).filter((l) => l.includes("Compaction cancelled")).length;
	await vi.waitFor(() => assert.equal(count(), 1));
	const scope = h.sessionManager.chatRecordScope();
	assert.ok(scope);
	vi.spyOn(scope.store, "append").mockRejectedValue(new Error("refused"));
	await assert.rejects(h.session.compact(), /cancel/i);
	assert.equal(count(), 2);
	mode.rebuildChatFromMessages();
	await vi.waitFor(() => assert.equal(count(), 1));
});

test("a main chat reopened after a notice overtakes its admitted prompt keeps live order (#5668)", async () => {
	const h = await createHarness({ settings: { retry: { enabled: false } } });
	cleanups.push(() => h.cleanup());
	const mode = chat(h.session);
	cleanups.push(h.session.subscribe((event) => void mode.handleEvent(event as never)));
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const append = h.sessionManager.appendMessage.bind(h.sessionManager);
	const promptText = "the admitted user prompt";
	const notice = "overtaking display notice";
	h.sessionManager.appendMessage = async (message) => {
		if (message.role === "user") {
			entered.resolve();
			await release.promise;
		}
		return append(message);
	};
	h.setResponses([fauxAssistantMessage("Done")]);
	const turn = h.session.prompt(promptText);
	try {
		await entered.promise;
		await h.session.sendCustomMessage(
			{ customType: "note", display: true, content: notice },
			{ excludeFromContext: true },
		);
		const order = (view: InteractiveMode) =>
			rows(view).flatMap((line) => [promptText, notice].filter((text) => line.includes(text)));
		assert.deepEqual(order(mode), [promptText, notice]);
		release.resolve();
		await turn;
		const reopened = await SessionManager.open(h.sessionManager.getSessionStore(), h.sessionManager.getSessionId());
		const other = await createHarness({ sessionManager: reopened });
		cleanups.push(() => other.cleanup());
		const resumed = chat(other.session);
		resumed.renderInitialMessages();
		await vi.waitFor(() => assert.deepEqual(order(resumed), [promptText, notice]));
	} finally {
		release.resolve();
		await turn;
	}
});

test("a prompt admitted in the original chat never moves ahead of a notice belonging only to a fork (#5668)", async () => {
	const h = await createHarness({ settings: { retry: { enabled: false } } });
	cleanups.push(() => h.cleanup());
	const manager = h.sessionManager;
	h.setResponses([fauxAssistantMessage("seed")]);
	await h.session.prompt("original conversation");
	const entered = Promise.withResolvers<void>(),
		release = Promise.withResolvers<void>();
	const append = manager.appendMessage.bind(manager);
	manager.appendMessage = async (m) => {
		if (m.role === "user") {
			entered.resolve();
			await release.promise;
		}
		return append(m);
	};
	h.setResponses([fauxAssistantMessage("done")]);
	const turn = h.session.prompt("Admitted in original");
	try {
		await entered.promise;
		const root = manager.getLeafId();
		assert.ok(root);
		await manager.createBranchedSession(root);
		await h.session.sendCustomMessage(
			{ display: true, customType: "note", content: "Only in fork" },
			{ excludeFromContext: true },
		);
		release.resolve();
		await turn;
		const other = await createHarness({
			sessionManager: await SessionManager.open(manager.getSessionStore(), manager.getSessionId()),
		});
		cleanups.push(() => other.cleanup());
		const mode = chat(other.session);
		mode.renderInitialMessages();
		await vi.waitFor(() =>
			assert.deepEqual(
				rows(mode).flatMap((l) => ["Only in fork", "Admitted in original"].filter((x) => l.includes(x))),
				["Only in fork", "Admitted in original"],
			),
		);
	} finally {
		release.resolve();
		await turn;
	}
});

test.each(["in-process", "isolated"])(
	"on the %s host, a failed and a cancelled retry reopen in order, exactly as shown (#5649)",
	async (host) => {
		const root = await mkdtemp(join(tmpdir(), "atomic-outcome-chat-"));
		cleanups.push(() => rm(root, { force: true, recursive: true }));
		const manager = await SessionManager.create(root, join(root, "sessions"));
		const reopen = () => SessionManager.open(manager.getSessionFile()!);
		const pair = await createEngineHostPair({
			sessionManager: manager,
			hostSessionManager: await reopen(),
			settings: { retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 } },
		});
		cleanups.push(() => pair.cleanup());
		const session = host === "isolated" ? pair.runtime.session : pair.engine.session;
		const live = chat(session);
		cleanups.push(session.subscribe((event) => void live.handleEvent(event as never)));
		const fail = () => fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" });
		pair.engine.setResponses([fail(), fail(), fail()]);
		await pair.engine.session.prompt("first");
		pair.engine.session.subscribe((event) => {
			if (event.type === "auto_retry_start") pair.engine.session.abortRetry();
		});
		await pair.engine.session.prompt("second");
		await pair.drain();
		const expected = [
			"Error: Retry failed after 1 attempts: overloaded_error",
			"Error: Retry failed after 1 attempts: Retry cancelled",
		];
		const outcomes = (lines: string[]) => lines.filter((line) => line.includes("Retry failed"));
		assert.deepEqual(outcomes(rows(live)), expected);
		const resumedSession = await createHarness({ sessionManager: await reopen() });
		cleanups.push(() => resumedSession.cleanup());
		const resumed = chat(resumedSession.session);
		resumed.renderInitialMessages();
		await vi.waitFor(() => assert.deepEqual(outcomes(rows(resumed)), expected));
		const tasks = taskFixture();
		cleanups.push(() => tasks.dispose());
		await tasks.start("Child chat");
		const child = resumedSession.session;
		tasks.runners[0].context.bindTranscript({
			getSessionId: () => child.sessionId,
			getEntries: () => child.sessionManager.getEntries(),
			chatSession: child,
			subscribe: (listener) => child.subscribe(listener),
		});
		const attached = new TaskAgentTranscriptPage(
			ownerTaskViewSource(tasks.store),
			tasks.store.tasks[0]!.ref.taskId,
			taskTranscriptEnvironment(),
			() => {},
		);
		cleanups.push(() => attached.dispose());
		await attached.load();
		await vi.waitFor(() =>
			assert.deepEqual(outcomes(attached.render(180, 100).map((s) => stripVTControlCharacters(s).trim())), expected),
		);
	},
);

test.each(["in-process", "isolated"])(
	"on the %s host a child's live compaction error keeps its original prefix and suffix (#5649)",
	async (host) => {
		const pair = await createEngineHostPair({
			engineExtensions: [
				(pi) => {
					pi.on("session_before_compact", () => ({ compactedText: "retained" }));
				},
			],
		});
		cleanups.push(() => pair.cleanup());
		pair.engine.setResponses([fauxAssistantMessage("ok")]);
		await pair.engine.session.prompt("hello");
		await pair.drain();
		const attached = new ChatSessionHost({ style: plainStyle, editorTheme });
		cleanups.push(() => attached.dispose());
		const source = host === "isolated" ? pair.runtime.session : pair.engine.session;
		cleanups.push(source.subscribe((event) => attached.applyAgentEvent(event)));
		const failure = `Child-store write refused: ${"long-path/".repeat(540)} ENOSPC`;
		pair.engine.sessionManager.appendCompaction = async () => {
			throw new Error(failure);
		};
		await assert.rejects(pair.engine.session.compact(), /ENOSPC/);
		await pair.drain();
		const lines = attached
			.renderBody(160, 240)
			.map((s) => stripVTControlCharacters(s).trim())
			.filter(Boolean);
		const diagnostic = lines.filter((s) => s.includes("Child-store write refused"));
		assert.equal(diagnostic.length, 1);
		assert.match(diagnostic[0]!, /^Compaction failed: Child-store write refused:/);
		assert.ok(lines.some((s) => s.endsWith("ENOSPC")));
		assert.ok(!lines.some((s) => s.includes("history://")));
	},
);

test("a committed boundary precedes its unprefixed hard-limit error exactly once in the open chat (#5649)", async () => {
	const harness = await createHarnessWithExtensions({
		contextWindow: 1_000,
		settings: { compaction: { enabled: true, reserveTokens: 200 } },
		responses: [
			{ toolCalls: [{ id: "one", name: "batch", args: {} }], usage: { input: 700, output: 20, totalTokens: 720 } },
		],
		baseToolsOverride: {
			batch: {
				name: "batch",
				label: "Batch",
				description: "Return one batch",
				parameters: Type.Object({}),
				execute: async () => ({ content: [{ type: "text", text: "x".repeat(480) }], details: {} }),
			},
		},
		extensionFactories: [
			(pi) => {
				let compacted = false;
				pi.on("session_before_compact", () => ({ compactedText: "[User]: retained" }));
				pi.on("session_compact", () => {
					compacted = true;
				});
				pi.on("context", (event) =>
					compacted
						? { messages: [...event.messages, { role: "user", content: "expanded ".repeat(2000), timestamp: 1 }] }
						: undefined,
				);
			},
		],
	});
	cleanups.push(() => harness.cleanup());
	await harness.session.bindExtensions({});
	harness.session.setActiveToolsByName(["batch"]);
	harness.agent.convertToLlm = convertToLlm;
	const transform = harness.agent.transformContext;
	harness.agent.transformContext = async (input, signal) => {
		const messages = await harness.session.extensionRunner.emitContext(input);
		return transform ? transform(messages, signal) : messages;
	};
	const mode = chat(harness.session);
	harness.session.subscribe((event) => void mode.handleEvent(event as never));
	await harness.session.prompt(Array.from({ length: 24 }, (_, i) => `context line ${i}`).join("\n"));
	const end = harness.eventsOfType("compaction_end")[0];
	assert.ok(end?.result);
	assert.match(end.errorMessage ?? "", /^Post-tool context remains/);
	const lines = rows(mode).filter((line) => line.includes("hard input limit") || line.includes("Context compacted"));
	assert.match(lines[0]!, /Context compacted/);
	// The compaction event draws the first diagnostic; the later failed assistant reply has its own row.
	assert.deepEqual(lines.slice(1), [end.errorMessage, `Error: ${end.errorMessage}`]);
});

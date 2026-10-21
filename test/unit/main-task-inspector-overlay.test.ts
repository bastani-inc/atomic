import assert from "node:assert/strict";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
	Container,
	getKeybindings,
	type OverlayHandle,
	ScrollView,
	setKeybindings,
	Text,
	VStack,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/index.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import {
	createAskUserQuestionToolDefinition,
	QUESTIONNAIRE_OVERLAY_OPTIONS,
} from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.js";
import { isQuestionnaireResult } from "../../packages/coding-agent/src/core/tools/ask-user-question/tool/types.js";
import { CustomEditor } from "../../packages/coding-agent/src/modes/interactive/components/custom-editor.ts";
import { FooterComponent } from "../../packages/coding-agent/src/modes/interactive/components/footer.js";
import {
	InteractiveModeBase,
	shouldHandleFullscreenViewportInput,
} from "../../packages/coding-agent/src/modes/interactive/interactive-mode-base.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-context.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-extension-custom-ui.ts";
import "../../packages/coding-agent/src/modes/interactive/interactive-selectors.ts";
import { registerStartupInputListeners } from "../../packages/coding-agent/src/modes/interactive/interactive-input-handling.ts";
import {
	createFullscreenTui,
	handleFocusedOverlayInternalUiAction,
} from "../../packages/coding-agent/src/modes/interactive/interactive-tui.ts";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { RemoteComponentController } from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { registerRemoteProxyOwnership } from "../../packages/coding-agent/src/modes/interactive-engine/remote-input-ownership.ts";
import { showEngineTaskInspector } from "../../packages/coding-agent/src/modes/rpc/task-ui-bridge.js";
import {
	getLayoutFrame,
	RecordingTerminal,
} from "../../packages/coding-agent/test/helpers/interactive-fullscreen-layout.ts";
import { buildGraphOverlayAdapter, type OverlayUISurface } from "../../packages/workflows/src/tui/overlay-adapter.js";
import { taskFixture } from "../helpers/task-projection.js";
import { createStore, fakeFooterAgentSession } from "./stage-chat-view-helpers.js";

async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

async function mountMainInspector(isolated: boolean, populated = true) {
	initTheme("dark");
	const keys = new KeybindingsManager({ "app.tasks.inspect": "ctrl+e", "app.tasks.cancel": "ctrl+x" });
	setKeybindings(keys);
	const fixture = taskFixture();
	if (populated) await fixture.start("Fullscreen review");
	const transcript = SessionManager.inMemory();
	for (let i = 0; i < 50; i++)
		await transcript.appendMessage({ role: "user", content: `CHILD-MESSAGE-${i}`, timestamp: i });
	if (populated) fixture.runners[0].context.bindTranscript(transcript);
	const terminal = new RecordingTerminal();
	terminal.columns = 80;
	terminal.rows = 24;
	let editor: CustomEditor;
	let hostFallbacks = 0;
	const tui = createFullscreenTui({
		showHardwareCursor: false,
		logDirectory: "/tmp",
		terminal,
		shouldHandleViewportInput: (data, mouse, overlay) =>
			shouldHandleFullscreenViewportInput(tui.getFocusedComponent(), editor, data, mouse, overlay, keys),
		onOverlayUnhandledInput: () => {
			hostFallbacks++;
			return true;
		},
		onOverlayInternalUiAction: (url) => handleFocusedOverlayInternalUiAction(tui, url),
		onInternalUiAction: () => {
			hostFallbacks++;
		},
	});
	editor = new CustomEditor(tui, getEditorTheme(), keys);
	const editorContainer = new Container();
	editorContainer.addChild(editor);
	const document = new Container();
	document.addChild(new Text(Array.from({ length: 100 }, (_, i) => `MAIN-CHAT-${i}`).join("\n"), 0, 0));
	const scroll = new ScrollView(document, { follow: "end", primary: true });
	const statuses = new Map([["mcp", "MCP: 0/1 servers"]]);
	const footerData = {
		getGitBranch: () => "main",
		getAvailableProviderCount: () => 2,
		getExtensionStatuses: () => statuses,
		onBranchChange: () => () => {},
	};
	tui.setLayoutRoot(
		new VStack([
			{ component: scroll, basis: 0, grow: 1, minSize: 1 },
			{ component: editorContainer, shrink: 0 },
			{
				component: {
					invalidate() {},
					render: (width) =>
						new FooterComponent(
							session,
							footerData,
							undefined,
							() => mode.navigationInlineCustomUiDepth > 0,
						).render(width),
				},
				shrink: 0,
			},
		]),
	);
	tui.setFocus(editor);
	const listeners = new Set<(message: InteractiveEngineMessage) => void>();
	const engineMessages: InteractiveEngineMessage[] = [];
	let service: EngineCustomUiService | undefined;
	const session = {
		...fakeFooterAgentSession(),
		getAgentTaskHost() {},
		extensionRunner: { getUIContext: () => ({ custom: service!.custom.bind(service!) }) },
	} as unknown as AgentSession;
	session.state.model!.id = "gpt-6-astra";
	session.state.thinkingLevel = "medium";
	session.sessionManager.getCwd = () => join(process.env.HOME!, "Documents/projects/atomic");
	bindOwnerTaskStore(session, fixture.store);
	const runtime = {
		session,
		onGenerationEnded: () => () => {},
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		sendEngineCommand: (command: InteractiveEngineCommand) =>
			service?.handleLine(serializeInteractiveEngineFrame(command)),
	} as unknown as IsolatedInteractiveRuntime;
	const mode = Object.assign(Object.create(InteractiveModeBase.prototype), {
		ui: tui,
		runtimeHost: runtime,
		editor,
		defaultEditor: editor,
		editorContainer,
		extensionDialogs: [],
		programStatus: { setBlocked: () => {} },
		documentContainer: document,
		transcriptScrollView: scroll,
		keybindings: keys,
		firstSubmitRecorded: true,
		blockingInlineCustomUiDepth: 0,
		deferredInlineCustomUiFocusDepth: 0,
		hostCustomUiStateListeners: new Set(),
		addTuiInputListener: tui.addInputListener.bind(tui),
		handleCtrlC: () => {
			hostFallbacks++;
		},
		showError: (message: string) => {
			throw new Error(message);
		},
	}) as InteractiveModeBase;
	registerStartupInputListeners(mode);
	mode.setupEditorSubmitHandler();
	let controller: RemoteComponentController | undefined;
	let releaseOwnership = () => {};
	if (isolated) {
		service = new EngineCustomUiService((line) => {
			const message = parseInteractiveEngineMessage(line);
			if (message) {
				engineMessages.push(message);
				for (const listener of listeners) listener(message);
			}
		}, keys);
		controller = new RemoteComponentController(
			runtime,
			{
				custom: (factory, options) => mode.showExtensionCustom(factory, options),
				requestRender: () => tui.requestRender(),
				setWidget() {},
			} satisfies Pick<ExtensionUIContext, "custom" | "requestRender" | "setWidget">,
			{ isFullscreen: () => true, onRendererReplaced: () => () => {} },
		);
		releaseOwnership = registerRemoteProxyOwnership(runtime, controller);
	}
	tui.start();
	tui.renderNow();
	const open = () =>
		isolated
			? showEngineTaskInspector(session, { custom: service!.custom.bind(service!) })
			: Promise.resolve(editor.onSubmit!("/tasks"));
	const completion = open();
	await flush();
	async function paint() {
		tui.renderNow();
		await flush();
		tui.renderNow();
		const focused = tui.getFocusedComponent();
		assert.ok(focused);
		return focused.render(terminal.columns);
	}
	async function input(data: string) {
		terminal.input(data);
		await flush();
		return paint();
	}
	return {
		mode,
		service,
		engineMessages,
		session,
		statuses,
		frame: () => stripVTControlCharacters(getLayoutFrame(tui).lines.join("\n")),
		tui,
		terminal,
		editor,
		fixture,
		scroll,
		completion,
		open,
		paint,
		input,
		get hostFallbacks() {
			return hostFallbacks;
		},
		async dispose() {
			controller?.dispose();
			service?.dispose();
			releaseOwnership();
			mode.disposeActiveSelector();
			tui.hideOverlay();
			tui.stop();
			await fixture.dispose();
		},
	};
}

for (const isolated of [false, true]) {
	test(`${isolated ? "isolated engine" : "in-process"} /tasks opens inline, drills down fullscreen, and escapes without cancelling`, async () => {
		const previousKeys = getKeybindings();
		const host = await mountMainInspector(isolated);
		try {
			assert.equal(host.tui.hasOverlay(), false, "/tasks opens in the editor slot like /workflow connect");
			for (const surface of [host.mode, host.service].filter((value) => value !== undefined)) {
				const state = surface.getHostCustomUiState();
				assert.equal(state.blockingInlineCustomUiActive, true, "picker still owns inline input");
				assert.equal(state.blockingInlineCustomUiNeedsInput, false, "navigation is not an approval wait");
			}
			const picker = await host.paint();
			assert.ok(picker.length <= 12 && picker.length < host.terminal.rows);
			assert.match(stripVTControlCharacters(picker.join("\n")), /Background tasks/);
			const assertFrame = async () => {
				const frame = await host.paint();
				assert.equal(frame.length, host.terminal.rows);
				assert.ok(frame.every((line) => visibleWidth(line) === host.terminal.columns));
				assert.doesNotMatch(stripVTControlCharacters(frame.join("\n")), /MAIN-CHAT/);
				return stripVTControlCharacters(frame.join("\n"));
			};
			await host.input("\x05"); // configured inspect opens fullscreen detail
			assert.equal(host.tui.hasOverlay(), true);
			assert.match(await assertFrame(), /Inspect transcript/);
			const scrollTop = host.scroll.scrollTop;
			assert.ok(scrollTop > 0, "fixture must have scrollable main chat history");
			const assertKeysOwned = async () => {
				for (const key of [
					"\x1b[5~",
					"\x1b[6~",
					"\x1b[H",
					"\x1b[F",
					"\x1b[A",
					"\x1b[B",
					"\x14",
					"\x0f",
					"\x06",
					"\x15",
					"\x04",
					"\x1b[1;2A",
					"\x1b[1;2B",
					"\x1b[<64;10;5M",
					"ordinary text",
				]) {
					await host.input(key);
					assert.equal(host.scroll.scrollTop, scrollTop, `main chat scrolled for ${JSON.stringify(key)}`);
					assert.equal(host.editor.getText(), "");
					assert.equal(host.hostFallbacks, 0, `main action received ${JSON.stringify(key)}`);
				}
			};
			await assertKeysOwned();
			// Restore the first detail action after the arrow-key checks.
			await host.input("\x1b");
			await host.input("\x05");
			await host.input("\x05");
			assert.match(await assertFrame(), /^Transcript/);
			await assertKeysOwned();
			await host.input("\x1b[F");
			assert.match(await assertFrame(), /CHILD-MESSAGE-49/);
			await host.input("\x1b[H");
			assert.match(await assertFrame(), /CHILD-MESSAGE-0/);
			for (const [width, rows] of [
				[31, 9],
				[100, 40],
			]) {
				host.terminal.resize(width, rows);
				await assertFrame();
			}
			await host.input("\x1b");
			assert.match(await assertFrame(), /Inspect transcript/);
			await host.input("\x1b");
			assert.equal(host.tui.hasOverlay(), false);
			assert.match(stripVTControlCharacters((await host.paint()).join("\n")), /Background tasks/);
			assert.ok((await host.paint()).length <= 12);
			await host.input("\x1b");
			await host.completion;
			assert.equal(host.tui.hasOverlay(), false);
			assert.equal(host.tui.getFocusedComponent(), host.editor);
			assert.equal(host.fixture.runners[0].context.signal.aborted, false);
			const reopened = host.open();
			await flush();
			await host.paint();
			await host.input("\x18"); // configured task cancel still requires confirmation
			assert.match(await assertFrame(), /confirm/);
			await host.input("\x1b");
			assert.equal(host.fixture.runners[0].context.signal.aborted, false);
			await host.input("\x03");
			assert.equal(host.tui.hasOverlay(), false, "physical Ctrl+C must close the view, not trap input");
			await reopened;
			assert.equal(host.tui.getFocusedComponent(), host.editor);
			assert.equal(host.fixture.runners[0].context.signal.aborted, false);
			assert.equal(host.hostFallbacks, 0);
			const beforeChatScroll = host.scroll.scrollTop;
			await host.input("\x1b[5~");
			assert.ok(host.scroll.scrollTop < beforeChatScroll, "main chat paging resumes after closing");
		} finally {
			await host.dispose();
			setKeybindings(previousKeys);
		}
	});
}

for (const [isolated, completeOlderFirst] of [
	[false, true],
	[false, false],
	[true, true],
	[true, false],
]) {
	test(`${isolated ? "isolated engine" : "in-process"} navigation preserves context and distinguishes real pending prompts (${completeOlderFirst ? "older" : "newer"} completes first)`, async () => {
		const previous = getKeybindings();
		const host = await mountMainInspector(isolated, false);
		const source = host.service ?? host.mode;
		const custom: ExtensionUIContext["custom"] = host.service
			? host.service.custom.bind(host.service)
			: host.mode.showExtensionCustom.bind(host.mode);
		const surface: OverlayUISurface = {
			custom: custom as unknown as OverlayUISurface["custom"],
			getHostCustomUiState: () => source.getHostCustomUiState(),
			onHostCustomUiStateChange: (listener) => source.onHostCustomUiStateChange(listener),
			setStatus: (key, value) => (value === undefined ? host.statuses.delete(key) : host.statuses.set(key, value)),
		};
		const adapter = buildGraphOverlayAdapter({ ui: surface }, createStore());
		const key = "pi-workflows:main-chat-input";
		const notice = "Main chat needs input — exit graph to answer.";
		// PR #2926: the footer abbreviates home using native path separators on Windows too.
		const context = `(openai-codex) gpt-6-astra medium • ${join("~", "Documents/projects/atomic")} (main)`;
		let finishFirst = () => {};
		let finishSecond = () => {};
		let first: Promise<void> | undefined;
		let second: Promise<void> | undefined;
		const answered: string[] = [];
		try {
			await host.paint();
			assert.ok(host.frame().includes(context), host.frame());
			assert.ok(host.frame().includes("MCP: 0/1 servers"));
			assert.ok(host.frame().includes("0 active · 0 total"));
			Object.defineProperty(host.session, "isStreaming", { value: true, configurable: true });
			await host.paint();
			assert.ok(host.frame().includes(context), host.frame());
			assert.doesNotMatch(host.frame(), /esc to interrupt/i);
			Object.defineProperty(host.session, "isStreaming", { value: false, configurable: true });
			await host.fixture.start("Late task owned by main");
			await vi.waitFor(async () => {
				await host.paint();
				assert.match(host.frame(), /Late task owned by main/);
			});
			adapter.open(null);
			await flush();
			assert.equal(host.statuses.get(key), undefined, "task navigation is not a main-chat question");
			const graphFocus = host.tui.getFocusedComponent();
			first = custom<void>((_ui, _theme, _keys, done) => {
				finishFirst = done;
				return Object.assign(new Text("First genuine approval", 0, 0), {
					handleInput(data: string) {
						if (data === "\r") {
							answered.push("first");
							done();
						}
						return true;
					},
				});
			});
			second = custom<void>(
				(_ui, _theme, _keys, done) => {
					finishSecond = done;
					return Object.assign(new Text("Second genuine approval", 0, 0), {
						handleInput(data: string) {
							if (data === "\r") {
								answered.push("second");
								done();
							}
							return true;
						},
					});
				},
				{ purpose: "prompt" },
			);
			await flush();
			assert.equal(host.statuses.get(key), notice);
			assert.equal(
				host.tui.getFocusedComponent(),
				graphFocus,
				"a main prompt must not steal foreground graph input",
			);
			if (completeOlderFirst) finishFirst();
			else finishSecond();
			await (completeOlderFirst ? first : second);
			await flush();
			assert.equal(host.statuses.get(key), notice, "one completion cannot mask another required prompt");
			assert.equal(host.tui.getFocusedComponent(), graphFocus, "completion must preserve foreground graph focus");
			adapter.toggle(null);
			await flush();
			assert.equal(host.statuses.get(key), undefined, "hidden graph must not advertise an exit-graph notice");
			const survivor = completeOlderFirst ? /Second genuine approval/ : /First genuine approval/;
			assert.match(stripVTControlCharacters((await host.paint()).join("\n")), survivor);
			assert.match(host.frame(), survivor, "the focused approval must actually be visible");
			assert.deepEqual(answered, []);
			await host.input("\r");
			await (completeOlderFirst ? second : first);
			assert.deepEqual(
				answered,
				[completeOlderFirst ? "second" : "first"],
				"dispatched Enter answers only the visible surviving approval",
			);
			assert.match(host.frame(), /Background tasks/, "the pending navigation owner must resume, not main chat");
			assert.match(stripVTControlCharacters((await host.paint()).join("\n")), /Background tasks/);
			assert.equal(host.statuses.get(key), undefined);
			adapter.open(null);
			await flush();
			assert.equal(host.statuses.get(key), undefined, "navigation remaining after prompts is not input-needed");
			adapter.close();
			await flush();
			assert.equal(host.statuses.get(key), undefined);
			assert.match(stripVTControlCharacters((await host.input("\x05")).join("\n")), /Inspect transcript/);
			await host.input("\x1b");
			assert.match(host.frame(), /Background tasks/);
			assert.equal(host.editor.getText(), "");
			assert.equal(host.hostFallbacks, 0);
			await host.input("\x1b");
			await host.completion;
			assert.equal(host.tui.getFocusedComponent(), host.editor);
			assert.equal(source.getHostCustomUiState().blockingInlineCustomUiActive, false);
		} finally {
			finishFirst();
			finishSecond();
			adapter.close();
			await Promise.all([first, second]);
			await host.dispose();
			setKeybindings(previous);
		}
	});
}

for (const isolated of [false, true]) {
	test(`${isolated ? "isolated engine" : "in-process"} exiting task navigation restores the pending approval before the main draft`, async () => {
		const previous = getKeybindings();
		const host = await mountMainInspector(isolated);
		const source = host.service ?? host.mode;
		const custom: ExtensionUIContext["custom"] = host.service
			? host.service.custom.bind(host.service)
			: host.mode.showExtensionCustom.bind(host.mode);
		let finish = () => {};
		let approval: Promise<void> | undefined;
		let answered = 0;
		try {
			await host.input("\x1b");
			await host.completion;
			host.editor.setText("Unsent main draft");
			approval = custom<void>((_ui, _theme, _keys, done) => {
				finish = done;
				return Object.assign(new Text("Approval before navigation", 0, 0), {
					handleInput(data: string) {
						if (data === "\r") {
							answered++;
							done();
						}
						return true;
					},
				});
			});
			await flush();
			await host.paint();
			assert.match(host.frame(), /Approval before navigation/);
			const navigation = showEngineTaskInspector(host.session, { custom });
			await flush();
			await host.paint();
			assert.match(host.frame(), /Background tasks/);
			assert.equal(source.getHostCustomUiState().blockingInlineCustomUiNeedsInput, true);
			assert.match(stripVTControlCharacters((await host.input("\x05")).join("\n")), /Inspect transcript/);
			await host.input("\x1b");
			assert.match(host.frame(), /Background tasks/);
			await host.input("ordinary text");
			assert.equal(host.editor.getText(), "Unsent main draft");
			await host.input("\x1b");
			await navigation;
			assert.match(host.frame(), /Approval before navigation/, "navigation cannot hide an unanswered approval");
			assert.match(stripVTControlCharacters((await host.paint()).join("\n")), /Approval before navigation/);
			assert.equal(answered, 0);
			await host.input("\r");
			await approval;
			assert.equal(answered, 1);
			assert.equal(host.tui.getFocusedComponent(), host.editor);
			assert.match(host.frame(), /Unsent main draft/);
			assert.equal(host.editor.getText(), "Unsent main draft");
			assert.equal(host.hostFallbacks, 0);
			assert.equal(source.getHostCustomUiState().blockingInlineCustomUiActive, false);
		} finally {
			finish();
			await approval;
			await host.dispose();
			setKeybindings(previous);
		}
	});
}

for (const isolated of [false, true]) {
	for (const abortOlder of [true, false]) {
		test(`${isolated ? "isolated engine" : "in-process"} aborting the ${abortOlder ? "older" : "newer"} approval restores its live sibling then /tasks`, async () => {
			const previous = getKeybindings();
			const host = await mountMainInspector(isolated, false);
			const source = host.service ?? host.mode;
			const custom: ExtensionUIContext["custom"] = host.service
				? host.service.custom.bind(host.service)
				: host.mode.showExtensionCustom.bind(host.mode);
			const adapter = buildGraphOverlayAdapter(
				{
					ui: {
						custom: custom as unknown as OverlayUISurface["custom"],
						getHostCustomUiState: () => source.getHostCustomUiState(),
						onHostCustomUiStateChange: (listener) => source.onHostCustomUiStateChange(listener),
						setStatus: (key, value) =>
							value === undefined ? host.statuses.delete(key) : host.statuses.set(key, value),
					},
				},
				createStore(),
			);
			const aborts = [new AbortController(), new AbortController()];
			const reason = new Error("Approval canceled");
			const labels = ["FIRST approval", "SECOND approval"];
			const canceled = abortOlder ? 0 : 1;
			const survivor = 1 - canceled;
			const disposed = [0, 0];
			const answered: number[] = [];
			const settled: Array<{ index: number; value?: string; error?: Error }> = [];
			const finish: Array<(result: string | undefined) => void> = [];
			const completions: Promise<void>[] = [];
			const states = () =>
				[host.mode, ...(host.service ? [host.service] : [])].map((ui) => ui.getHostCustomUiState());
			try {
				adapter.open(null);
				await flush();
				const graphFocus = host.tui.getFocusedComponent();
				for (const [index, label] of labels.entries()) {
					completions.push(
						custom<string | undefined>(
							(_ui, _theme, _keys, done) => {
								finish[index] = done;
								return Object.assign(new Text(label, 0, 0), {
									handleInput(data: string) {
										if (data === "\r") {
											answered.push(index);
											done(label);
										}
										return true;
									},
									dispose() {
										disposed[index]++;
										// A teardown callback cannot turn cancellation into an approval result.
										done("disposal must not become an approval");
									},
								});
							},
							{ signal: aborts[index].signal, purpose: "prompt" },
						).then(
							(value) => {
								settled.push({ index, value });
							},
							(error: Error) => {
								settled.push({ index, error });
							},
						),
					);
				}
				await flush();
				assert.ok(states().every((state) => state.blockingInlineCustomUiDepth === 3));
				assert.equal(host.tui.getFocusedComponent(), graphFocus);
				aborts[canceled].abort(reason);
				await completions[canceled];
				await flush();
				const afterAbort = states();
				assert.deepEqual(disposed, abortOlder ? [1, 0] : [0, 1]);
				assert.deepEqual(settled, [
					isolated ? { index: canceled, value: undefined } : { index: canceled, error: reason },
				]);
				assert.equal(host.tui.getFocusedComponent(), graphFocus, "abort cannot steal graph focus");
				assert.equal(
					host.statuses.get("pi-workflows:main-chat-input"),
					"Main chat needs input — exit graph to answer.",
				);
				adapter.toggle(null);
				await flush();
				const survivorFocus = stripVTControlCharacters((await host.paint()).join("\n"));
				const survivorFrame = host.frame();
				await host.input("\r");
				const resumedFocus = stripVTControlCharacters((await host.paint()).join("\n"));
				const resumedFrame = host.frame();
				const afterEnter = states();
				const evidence = JSON.stringify({ afterAbort, afterEnter, answered, survivorFocus, resumedFocus });
				assert.ok(survivorFocus.includes(labels[survivor]), evidence);
				assert.ok(survivorFrame.includes(labels[survivor]), evidence);
				assert.match(resumedFrame, /Background tasks/, evidence);
				assert.match(resumedFocus, /Background tasks/, evidence);
				assert.ok(
					afterAbort.every(
						(state) => state.blockingInlineCustomUiDepth === 2 && state.blockingInlineCustomUiNeedsInput === true,
					),
				);
				assert.ok(
					afterEnter.every(
						(state) =>
							state.blockingInlineCustomUiDepth === 1 && state.blockingInlineCustomUiNeedsInput === false,
					),
				);
				assert.deepEqual(answered, [survivor], "Enter must answer the visibly focused surviving approval only");
				assert.deepEqual(settled[1], { index: survivor, value: labels[survivor] });
				assert.deepEqual(disposed, [1, 1]);
				const doneMessages = host.engineMessages.filter((message) => message.type === "engine_custom_done");
				if (isolated)
					assert.deepEqual(
						doneMessages.map((message) => message.result),
						[undefined, labels[survivor]],
					);
				for (const done of finish) done("late completion");
				for (const abort of aborts) abort.abort(reason);
				await Promise.all(completions);
				await flush();
				assert.equal(settled.length, 2);
				assert.deepEqual(disposed, [1, 1]);
				assert.deepEqual(
					host.engineMessages.filter((message) => message.type === "engine_custom_done"),
					doneMessages,
					"late done/abort must not emit duplicate settlements",
				);
				assert.equal(host.statuses.get("pi-workflows:main-chat-input"), undefined);
				assert.equal(host.editor.getText(), "");
				assert.equal(host.hostFallbacks, 0);
				await host.input("\x1b");
				await host.completion;
				assert.equal(host.tui.getFocusedComponent(), host.editor);
				assert.ok(states().every((state) => state.blockingInlineCustomUiDepth === 0));
			} finally {
				for (const abort of aborts) abort.abort(reason);
				for (const done of finish) done(undefined);
				adapter.close();
				await Promise.all(completions);
				await host.dispose();
				setKeybindings(previous);
			}
		});
	}
}

for (const isolated of [false, true]) {
	for (const transcript of [false, true]) {
		for (const questionFirst of [false, true]) {
			test(`${isolated ? "isolated engine" : "in-process"} ${transcript ? "transcript" : "/tasks"} owns Escape with a questionnaire opened ${questionFirst ? "before" : "during"} navigation`, async () => {
				const previous = getKeybindings();
				const host = await mountMainInspector(isolated);
				const tool = createAskUserQuestionToolDefinition();
				const abort = new AbortController();
				const custom = host.service
					? host.service.custom.bind(host.service)
					: host.mode.showExtensionCustom.bind(host.mode);
				let settled = false;
				let question: ReturnType<typeof tool.execute> | undefined;
				let navigation = host.completion;
				const openQuestion = async () => {
					question = tool.execute(
						"focus-question",
						{
							questions: [
								{
									header: "Approach",
									question: "Which approach?",
									options: [
										{ label: "Alpha", description: "First approach" },
										{ label: "Beta", description: "Second approach" },
									],
								},
							],
						},
						abort.signal,
						() => {},
						{
							hasUI: true,
							ui: { custom },
						} as Parameters<typeof tool.execute>[4],
					);
					void question.then(
						() => {
							settled = true;
						},
						() => {},
					);
					await flush();
				};
				try {
					if (questionFirst) {
						await host.input("\x1b");
						await navigation;
						await openQuestion();
						await host.input("\x1b[B"); // Preserve the selected answer across navigation.
						navigation = showEngineTaskInspector(host.session, { custom });
						await flush();
					}
					if (transcript) {
						await host.input("\x05");
						await host.input("\x05");
					}
					if (!questionFirst) await openQuestion();
					assert.match(
						stripVTControlCharacters((await host.paint()).join("\n")),
						transcript ? /^Transcript/ : /Background tasks/,
					);
					if (transcript) {
						await host.input("\x1b");
						assert.equal(settled, false, "transcript Escape must not cancel the questionnaire");
						assert.match(stripVTControlCharacters((await host.paint()).join("\n")), /Inspect transcript/);
						await host.input("\x1b");
						assert.equal(settled, false, "detail Escape must not cancel the questionnaire");
						assert.match(stripVTControlCharacters((await host.paint()).join("\n")), /Background tasks/);
					}
					await host.input("\x1b");
					assert.equal(settled, false, "task Escape must not cancel the pending questionnaire");
					await navigation;
					assert.match(stripVTControlCharacters((await host.paint()).join("\n")), /Which approach/);
					await host.input(questionFirst ? "\r" : "\x1b");
					const result = await question;
					assert.ok(isQuestionnaireResult(result?.details));
					if (questionFirst) assert.equal(result.details.answers[0].answer, "Beta");
					else assert.equal(result.details.cancelled, true, "standalone questionnaire Escape still cancels");
					assert.equal(host.fixture.runners[0].context.signal.aborted, false);
					assert.equal(host.tui.getFocusedComponent(), host.editor);
					assert.equal(host.hostFallbacks, 0);
				} finally {
					abort.abort();
					await question?.catch(() => {});
					await host.dispose();
					setKeybindings(previous);
				}
			});
		}
	}
}

test("navigation does not reveal a reserving prompt hidden by its caller", async () => {
	const previous = getKeybindings();
	const host = await mountMainInspector(false);
	let handle: OverlayHandle | undefined;
	let finish = () => {};
	const prompt = host.mode.showExtensionCustom<void>(
		(_tui, _theme, _keys, done) => {
			finish = done;
			return new Text("Manually hidden prompt", 0, 0);
		},
		{
			overlay: true,
			reserveTranscriptRows: true,
			overlayOptions: QUESTIONNAIRE_OVERLAY_OPTIONS,
			onHandle: (value) => {
				handle = value;
				value.setHidden(true);
			},
		},
	);
	try {
		await flush();
		await host.input("\x1b");
		await host.completion;
		assert.ok(handle);
		assert.ok(handle.isHidden(), "leaving navigation must respect caller visibility");
		assert.equal(host.tui.hasOverlay(), false);
		handle.setHidden(false);
		await host.paint();
		assert.equal(handle.isFocused(), true);
		assert.equal(host.tui.hasOverlay(), true);
	} finally {
		finish();
		await prompt;
		await host.dispose();
		setKeybindings(previous);
	}
});

test("a reserving prompt removed in onHandle cannot reclaim focus after navigation", async () => {
	const previous = getKeybindings();
	const host = await mountMainInspector(false);
	let finish = () => {};
	const prompt = host.mode.showExtensionCustom<void>(
		(_tui, _theme, _keys, done) => {
			finish = done;
			return new Text("Removed prompt", 0, 0);
		},
		{
			overlay: true,
			reserveTranscriptRows: true,
			overlayOptions: QUESTIONNAIRE_OVERLAY_OPTIONS,
			onHandle: (handle) => handle.hide(),
		},
	);
	try {
		await flush();
		await host.input("\x1b");
		await host.completion;
		assert.equal(host.tui.getFocusedComponent() === host.editor, true, "removed prompt must never regain input");
		await host.input("draft");
		assert.equal(host.editor.getText(), "draft");
	} finally {
		finish();
		await prompt;
		await host.dispose();
		setKeybindings(previous);
	}
});

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@bastani/atomic-ai/compat";
import { runAsHintActivation, stripHintMarkers, type Terminal } from "@bastani/atomic-tui";
import { afterEach, describe, test, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { createUnstartedAgentSessionFromServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { EditorFactory, InlineExtension } from "../src/core/extensions/types.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { TaskId } from "../src/core/tasks/contracts.js";
import { InteractiveMode } from "../src/index.js";
import { takeMovedDraftMark } from "../src/modes/interactive/agent-view/agent-drafts.ts";
import { attachLostAgentQueueNotices } from "../src/modes/interactive/agent-view/prompt-retarget.ts";
import { setViewedNoticeSink } from "../src/modes/interactive/agent-view/viewed-notices.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import type { InteractiveEngineGenerationEnded } from "../src/modes/interactive-engine/engine-generation.ts";
import { stripAnsi } from "../src/utils/ansi.js";
import { FakeAgentViewPort } from "./helpers/fake-agent-view-port.ts";
import { DEQUEUE_KEY, FOLLOW_UP_KEY } from "./helpers/steering-chats.ts";

/** The subagents the screen can open, by task id: fake ports the test drives. */
const openable = vi.hoisted(() => ({
	ports: new Map<string, unknown>(),
	gate: undefined as Promise<void> | undefined,
}));
vi.mock("../src/modes/interactive/agent-view/open-port.ts", () => ({
	openAgentViewPort: async (_mode: unknown, taskId: string) => {
		await openable.gate;
		return openable.ports.get(taskId);
	},
}));

/** Each case builds a real interactive host over a real session, which is slow on loaded Windows runners. */
const HOST_TIMEOUT_MS = 90_000;
const WIDTH = 120;
const ESC = "\x1b";
const ENTER = "\r";
const CTRL_C = "\x03";
const LEFT = "\x1b[D";
/** A Kitty key-release report of ←. */
const LEFT_RELEASE = "\x1b[1;1:3D";
const CTRL_LEFT = "\x1b[1;5D";
const LONG_PASTE = Array.from({ length: 20 }, (_, index) => `pasted line ${index + 1}`).join("\n");
const WORKER = "task-worker-1" as TaskId;

const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;

class KeyTerminal implements Terminal {
	columns = WIDTH;
	rows = 40;
	kittyProtocolActive = true;
	input: ((data: string) => void) | undefined;
	start(onInput: (data: string) => void): void {
		this.input = onInput;
	}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

interface Screen {
	readonly mode: InteractiveMode;
	/** Send key bytes as the terminal does. */
	press(...keys: string[]): Promise<void>;
	/** Press `key` as a click on its hint does. */
	clickHint(key: string): Promise<void>;
	type(text: string): Promise<void>;
	/** The prompt's lines as drawn, without colors. */
	prompt(): string[];
	/** The rows above the prompt, without colors. */
	rows(): string[];
	/** The working line's rows, without colors. */
	workingLine(): string[];
	footer(): string;
	/** What the main chat's model was sent, in order. */
	mainUserMessages(): string[];
	warnings: string[];
	cleanup(): Promise<void>;
}

let screen: Screen | undefined;

afterEach(async () => {
	await screen?.cleanup();
	screen = undefined;
	openable.ports.clear();
	openable.gate = undefined;
});

const settle = async () => {
	for (let i = 0; i < 6; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

/**
 * A real interactive host over a real in-process main session on the faux provider, started as the CLI starts it.
 * `keybindings` is the user's keybindings.json.
 */
async function mainScreen(
	extensions: InlineExtension[] = [],
	options: { readonly keybindings?: Record<string, string | string[]> } = {},
): Promise<Screen> {
	initTheme("dark");
	const cwd = mkdtempSync(join(tmpdir(), "atomic-viewed-prompt-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-viewed-prompt-agent-"));
	if (options.keybindings) writeFileSync(join(agentDir, "keybindings.json"), JSON.stringify(options.keybindings));
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: true,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const services = await createAgentSessionServices({
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				cwd: runtimeOptions.cwd,
				agentDir: runtimeOptions.agentDir,
				builtinPackagePaths: [],
				extensionFactories: extensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const created = await createUnstartedAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			model: faux.getModel(),
			builtins: NO_BUILTINS,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const terminal = new KeyTerminal();
	const mode = new InteractiveMode(runtime, { terminal });
	await mode.init();
	let stopped = false;
	void (async () => {
		while (!stopped) {
			const input = await mode.getUserInput();
			if (stopped) return;
			await mode.runUserPromptTurn(input).catch(() => {});
		}
	})();
	const warnings: string[] = [];
	const showWarning = mode.showWarning.bind(mode);
	mode.showWarning = (message, target) => {
		warnings.push(message);
		showWarning(message, target);
	};
	const plain = (lines: readonly string[]) => lines.map((line) => stripHintMarkers(stripAnsi(line)).trimEnd());
	return {
		mode,
		async press(...keys) {
			for (const key of keys) {
				terminal.input?.(key);
				await settle();
			}
		},
		async type(text) {
			for (const char of text) terminal.input?.(char);
			await settle();
		},
		async clickHint(key) {
			runAsHintActivation(() => terminal.input?.(key));
			await settle();
		},
		prompt: () => plain(mode.editorContainer.render(WIDTH)),
		rows: () =>
			plain(mode.pendingMessagesContainer.render(WIDTH))
				.map((line) => line.trim())
				.filter((line) => line !== ""),
		workingLine: () => plain(mode.statusContainer.render(WIDTH)).filter((line) => line.trim() !== ""),
		footer: () => plain(mode.footer.render(WIDTH)).join("\n"),
		mainUserMessages: () =>
			mode.session.messages.flatMap((message) =>
				message.role === "user"
					? [
							typeof message.content === "string"
								? message.content
								: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
						]
					: [],
			),
		warnings,
		async cleanup() {
			stopped = true;
			mode.stop();
			await runtime.dispose();
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

/** A subagent named worker the screen can open, idle unless `status` says otherwise. */
function worker(status: Partial<ConstructorParameters<typeof FakeAgentViewPort>[0]> = {}): FakeAgentViewPort {
	const port = new FakeAgentViewPort({ taskId: WORKER, name: "worker", ...status });
	openable.ports.set(WORKER, port);
	return port;
}

async function view(taskId: TaskId | undefined): Promise<void> {
	assert.ok(screen);
	assert.equal(await screen.mode.agentView?.view(taskId), true);
	await settle();
}

describe("the main prompt while a subagent is shown", () => {
	test(
		"writes to the subagent: Enter sends it what was typed, and the main chat's model gets nothing",
		async () => {
			screen = await mainScreen();
			const port = worker();
			await view(WORKER);
			await screen.type("look at the parser");
			await screen.press(ENTER);
			await until(() => port.calls.length === 1);
			assert.deepEqual(port.calls, [{ kind: "prompt", text: "look at the parser" }]);
			assert.deepEqual(screen.mainUserMessages(), []);
			assert.equal(screen.mode.editor.getText(), "");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"shows `Message @<agent>…` on its empty prompt and the agent's title on its top rule, and main's again on return",
		async () => {
			screen = await mainScreen();
			worker({ ruleLabel: "worker · Fix the parser · running" });
			const mainPrompt = screen.prompt();
			await view(WORKER);
			const prompt = screen.prompt().join("\n");
			assert.match(prompt, /Message @worker…/);
			assert.match(prompt, /worker · Fix the parser · running/);
			await view(undefined);
			assert.deepEqual(screen.prompt(), mainPrompt);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"keeps each agent's own prompt: main's draft, paste and cursor come back exactly, and the subagent's waits for it",
		async () => {
			screen = await mainScreen();
			worker();
			await screen.type("main says ");
			await screen.press(`\x1b[200~${LONG_PASTE}\x1b[201~`);
			await screen.type(" ok");
			await screen.press("\x1b[D");
			const editor = screen.mode.editor;
			const mainText = editor.getText();
			const mainExpanded = editor.getExpandedText?.();
			const mainCursor = screen.mode.defaultEditor.getCursor();
			await view(WORKER);
			assert.equal(editor.getText(), "");
			await screen.type("for the worker");
			await view(undefined);
			assert.equal(editor.getText(), mainText);
			assert.equal(editor.getExpandedText?.(), mainExpanded);
			assert.deepEqual(screen.mode.defaultEditor.getCursor(), mainCursor);
			await view(WORKER);
			assert.equal(editor.getText(), "for the worker");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"while the subagent works, Enter steers and the follow-up key queues a follow-up, shown as rows until it lists them; the dequeue key brings them back",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true });
			let accept: (() => void) | undefined;
			port.promptAnswer = (_text, options) =>
				new Promise<void>((resolve) => {
					accept = () => {
						options?.preflightResult?.(true, "queued");
						resolve();
					};
				});
			await view(WORKER);
			await screen.type("steer one");
			await screen.press(ENTER);
			assert.deepEqual(screen.rows().slice(0, 1), ["Steering: steer one"]);
			accept?.();
			await settle();
			port.setStatus({ queued: { steering: ["steer one"], followUp: [] } });
			port.promptAnswer = async (_text, options) => options?.preflightResult?.(true, "queued");
			await screen.type("after you are done");
			await screen.press(FOLLOW_UP_KEY);
			await until(() => port.calls.length === 2);
			assert.deepEqual(port.calls, [
				{ kind: "prompt", text: "steer one", lane: "steer" },
				{ kind: "prompt", text: "after you are done", lane: "followUp" },
			]);
			port.setStatus({ queued: { steering: ["steer one"], followUp: ["after you are done"] } });
			await settle();
			assert.deepEqual(screen.rows().slice(0, 2), ["Steering: steer one", "Follow-up: after you are done"]);
			await screen.type("draft");
			await screen.press(DEQUEUE_KEY);
			await until(() => screen?.mode.editor.getText() !== "draft");
			assert.equal(screen.mode.editor.getText(), "steer one\n\nafter you are done\n\ndraft");
			assert.deepEqual(screen.rows(), []);
			assert.deepEqual(screen.mainUserMessages(), []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"Esc pauses the working subagent and its queued messages come back to its prompt; main is not interrupted",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true, queued: { steering: ["queued steer"], followUp: ["later"] } });
			port.pauseAnswer = { ok: true, value: { steering: ["queued steer"], followUp: ["later"] } };
			await view(WORKER);
			await screen.type("typed");
			await screen.press(ESC);
			await until(() => screen?.mode.editor.getText() !== "typed");
			assert.deepEqual(
				port.calls.map((call) => call.kind),
				["pause"],
			);
			assert.equal(screen.mode.editor.getText(), "queued steer\n\nlater\n\ntyped");
			assert.equal(screen.mode.session.queuedMessagesPaused, false, "main's queue was not paused");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a pause answered after the screen went back to main fills the subagent's prompt, not main's",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true, queued: { steering: ["queued steer"], followUp: [] } });
			let answer: (() => void) | undefined;
			port.pause = async () => {
				port.calls.push({ kind: "pause" });
				await new Promise<void>((resolve) => {
					answer = resolve;
				});
				return { ok: true, value: { steering: ["queued steer"], followUp: [] } };
			};
			await screen.type("main draft");
			await view(WORKER);
			await screen.press(ESC);
			await view(undefined);
			answer?.();
			await settle();
			assert.equal(screen.mode.editor.getText(), "main draft");
			await view(WORKER);
			assert.equal(screen.mode.editor.getText(), "queued steer");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a message the subagent refuses after the screen went back to main comes back to the subagent's prompt",
		async () => {
			screen = await mainScreen();
			const port = worker();
			let refuse: (() => void) | undefined;
			port.promptAnswer = () =>
				new Promise<void>((_resolve, reject) => {
					refuse = () => reject(new Error("The agent did not take the message"));
				});
			await screen.type("main draft");
			await view(WORKER);
			await screen.type("for the worker");
			await screen.press(ENTER);
			await view(undefined);
			refuse?.();
			await settle();
			assert.equal(screen.mode.editor.getText(), "main draft");
			await view(WORKER);
			assert.equal(screen.mode.editor.getText(), "for the worker");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"the main chat's extensions write main's prompt while a subagent is shown",
		async () => {
			let setText: ((text: string) => void) | undefined;
			screen = await mainScreen([
				(pi) =>
					pi.on("session_start", (_event, ctx) => {
						setText = (text) => ctx.ui.setEditorText(text);
					}),
			]);
			worker();
			await until(() => setText !== undefined);
			await view(WORKER);
			await screen.type("for the worker");
			setText?.("from main's extension");
			assert.equal(screen.mode.editor.getText(), "for the worker");
			await view(undefined);
			assert.equal(screen.mode.editor.getText(), "from main's extension");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"`!` commands are refused with a notice and stay in the prompt; nothing reaches the subagent or main's shell",
		async () => {
			screen = await mainScreen();
			const port = worker();
			await view(WORKER);
			await screen.type("!ls");
			await screen.press(ENTER);
			assert.equal(screen.mode.editor.getText(), "!ls");
			assert.deepEqual(port.calls, []);
			assert.equal(screen.mode.isBashMode, false);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"switching to a paused subagent and back sends nothing and does not continue it",
		async () => {
			screen = await mainScreen();
			const port = worker({ paused: true, placeholder: "Paused · send to continue" });
			await view(WORKER);
			assert.match(screen.prompt().join("\n"), /Paused · send to continue/);
			await view(undefined);
			await view(WORKER);
			assert.deepEqual(port.calls, []);
			await screen.type("go on");
			await screen.press(ENTER);
			await until(() => port.calls.length === 1);
			assert.deepEqual(port.calls, [{ kind: "resume", text: "go on", lane: "auto" }]);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"the footer's stop key and the working line follow the subagent shown",
		async () => {
			screen = await mainScreen();
			const port = worker({
				busy: true,
				working: { kind: "working", message: "Reading the parser", elapsedMs: 3_000, tokens: 1200 },
			});
			assert.doesNotMatch(screen.footer(), /to pause/);
			await view(WORKER);
			assert.match(screen.footer(), /esc to pause/);
			assert.match(screen.workingLine().join("\n"), /Reading the parser/);
			port.setStatus({ busy: false, working: undefined });
			await settle();
			assert.doesNotMatch(screen.footer(), /to pause/);
			assert.deepEqual(screen.workingLine(), []);
			await view(undefined);
			assert.doesNotMatch(screen.workingLine().join("\n"), /Reading the parser/);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"Ctrl+C on an empty prompt pauses the working subagent shown, never main, and shows main in the same press",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true });
			await view(WORKER);
			await screen.press(CTRL_C);
			await until(() => port.calls.length === 1);
			assert.deepEqual(port.calls, [{ kind: "pause" }]);
			assert.equal(screen.mode.session.queuedMessagesPaused, false);
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a pause that a restart would not keep says why",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true });
			port.pauseAnswer = {
				ok: true,
				value: { steering: [], followUp: [], warning: "The pause could not be saved; a restart continues worker." },
			};
			await view(WORKER);
			const notices: string[] = [];
			setViewedNoticeSink(screen.mode, { show: (text) => notices.push(text) });
			await screen.press(ESC);
			await until(() => notices.length > 0);
			assert.deepEqual(notices, ["The pause could not be saved; a restart continues worker."]);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"Ctrl+C on an empty prompt with the shown subagent idle shows main and never offers to exit Atomic",
		async () => {
			screen = await mainScreen();
			const port = worker();
			await view(WORKER);
			const exitOffer = () => stripAnsi(screen?.mode.chatContainer.render(WIDTH).join("\n") ?? "");
			await screen.press(CTRL_C);
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			assert.doesNotMatch(exitOffer(), /Press Ctrl\+C again to exit/);
			// The press that showed main does not count toward exiting: main's own first press says how to exit.
			await screen.press(CTRL_C);
			assert.match(exitOffer(), /Press Ctrl\+C again to exit/);
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"Esc on an empty prompt with the shown subagent idle keeps it shown, and is not the first press of main's double-Esc (#6135)",
		async () => {
			screen = await mainScreen();
			const port = worker();
			screen.mode.settingsManager.setDoubleEscapeAction("tree");
			await view(WORKER);
			await screen.press(ESC);
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
			await screen.press(LEFT);
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			// One more Esc on main is a first press: the tree does not open.
			await screen.press(ESC);
			assert.equal(screen.mode.editorContainer.children.at(-1), screen.mode.editor);
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"neither an Esc on the shown subagent nor ← back counts as the first press of main's double-Esc (#6135)",
		async () => {
			screen = await mainScreen();
			worker();
			screen.mode.settingsManager.setDoubleEscapeAction("tree");
			// One instant for every press: only the presses in between can keep the tree closed.
			const now = vi.spyOn(Date, "now").mockReturnValue(1_000_000);
			try {
				const treeOpen = () => screen?.mode.editorContainer.children.at(-1) !== screen?.mode.editor;
				await screen.press(ESC);
				await view(WORKER);
				await screen.type("x");
				await screen.press(ESC);
				await view(undefined);
				await screen.press(ESC);
				assert.equal(treeOpen(), false, "the Esc on the subagent ended main's double-Esc");
				await view(WORKER);
				await screen.press(CTRL_C, LEFT);
				assert.equal(screen.mode.agentView?.viewed.kind, "main");
				await screen.press(ESC);
				assert.equal(treeOpen(), false, "going back with ← ended main's double-Esc");
			} finally {
				now.mockRestore();
			}
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"while another subagent is being opened, the footer offers no way back (#6135)",
		async () => {
			screen = await mainScreen();
			worker();
			const other = new FakeAgentViewPort({ taskId: "task-other-1" as TaskId, name: "other" });
			openable.ports.set("task-other-1", other);
			await view(WORKER);
			assert.match(screen.footer(), /← main chat/);
			let open: (() => void) | undefined;
			openable.gate = new Promise<void>((resolve) => {
				open = resolve;
			});
			const shown = screen.mode.agentView?.view("task-other-1" as TaskId);
			await settle();
			assert.doesNotMatch(screen.footer(), /main chat/);
			open?.();
			assert.equal(await shown, true);
			assert.match(screen.footer(), /← main chat/);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"← on an empty prompt shows main and leaves the working subagent running, with its queue and both prompts as they were (#6135)",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true, queued: { steering: ["queued steer"], followUp: [] } });
			await screen.type("main draft");
			await view(WORKER);
			await screen.press(LEFT);
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			assert.equal(screen.mode.editor.getText(), "main draft");
			assert.equal(screen.mode.session.queuedMessagesPaused, false, "main's queue was not paused");
			await view(WORKER);
			assert.equal(screen.mode.editor.getText(), "");
			assert.deepEqual(screen.rows().slice(0, 1), ["Steering: queued steer"]);
			assert.deepEqual(port.calls, [], "the subagent was neither paused nor sent anything");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"← with text typed for the subagent moves the cursor and keeps it shown; a space alone is text (#6135)",
		async () => {
			screen = await mainScreen();
			worker();
			await view(WORKER);
			await screen.type("ac");
			await screen.press(LEFT);
			await screen.type("b");
			assert.equal(screen.mode.editor.getText(), "abc");
			await screen.press(CTRL_C);
			await screen.type(" ");
			await screen.press(LEFT);
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
			assert.equal(screen.mode.editor.getText(), " ");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a released ← and Ctrl+← on an empty prompt keep the subagent shown (#6135)",
		async () => {
			screen = await mainScreen();
			worker();
			await view(WORKER);
			await screen.press(LEFT_RELEASE, CTRL_LEFT);
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"the footer leads with ← main chat while the shown subagent's prompt is empty, and never names Esc as a way back (#6135)",
		async () => {
			screen = await mainScreen();
			worker({ busy: true });
			assert.doesNotMatch(screen.footer(), /main chat/);
			await view(WORKER);
			assert.match(screen.footer(), /esc to pause · ← main chat · /);
			assert.doesNotMatch(screen.footer(), /esc[^·]*main/);
			await screen.type("draft");
			assert.doesNotMatch(screen.footer(), /main chat/);
			await screen.press(CTRL_C);
			assert.match(screen.footer(), /← main chat/);
			await view(undefined);
			assert.doesNotMatch(screen.footer(), /main chat/);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"the keys overlay of a shown subagent lists ← main chat and Esc pausing its turn (#6135)",
		async () => {
			screen = await mainScreen();
			worker({ busy: true });
			await view(WORKER);
			await screen.type("?");
			const overlay = stripHintMarkers(stripAnsi(screen.mode.ui.render(WIDTH).join("\n")));
			assert.match(overlay, /← +main chat, on an empty prompt/);
			assert.match(overlay, /esc +pause the agent's turn/);
			assert.doesNotMatch(overlay, /interrupt the agent's turn/);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a click on ← main chat shows main, and the subagent keeps what was typed for it (#6135)",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true });
			await view(WORKER);
			await screen.type("half a thought");
			await screen.clickHint(LEFT);
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			await view(WORKER);
			assert.equal(screen.mode.editor.getText(), "half a thought");
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a ← pressed while the subagent is being opened moves its prompt's cursor once shown and does not show main (#6135)",
		async () => {
			screen = await mainScreen();
			worker();
			let open: (() => void) | undefined;
			openable.gate = new Promise<void>((resolve) => {
				open = resolve;
			});
			const shown = screen.mode.agentView?.view(WORKER);
			await settle();
			await screen.press(LEFT);
			open?.();
			assert.equal(await shown, true);
			await settle();
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"an extension's shortcut on ← keeps the key while a subagent is shown (#6135)",
		async () => {
			let pressed = 0;
			screen = await mainScreen([
				(pi) =>
					pi.registerShortcut("left", {
						description: "takes left",
						handler: async () => {
							pressed++;
						},
					}),
			]);
			worker();
			await view(WORKER);
			assert.doesNotMatch(screen.footer(), /main chat/, "the hint never names a key an extension takes");
			await screen.press(LEFT);
			await until(() => pressed === 1);
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"an extension's editor built on the prompt's editor leads back to main with ← too (#6135)",
		async () => {
			let setEditor: ((factory: EditorFactory) => void) | undefined;
			screen = await mainScreen([
				(pi) =>
					pi.on("session_start", (_event, ctx) => {
						setEditor = (factory) => ctx.ui.setEditorComponent(factory);
					}),
			]);
			const port = worker({ busy: true });
			await until(() => setEditor !== undefined);
			setEditor?.((tui, theme, keybindings) => new (class extends CustomEditor {})(tui, theme, keybindings));
			await settle();
			assert.notEqual(screen.mode.editor, screen.mode.defaultEditor);
			await view(WORKER);
			assert.match(screen.footer(), /← main chat/);
			await screen.press(LEFT);
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"an extension editor's own shortcut on ← keeps the key while a subagent is shown (#6135)",
		async () => {
			let setEditor: ((factory: EditorFactory) => void) | undefined;
			screen = await mainScreen([
				(pi) =>
					pi.on("session_start", (_event, ctx) => {
						setEditor = (factory) => ctx.ui.setEditorComponent(factory);
					}),
			]);
			worker();
			let pressed = 0;
			await until(() => setEditor !== undefined);
			setEditor?.((tui, theme, keybindings) => {
				const editor = new (class extends CustomEditor {})(tui, theme, keybindings);
				editor.onExtensionShortcut = (data) => {
					if (data !== LEFT) return false;
					pressed++;
					return true;
				};
				return editor;
			});
			await settle();
			await view(WORKER);
			await screen.press(LEFT);
			assert.equal(pressed, 1);
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"the back key follows keybindings.json, and Esc bound to it still only pauses the subagent (#6135)",
		async () => {
			// Ctrl+[ sends what Esc sends, and ↓ focuses the agent panel: neither is a way back, nor is Esc once
			// another key interrupts.
			screen = await mainScreen([], {
				keybindings: { "app.nav.back": ["escape", "ctrl+[", "down", "ctrl+b"], "app.interrupt": "f2" },
			});
			const port = worker({ busy: true });
			await view(WORKER);
			assert.match(screen.footer(), /· ctrl\+b main chat ·/);
			assert.doesNotMatch(screen.footer(), /esc[^·]*main chat|ctrl\+\[|↓[^·]*main chat/);
			await screen.press(ESC);
			await until(() => port.calls.length === 1);
			assert.deepEqual(port.calls, [{ kind: "pause" }]);
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
			await screen.press(LEFT);
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
			await screen.press("\x02");
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"Esc with text typed for an idle subagent keeps it shown and keeps the text",
		async () => {
			screen = await mainScreen();
			worker();
			await view(WORKER);
			await screen.type("for worker");
			await screen.press(ESC);
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
			assert.equal(screen.mode.editor.getText(), "for worker");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"what is typed while the subagent is being opened goes to it once shown, Enter included",
		async () => {
			screen = await mainScreen();
			const port = worker();
			let open: (() => void) | undefined;
			openable.gate = new Promise<void>((resolve) => {
				open = resolve;
			});
			await screen.type("main draft");
			const shown = screen.mode.agentView?.view(WORKER);
			await settle();
			await screen.type("hi worker");
			await screen.press(ENTER);
			assert.equal(screen.mode.editor.getText(), "main draft");
			open?.();
			assert.equal(await shown, true);
			await until(() => port.calls.length === 1);
			assert.deepEqual(port.calls, [{ kind: "prompt", text: "hi worker" }]);
			assert.deepEqual(screen.mainUserMessages(), []);
			await view(undefined);
			assert.equal(screen.mode.editor.getText(), "main draft");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"Esc while the subagent is being opened cancels it; what was typed for it is kept for it and nothing is sent",
		async () => {
			screen = await mainScreen();
			const port = worker();
			let open: (() => void) | undefined;
			openable.gate = new Promise<void>((resolve) => {
				open = resolve;
			});
			const shown = screen.mode.agentView?.view(WORKER);
			await settle();
			await screen.type("for worker");
			await screen.press(ENTER, ESC);
			open?.();
			assert.equal(await shown, false);
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			assert.equal(screen.mode.editor.getText(), "");
			openable.gate = undefined;
			await view(WORKER);
			assert.equal(screen.mode.editor.getText(), "for worker");
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a shown subagent that is gone gives the screen back to main with what was typed for it in front of main's draft",
		async () => {
			screen = await mainScreen();
			const port = worker();
			await screen.type("main draft");
			await view(WORKER);
			await screen.type("unsent for worker");
			port.setStatus({ gone: true });
			await settle();
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			assert.equal(screen.mode.editor.getText(), "unsent for worker\n\nmain draft");
			assert.ok(screen.warnings.includes("worker is gone; your message to it is in the prompt."));
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a subagent that is gone while a menu holds the prompt's place leaves main's prompt as the switch left it",
		async () => {
			screen = await mainScreen();
			const port = worker();
			await screen.type("main draft");
			await view(WORKER);
			await screen.type("unsent for worker");
			let close: (() => void) | undefined;
			const menu = screen.mode.showExtensionCustom<void>((_tui, _theme, _keys, done) => {
				close = () => done();
				return { render: () => ["a menu"], invalidate() {} };
			});
			await settle();
			port.setStatus({ gone: true });
			await settle();
			close?.();
			await menu;
			await settle();
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			assert.equal(screen.mode.editor.getText(), "unsent for worker\n\nmain draft");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"the prompt search closes when the screen shows another agent, so its pick never lands in the other prompt",
		async () => {
			screen = await mainScreen();
			worker();
			await screen.type("main draft");
			await view(WORKER);
			screen.mode.showPromptHistorySearch();
			await settle();
			assert.notEqual(screen.mode.editorContainer.children.at(-1), screen.mode.editor);
			await view(undefined);
			assert.equal(screen.mode.editorContainer.children.at(-1), screen.mode.editor);
			assert.equal(screen.mode.editor.getText(), "main draft");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a gone subagent's prompt that was browsing its history gives back what was typed, not the entry shown",
		async () => {
			screen = await mainScreen();
			const port = worker();
			port.delivered = ["sent earlier"];
			await view(WORKER);
			await until(() => screen?.mode.defaultEditor.getHistory().includes("sent earlier") === true);
			await screen.type("my draft");
			await screen.press("\x01", "\x1b[A");
			assert.equal(screen.mode.editor.getText(), "sent earlier");
			port.setStatus({ gone: true });
			await settle();
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			assert.equal(screen.mode.editor.getText(), "my draft");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a lost engine reports in full what the shown subagent had queued or on its way; nothing is sent again",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true, queued: { steering: ["listed steer"], followUp: [] } });
			port.promptAnswer = () => new Promise<void>(() => {});
			const ended = new Set<(event: InteractiveEngineGenerationEnded) => void>();
			attachLostAgentQueueNotices(screen.mode, {
				onGenerationEnded: (listener) => {
					ended.add(listener);
					return () => ended.delete(listener);
				},
			});
			await view(WORKER);
			await screen.type("on its way");
			await screen.press(ENTER);
			const end = (expected: boolean) => {
				for (const listener of ended)
					listener({
						generation: 1,
						error: new Error("engine stopped"),
						kind: "exit",
						expected,
					} as InteractiveEngineGenerationEnded);
			};
			end(true);
			assert.deepEqual(screen.warnings, []);
			end(false);
			assert.deepEqual(screen.warnings, [
				"Engine restarted; 2 queued messages to worker weren't sent:\nlisted steer\non its way",
			]);
			assert.deepEqual(port.calls, [{ kind: "prompt", text: "on its way", lane: "steer" }]);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a lost engine lists as unconfirmed what the shown subagent took and was not seen to save, shown or still on its way",
		async () => {
			screen = await mainScreen();
			worker({
				busy: true,
				delivering: { steering: ["being delivered"], followUp: [] },
				unsaved: ["shown, not saved"],
			});
			const ended = new Set<(event: InteractiveEngineGenerationEnded) => void>();
			attachLostAgentQueueNotices(screen.mode, {
				onGenerationEnded: (listener) => {
					ended.add(listener);
					return () => ended.delete(listener);
				},
			});
			await view(WORKER);
			for (const listener of ended)
				listener({
					generation: 1,
					error: new Error("engine stopped"),
					kind: "exit",
					expected: false,
				} as InteractiveEngineGenerationEnded);
			assert.deepEqual(screen.warnings, [
				"Engine restarted; these 2 messages to worker may not have been delivered:\nshown, not saved\nbeing delivered",
			]);
		},
		HOST_TIMEOUT_MS,
	);

	for (const replaced of [true, false] as const)
		test(
			`a lost engine whose replacement ${replaced ? "is up" : "never came up"} reports what the shown subagent took by what its store holds`,
			async () => {
				screen = await mainScreen();
				worker({
					busy: true,
					queued: { steering: ["listed steer"], followUp: [] },
					delivering: { steering: ["never saved"], followUp: [] },
					unsaved: ["saved"],
					receipts: {
						sessionId: "worker-session",
						taken: [
							{ id: "saved-id", after: 3, local: true },
							{ id: "never-id", after: 3, local: true, typed: "never saved, as typed" },
						],
					},
				});
				const ended = new Set<(event: InteractiveEngineGenerationEnded) => void>();
				const recovered = new Set<(replaced: boolean) => void>();
				const asked: (string | undefined)[] = [];
				attachLostAgentQueueNotices(screen.mode, {
					onGenerationEnded: (listener) => {
						ended.add(listener);
						return () => ended.delete(listener);
					},
					onEngineRecovered: (listener) => {
						recovered.add(listener);
						return () => recovered.delete(listener);
					},
					findQueuedMessages: async (_messages, sessionId) => {
						asked.push(sessionId);
						return { saved: new Set(["saved-id"]), absent: new Set(["never-id"]) };
					},
				});
				await view(WORKER);
				for (const listener of ended)
					listener({
						generation: 1,
						error: new Error("engine stopped"),
						kind: "exit",
						expected: false,
					} as InteractiveEngineGenerationEnded);
				// Nothing is reported until the replacement says what the subagent's store holds.
				assert.deepEqual(screen.warnings, []);
				for (const listener of [...recovered]) listener(replaced);
				await until(() => (screen?.warnings.length ?? 0) > 0);
				await settle();
				if (replaced) {
					assert.deepEqual(asked, ["worker-session"]);
					// The saved one is not reported; the one its store never saved was not sent, as typed.
					assert.deepEqual(screen.warnings, [
						"Engine restarted; 2 queued messages to worker weren't sent:\nnever saved, as typed\nlisted steer",
					]);
				} else
					assert.deepEqual(screen.warnings, [
						"Engine restarted; these 2 messages to worker may not have been delivered:\nsaved\nnever saved",
						"Engine restarted; 1 queued message to worker wasn't sent:\nlisted steer",
					]);
				assert.equal(screen.mode.editor.getText(), "", "nothing goes into the main prompt");
			},
			HOST_TIMEOUT_MS,
		);

	test(
		"Esc while the shown subagent waits to retry pauses it, which ends the wait (#5507)",
		async () => {
			screen = await mainScreen();
			const port = worker({ retrying: true, working: { kind: "busy", message: "Retrying in 3s · esc cancel" } });
			await view(WORKER);
			assert.match(screen.workingLine().join("\n"), /Retrying in 3s/);
			await screen.press(ESC);
			await until(() => port.calls.length === 1);
			assert.deepEqual(port.calls, [{ kind: "pause" }]);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"Ctrl+C clears what is typed in the shown subagent's prompt, and nothing else",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true });
			await screen.type("main draft");
			await view(WORKER);
			await screen.type("half a thought");
			await screen.press(CTRL_C);
			assert.equal(screen.mode.editor.getText(), "");
			assert.deepEqual(port.calls, []);
			assert.equal(screen.mode.agentView?.viewed.kind, "agent");
			await view(undefined);
			assert.equal(screen.mode.editor.getText(), "main draft");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a read-only subagent can be shown but takes no typing, and its empty prompt says why",
		async () => {
			screen = await mainScreen();
			const port = worker({ readOnlyReason: "This subagent has finished; its chat is read-only." });
			await view(WORKER);
			assert.match(screen.prompt().join("\n"), /its chat is read-only/);
			await screen.type("hello");
			await screen.press(ENTER);
			assert.equal(screen.mode.editor.getText(), "");
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a lost engine still reports the shown subagent's listed queue when its view closes first and the screen went back to main",
		async () => {
			screen = await mainScreen();
			const port = worker({ busy: true, queued: { steering: ["queued one", "queued two"], followUp: [] } });
			const ended = new Set<(event: InteractiveEngineGenerationEnded) => void>();
			attachLostAgentQueueNotices(screen.mode, {
				onGenerationEnded: (listener) => {
					ended.add(listener);
					return () => ended.delete(listener);
				},
			});
			await view(WORKER);
			// The engine's views close in the same emit, before the loss is reported: the screen shows main again.
			port.setStatus({ gone: true });
			assert.equal(screen.mode.agentView?.viewed.kind, "main");
			for (const listener of ended)
				listener({
					generation: 1,
					error: new Error("engine stopped"),
					kind: "exit",
					expected: false,
				} as InteractiveEngineGenerationEnded);
			assert.deepEqual(screen.warnings, [
				"Engine restarted; 2 queued messages to worker weren't sent:\nqueued one\nqueued two",
			]);
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"text typed for a subagent that is gone stays marked in main's prompt until it is submitted or edited",
		async () => {
			screen = await mainScreen();
			const port = worker();
			await view(WORKER);
			await screen.type("/compact now");
			port.setStatus({ gone: true });
			await settle();
			assert.equal(screen.mode.editor.getText(), "/compact now");
			assert.deepEqual(takeMovedDraftMark(screen.mode, "/compact now"), {
				agentName: "worker",
				text: "/compact now",
			});
			assert.equal(takeMovedDraftMark(screen.mode, "/compact now"), undefined, "a submission takes the mark");

			const again = worker();
			await view(WORKER);
			await screen.type("/new");
			again.setStatus({ gone: true });
			await settle();
			assert.match(screen.mode.editor.getText(), /^\/new/);
			await screen.type(" please");
			assert.equal(takeMovedDraftMark(screen.mode, screen.mode.editor.getText()), undefined, "an edit clears it");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"text for a subagent that is gone joins main's own draft, not a history entry main's prompt was showing",
		async () => {
			screen = await mainScreen();
			const port = worker();
			screen.mode.editor.addToHistory?.("old prompt");
			await screen.type("T");
			await screen.press("\x01", "\x1b[A");
			assert.equal(screen.mode.editor.getText(), "old prompt");
			await view(WORKER);
			await screen.type("x");
			port.setStatus({ gone: true });
			await settle();
			assert.equal(screen.mode.editor.getText(), "x\n\nT");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"the moved text's mark is still there when Enter submits it, though the editor empties itself first",
		async () => {
			screen = await mainScreen();
			const port = worker();
			await view(WORKER);
			await screen.type("/compact now");
			port.setStatus({ gone: true });
			await settle();
			// The commands gate reads the mark at the top of the main route, as the submit handler starts.
			const seen: unknown[] = [];
			const editor = screen.mode.defaultEditor;
			const submit = editor.onSubmit;
			editor.onSubmit = (text: string) => {
				seen.push(takeMovedDraftMark(screen!.mode, text));
				return undefined;
			};
			try {
				await screen.press(ENTER);
			} finally {
				editor.onSubmit = submit;
			}
			assert.deepEqual(seen, [{ agentName: "worker", text: "/compact now" }]);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"browsing main's history and coming back leaves the moved text marked",
		async () => {
			screen = await mainScreen();
			const port = worker();
			screen.mode.editor.addToHistory?.("older main prompt");
			await view(WORKER);
			await screen.type("/compact now");
			port.setStatus({ gone: true });
			await settle();
			await screen.press("\x01", "\x1b[A");
			assert.equal(screen.mode.editor.getText(), "older main prompt");
			await screen.press("\x1b[B");
			assert.equal(screen.mode.editor.getText(), "/compact now");
			const seen: unknown[] = [];
			const editor = screen.mode.defaultEditor;
			const submit = editor.onSubmit;
			editor.onSubmit = (text: string) => {
				seen.push(takeMovedDraftMark(screen!.mode, text));
				return undefined;
			};
			try {
				await screen.press(ENTER);
			} finally {
				editor.onSubmit = submit;
			}
			assert.deepEqual(seen, [{ agentName: "worker", text: "/compact now" }]);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a subagent's draft parked under its history comes back when the subagent is shown again",
		async () => {
			screen = await mainScreen();
			const port = worker();
			port.delivered = ["worker's task"];
			await view(WORKER);
			await until(() => screen?.mode.defaultEditor.getHistory().includes("worker's task") === true);
			await screen.type("my draft");
			await screen.press("\x01", "\x1b[A");
			assert.equal(screen.mode.editor.getText(), "worker's task");
			await view(undefined);
			await view(WORKER);
			assert.equal(screen.mode.editor.getText(), "my draft");
		},
		HOST_TIMEOUT_MS,
	);
});

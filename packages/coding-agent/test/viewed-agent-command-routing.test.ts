import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import type { TaskId } from "../src/core/tasks/contracts.js";
import { AgentViewSwitcher } from "../src/modes/interactive/agent-view/agent-view-switcher.ts";
import { setViewedNoticeSink } from "../src/modes/interactive/agent-view/viewed-notices.ts";
import { createRig, type Rig } from "./helpers/busy-submission-rig.ts";
import { FakeAgentViewPort } from "./helpers/fake-agent-view-port.ts";
import { createMainScreen, type MainScreen } from "./helpers/viewed-agent-mode.ts";

/** The subagent the screen opens: a fake port the test drives. */
const opened = vi.hoisted(() => ({ port: undefined as unknown }));
vi.mock("../src/modes/interactive/agent-view/open-port.ts", () => ({
	openAgentViewPort: async () => opened.port,
}));
/** What reached the clipboard. */
const clipboard = vi.hoisted(() => ({ copied: [] as string[] }));
vi.mock("../src/utils/clipboard.js", async (importOriginal) => ({
	...(await importOriginal<object>()),
	copyToClipboard: async (text: string) => {
		clipboard.copied.push(text);
	},
}));

/** Each case builds a real interactive host over a real session, which is slow on loaded Windows runners. */
const HOST_TIMEOUT_MS = 90_000;
const ESC = "\x1b";
const ENTER = "\r";
const DOWN = "\x1b[B";

const TASK = "task-worker-1" as TaskId;

interface ViewedScreen extends MainScreen {
	readonly port: FakeAgentViewPort;
	/** The main chat's warnings. */
	readonly warnings: string[];
	/** Notices about the shown subagent alone, drawn under its transcript. */
	readonly notices: string[];
	readonly ran: string[];
	/** Type `text` and press Enter; resolves once the submission is handled (a dialog it opens stays open). */
	submit(text: string): Promise<void>;
	/** Run the prompt's handler for a key action, as pressing its key does. */
	press(action: string): void;
	viewed(): "main" | "agent";
}

let screen: ViewedScreen | undefined;

/** The main screen showing a subagent named worker; the main session has a bundled and a configured extension command. */
async function viewSubagent(): Promise<ViewedScreen> {
	const ran: string[] = [];
	const main = await createMainScreen([
		{
			name: "atomic-app",
			builtin: true,
			bundled: true,
			factory: (atomic) =>
				atomic.registerCommand("appcmd", {
					description: "An app command Atomic ships",
					handler: async () => void ran.push("/appcmd on main"),
				}),
		},
		(atomic) =>
			atomic.registerCommand("plan", {
				description: "A command the user installed",
				handler: async () => void ran.push("/plan on main"),
			}),
	]);
	// The main session binds its extensions after the screen starts; their commands are routed once bound.
	const runner = () => main.mode.session.extensionRunner;
	await until(() => runner().getCommand("appcmd") !== undefined && runner().getCommand("plan") !== undefined);
	await new Promise((resolve) => setImmediate(resolve));
	const port = new FakeAgentViewPort({ taskId: TASK, name: "worker" });
	port.lastMessage = "the worker's answer";
	opened.port = port;
	const warnings: string[] = [];
	const showWarning = main.mode.showWarning.bind(main.mode);
	main.mode.showWarning = (message, target) => {
		warnings.push(message);
		showWarning(message, target);
	};
	// Notices about the shown subagent alone go to the transcript area's sink; the test reads them there.
	const notices: string[] = [];
	setViewedNoticeSink(main.mode, { show: (text, kind) => void notices.push(`${kind}: ${text}`) });
	assert.equal(await main.mode.agentView?.view(TASK), true);
	const viewed = {
		...main,
		port,
		warnings,
		notices,
		ran,
		async submit(text: string) {
			const submitted = main.mode.defaultEditor.onSubmit?.(text);
			// A dialog the command opens holds its submission; the test answers it.
			await Promise.race([submitted, until(() => isDialog(main.promptSlot()))]);
		},
		press(action: string) {
			main.mode.defaultEditor.actionHandlers.get(action as never)?.();
		},
		viewed: () => main.mode.agentView?.viewed.kind ?? "main",
	} satisfies ViewedScreen;
	return viewed;
}

function isDialog(component: unknown): boolean {
	return component !== undefined && component !== screen?.mode.editor;
}

/** What the prompt held each time the screen was asked to draw from now on: text put back must be drawn. */
function promptsDrawn(mode: {
	readonly ui: { requestRender(force?: boolean): void };
	readonly editor: { getText(): string };
}) {
	const drawn: string[] = [];
	const requestRender = mode.ui.requestRender.bind(mode.ui);
	mode.ui.requestRender = (force?: boolean) => {
		drawn.push(mode.editor.getText());
		requestRender(force);
	};
	return drawn;
}

async function until(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const started = Date.now();
	while (!condition()) {
		if (Date.now() - started > timeoutMs) throw new Error("timed out");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

function answer(key: string): void {
	const slot = screen?.promptSlot() as { handleInput?(data: string): void } | undefined;
	slot?.handleInput?.(key);
}

beforeEach(() => {
	clipboard.copied.length = 0;
});

afterEach(async () => {
	await screen?.cleanup();
	screen = undefined;
	opened.port = undefined;
});

describe("commands typed while a subagent is shown on the main screen", () => {
	test(
		"/model and /thinking are refused with a notice; the main conversation keeps its model and level, and the subagent gets nothing",
		async () => {
			screen = await viewSubagent();
			const { mode, port } = screen;
			const model = mode.session.model?.id;
			const level = mode.session.thinkingLevel;
			await screen.submit("/model other-model");
			await screen.submit("/thinking high");
			assert.deepEqual(screen.notices, [
				"warning: /model changes the main conversation's model. Switch to main to use it.",
				"warning: /thinking changes the main conversation's thinking level. Switch to main to use it.",
			]);
			assert.deepEqual(screen.warnings, [], "nothing is added to the main chat");
			assert.equal(mode.session.model?.id, model);
			assert.equal(mode.session.thinkingLevel, level);
			assert.equal(screen.promptSlot(), mode.editor, "no model selector opened");
			assert.deepEqual(port.calls, []);
			assert.equal(screen.viewed(), "agent");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"/settings opens main's settings over the subagent's view, which stays shown",
		async () => {
			screen = await viewSubagent();
			void screen.mode.defaultEditor.onSubmit?.("/settings");
			await until(() => isDialog(screen?.promptSlot()));
			assert.match(screen.promptSlotText(), /Settings|Theme|Thinking/);
			assert.equal(screen.viewed(), "agent");
			assert.deepEqual(screen.port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"/new asks first, naming the main conversation; Esc keeps the command in the prompt and changes nothing",
		async () => {
			screen = await viewSubagent();
			const { mode, port } = screen;
			const sessionId = mode.session.sessionId;
			await screen.submit("/new");
			assert.match(screen.promptSlotText(), /\/new acts on the main conversation, not worker/);
			assert.match(
				screen.promptSlotText(),
				/∀ 1\. Cancel\s+2\. Run \/new on the main conversation/,
				"Cancel first, chosen",
			);
			const drawn = promptsDrawn(mode);
			answer(ESC);
			await until(() => screen?.promptSlot() === mode.editor);
			await until(() => mode.editor.getText() === "/new");
			await until(() => drawn.includes("/new"));
			assert.equal(mode.session.sessionId, sessionId);
			assert.equal(screen.viewed(), "agent");
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"/new confirmed shows main and starts a new main session",
		async () => {
			screen = await viewSubagent();
			const { mode, port } = screen;
			const sessionId = mode.session.sessionId;
			await screen.submit("/new");
			answer(DOWN);
			answer(ENTER);
			await until(() => mode.session.sessionId !== sessionId);
			assert.equal(screen.viewed(), "main");
			await until(() => /New session started/.test(screen?.transcript() ?? ""));
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"/compact asks first with Cancel chosen; once run, it runs on main and the subagent stays shown",
		async () => {
			screen = await viewSubagent();
			const { mode, port } = screen;
			await screen.submit("/compact");
			assert.match(screen.promptSlotText(), /\/compact acts on the main conversation, not worker/);
			answer(ENTER);
			await until(() => screen?.promptSlot() === mode.editor);
			await until(() => mode.editor.getText() === "/compact");
			assert.deepEqual(screen.warnings, [], "Enter on the dialog cancels: nothing ran");
			mode.editor.setText("");
			await screen.submit("/compact");
			answer(DOWN);
			answer(ENTER);
			// Main's /compact ran; with no messages yet it says so.
			await until(() => screen?.warnings.includes("Nothing to compact (no messages yet)") === true);
			assert.equal(screen.viewed(), "agent");
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"/resume opens its picker over the subagent's view without asking first",
		async () => {
			screen = await viewSubagent();
			const { mode, port } = screen;
			await screen.submit("/resume");
			await until(() => screen?.promptSlot() !== mode.editor);
			assert.doesNotMatch(screen.promptSlotText(), /on the main conversation/);
			assert.equal(screen.viewed(), "agent");
			assert.deepEqual(port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"/session shows main and prints the main session's info there",
		async () => {
			screen = await viewSubagent();
			await screen.submit("/session");
			assert.equal(screen.viewed(), "main");
			assert.match(screen.transcript(), /Session Info/);
			assert.match(screen.transcript(), new RegExp(screen.mode.session.sessionId));
			assert.deepEqual(screen.port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"skills, prompt templates, configured extension commands and other text go to the subagent",
		async () => {
			screen = await viewSubagent();
			for (const text of ["/skill:review the diff", "/review src/a.ts", "/plan", "/copy that", "hello"])
				await screen.submit(text);
			assert.deepEqual(
				screen.port.calls.map((call) => call.text),
				["/skill:review the diff", "/review src/a.ts", "/plan", "/copy that", "hello"],
			);
			assert.deepEqual(screen.ran, [], "the main session ran none of them");
			assert.equal(screen.viewed(), "agent");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"an extension command Atomic ships runs on main; the subagent stays shown and gets nothing",
		async () => {
			screen = await viewSubagent();
			await screen.submit("/appcmd");
			await until(() => screen?.ran.length === 1);
			assert.deepEqual(screen.ran, ["/appcmd on main"]);
			assert.deepEqual(screen.port.calls, []);
			assert.equal(screen.viewed(), "agent");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"/copy copies the subagent's last message",
		async () => {
			screen = await viewSubagent();
			await screen.submit("/copy");
			assert.deepEqual(clipboard.copied, ["the worker's answer"]);
			assert.deepEqual(screen.notices, ["info: Copied last agent message to clipboard"]);
			assert.deepEqual(screen.port.calls, []);
		},
		HOST_TIMEOUT_MS,
	);
});

describe("main's prompt while a command typed for a subagent runs on main", () => {
	/** Main's prompt holds a half-written message; then the screen shows the subagent, whose prompt is empty. */
	async function viewSubagentOverMainDraft(): Promise<ViewedScreen> {
		const viewed = await viewSubagent();
		await viewed.mode.agentView?.view(undefined);
		viewed.mode.editor.setText("half-written for main");
		await viewed.mode.agentView?.view(TASK);
		assert.equal(viewed.mode.editor.getText(), "");
		return viewed;
	}

	test(
		"a command printed into main's transcript shows main with main's prompt as the reader left it",
		async () => {
			screen = await viewSubagentOverMainDraft();
			await screen.submit("/session");
			assert.equal(screen.viewed(), "main");
			assert.match(screen.transcript(), /Session Info/);
			assert.equal(screen.mode.editor.getText(), "half-written for main");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"/clone asked for from the subagent's view clones main, shows it, and keeps main's prompt as the reader left it",
		async () => {
			screen = await viewSubagentOverMainDraft();
			const { mode } = screen;
			await mode.sessionManager.appendMessage({ role: "user", content: "an earlier main prompt", timestamp: 1 });
			const sessionId = mode.session.sessionId;
			await screen.submit("/clone");
			assert.match(screen.promptSlotText(), /\/clone acts on the main conversation, not worker/);
			answer(DOWN);
			answer(ENTER);
			await until(() => mode.session.sessionId !== sessionId);
			await until(() => screen?.viewed() === "main");
			assert.equal(mode.editor.getText(), "half-written for main");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a confirmed command shows main with main's prompt as the reader left it",
		async () => {
			screen = await viewSubagentOverMainDraft();
			const { mode } = screen;
			const sessionId = mode.session.sessionId;
			await screen.submit("/new");
			answer(DOWN);
			answer(ENTER);
			await until(() => /New session started/.test(screen?.transcript() ?? ""));
			assert.notEqual(mode.session.sessionId, sessionId);
			assert.equal(screen.viewed(), "main");
			assert.equal(mode.editor.getText(), "half-written for main");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a command declined after the subagent was gone is not put in main's prompt, where one Enter would run it unasked",
		async () => {
			screen = await viewSubagentOverMainDraft();
			const { mode, port } = screen;
			await screen.submit("/compact");
			port.setStatus({ gone: true });
			assert.equal(screen.viewed(), "main");
			answer(ESC);
			await until(() => screen?.promptSlot() === mode.editor);
			await until(() => screen?.warnings.includes("/compact was not run.") === true);
			assert.equal(mode.editor.getText(), "half-written for main");
		},
		HOST_TIMEOUT_MS,
	);
});

describe("a command typed for a subagent that went away, moved into main's prompt", () => {
	/** The subagent's prompt holds `text`, typed and not sent, when the subagent goes: main shows with `text` moved in. */
	async function movedIntoMain(text: string): Promise<ViewedScreen> {
		const viewed = await viewSubagent();
		viewed.mode.editor.setText(text);
		viewed.port.setStatus({ gone: true });
		await until(() => viewed.viewed() === "main");
		await until(() => viewed.mode.editor.getText() === text);
		return viewed;
	}

	/** Enter, as the terminal sends it: the prompt clears itself, then submits. */
	function enter(): void {
		screen?.mode.defaultEditor.handleInput(ENTER);
	}

	test(
		"one Enter does not run it: it asks first; Esc puts it back and the next Enter asks again; Yes runs it on main",
		async () => {
			screen = await movedIntoMain("/new");
			const { mode } = screen;
			const sessionId = mode.session.sessionId;
			enter();
			await until(() => isDialog(screen?.promptSlot()));
			assert.match(
				screen.promptSlotText(),
				/\/new was typed for worker, which is gone\. It acts on the main conversation\./,
			);
			assert.match(screen.promptSlotText(), /∀ 1\. Cancel\s+2\. Run \/new on the main conversation/);
			const drawn = promptsDrawn(mode);
			answer(ESC);
			await until(() => screen?.promptSlot() === mode.editor);
			await until(() => mode.editor.getText() === "/new");
			await until(() => drawn.includes("/new"));
			assert.equal(mode.session.sessionId, sessionId);
			enter();
			await until(() => isDialog(screen?.promptSlot()));
			answer(DOWN);
			answer(ENTER);
			await until(() => /New session started/.test(screen?.transcript() ?? ""));
			assert.notEqual(mode.session.sessionId, sessionId);
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"edited into other text after the move, it runs as main runs what is typed there",
		async () => {
			screen = await movedIntoMain("/compact");
			const { mode } = screen;
			for (const char of " briefly") mode.defaultEditor.handleInput(char);
			enter();
			// Main's /compact runs at once; with no messages yet it says so.
			await until(() => screen?.warnings.includes("Nothing to compact (no messages yet)") === true);
			assert.equal(screen.promptSlot(), mode.editor, "no dialog");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"a moved command that does not act on the main conversation's history runs at once",
		async () => {
			screen = await movedIntoMain("/session");
			enter();
			await until(() => /Session Info/.test(screen?.transcript() ?? ""));
			assert.equal(screen.promptSlot(), screen.mode.editor, "no dialog");
		},
		HOST_TIMEOUT_MS,
	);
});

describe("the prompt's completion while a subagent is shown", () => {
	/**
	 * The prompt with its completion menu after `text` is typed into the empty prompt: once the menu shows `expected`,
	 * or, without it, once the completion had time to answer. The host rebuilds its completion when the session's
	 * resources settle, which closes an open menu as it does in the main chat; the text is typed again then.
	 */
	async function completionsFor(text: string, expected?: RegExp): Promise<string> {
		const editor = screen?.mode.defaultEditor;
		assert.ok(editor);
		let menu = "";
		for (let attempt = 0; attempt < 5; attempt++) {
			editor.setText("");
			for (const char of text) editor.handleInput(char);
			const started = Date.now();
			while (Date.now() - started < 1500) {
				menu = stripVTControlCharacters((editor.render(160) as string[]).join("\n"));
				if (expected?.test(menu)) return menu;
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
			if (expected === undefined) return menu;
		}
		return menu;
	}

	test(
		"offers the built-ins that work there, Atomic's extension commands, and the subagent's own skills, templates and commands",
		async () => {
			screen = await viewSubagent();
			screen.port.commandCatalog = {
				cwd: process.cwd(),
				skillCommands: [{ name: "skill:reviewer", description: "Review a diff" }],
				promptTemplates: [{ name: "review-template", description: "A template" }],
				extensionCommands: [{ name: "review-command", description: "The subagent's command" }],
			};
			const menu = await completionsFor("/revi", /review-command/);
			assert.match(menu, /skill:reviewer\s+Review a diff/);
			assert.match(menu, /review-template\s+A template/);
			assert.match(await completionsFor("/", /settings/), /settings\s+Open settings menu/);
			assert.match(await completionsFor("/appc", /appcmd/), /appcmd\s+.*An app command Atomic ships/);
			assert.doesNotMatch(await completionsFor("/pla"), /A command the user installed/, "main's own /plan is not");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"/model or /thinking typed and sent with Enter is refused; completion never turns it into another command",
		async () => {
			screen = await viewSubagent();
			const { mode } = screen;
			for (const [typed, refusal] of [
				["/model", "warning: /model changes the main conversation's model. Switch to main to use it."],
				[
					"/thinking",
					"warning: /thinking changes the main conversation's thinking level. Switch to main to use it.",
				],
			] as const) {
				await completionsFor(typed);
				mode.defaultEditor.handleInput("\r");
				await until(() => screen?.notices.includes(refusal) === true);
				assert.equal(screen.promptSlot(), mode.editor, `${typed} opened no selector`);
			}
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"back on main, the prompt completes main's commands again",
		async () => {
			screen = await viewSubagent();
			screen.port.commandCatalog = {
				cwd: process.cwd(),
				skillCommands: [{ name: "skill:reviewer" }],
				promptTemplates: [],
				extensionCommands: [],
			};
			await screen.mode.agentView?.view(undefined);
			assert.match(await completionsFor("/mod", /Select model/), /model/);
			assert.match(await completionsFor("/pla", /A command the user installed/), /plan/);
			assert.doesNotMatch(await completionsFor("/skill:r"), /skill:reviewer/);
		},
		HOST_TIMEOUT_MS,
	);
});

describe("keys that act on the main conversation while a subagent is shown", () => {
	test(
		"the model and thinking keys are refused with a notice and change nothing",
		async () => {
			screen = await viewSubagent();
			const { mode } = screen;
			const level = mode.session.thinkingLevel;
			for (const action of [
				"app.model.select",
				"app.model.cycleForward",
				"app.model.cycleBackward",
				"app.thinking.cycle",
			])
				screen.press(action);
			assert.equal(screen.notices.length, 4);
			for (const notice of screen.notices)
				assert.match(
					notice,
					/^warning: .+ changes the main conversation's (model|thinking level)\. Switch to main to use it\./,
				);
			assert.deepEqual(screen.warnings, [], "nothing is added to the main chat");
			assert.equal(mode.session.thinkingLevel, level);
			assert.equal(screen.promptSlot(), mode.editor, "no model selector opened");
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"the session keys ask first, the resume key's picker opens at once; the new-session key ends on main",
		async () => {
			screen = await viewSubagent();
			const { mode } = screen;
			for (const [action, command] of [
				["app.session.new", "/new"],
				["app.session.tree", "/tree"],
				["app.session.fork", "/fork"],
			] as const) {
				screen.press(action);
				await until(() => isDialog(screen?.promptSlot()));
				assert.match(screen.promptSlotText(), new RegExp(`Run ${command} on the main conversation`));
				answer(ESC);
				await until(() => screen?.promptSlot() === mode.editor);
				assert.equal(screen.viewed(), "agent", action);
			}
			screen.press("app.session.resume");
			await until(() => screen?.promptSlot() !== mode.editor);
			assert.doesNotMatch(screen.promptSlotText(), /on the main conversation/, "the picker, not a confirm");
			assert.equal(screen.viewed(), "agent");
			answer(ESC);
			await until(() => screen?.promptSlot() === mode.editor);
			const sessionId = mode.session.sessionId;
			screen.press("app.session.new");
			await until(() => isDialog(screen?.promptSlot()));
			answer(DOWN);
			answer(ENTER);
			await until(() => mode.session.sessionId !== sessionId);
			assert.equal(screen.viewed(), "main");
			await until(() => /New session started/.test(screen?.transcript() ?? ""));
		},
		HOST_TIMEOUT_MS,
	);

	test(
		"with main shown, the gated keys run as before",
		async () => {
			screen = await viewSubagent();
			const { mode } = screen;
			await mode.agentView?.view(undefined);
			const level = mode.session.thinkingLevel;
			screen.press("app.thinking.cycle");
			await until(() => mode.session.thinkingLevel !== level);
			assert.deepEqual(screen.warnings, []);
		},
		HOST_TIMEOUT_MS,
	);
});

describe("commands typed while a subagent is shown, on the isolated host", () => {
	const rigs: Rig[] = [];
	afterEach(async () => {
		while (rigs.length > 0) await rigs.pop()?.stop();
	});

	test(
		"the engine's catalog decides: its bundled extension commands run on main, its configured ones go to the subagent, and /model is refused",
		async () => {
			const ran: string[] = [];
			const rig = await createRig("isolated", "quiet", {
				extensions: [
					(atomic) =>
						atomic.registerCommand("appcmd", { handler: async () => void ran.push("/appcmd in the engine") }),
					(atomic) =>
						atomic.registerCommand("plan", { handler: async () => void ran.push("/plan in the engine") }),
				],
			});
			rigs.push(rig);
			const runtime = rig.pair?.runtime;
			assert.ok(runtime);
			await runtime.waitUntilResourcesReady();
			await until(() => runtime.getRemoteCommands().some((command) => command.name === "appcmd"));
			// The engine's catalog marks /appcmd as an extension Atomic ships, as it marks the bundled ones.
			const catalog = runtime
				.getRemoteCommands()
				.map((command) =>
					command.name === "appcmd"
						? { ...command, sourceInfo: { ...command.sourceInfo, configurationOrigin: "bundled" as const } }
						: command,
				);
			Object.defineProperty(runtime, "getRemoteCommands", { configurable: true, value: () => catalog });
			const port = new FakeAgentViewPort({ taskId: TASK, name: "worker" });
			const switcher = new AgentViewSwitcher(
				async () => port,
				() => {},
			);
			Object.assign(rig.host, { agentView: switcher });
			assert.equal(await switcher.view(TASK), true);

			await rig.host.defaultEditor.onSubmit?.("/appcmd");
			await until(() => ran.length === 1);
			await rig.host.defaultEditor.onSubmit?.("/plan");
			await rig.host.defaultEditor.onSubmit?.("/model other-model");
			assert.deepEqual(ran, ["/appcmd in the engine"]);
			assert.deepEqual(
				port.calls.map((call) => call.text),
				["/plan"],
			);
			assert.deepEqual(rig.host.notices, [
				"warning: /model changes the main conversation's model. Switch to main to use it.",
			]);
		},
		HOST_TIMEOUT_MS,
	);
});

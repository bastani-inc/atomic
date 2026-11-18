/**
 * The in-process interactive host reports an extension whose `session_start` throws and keeps its session: the error
 * is shown once, it stays on screen after deferred startup rebuilds the transcript, and the session still answers
 * prompts. Before, the bind rejected with `ExtensionStartupError`, the session was closed and every prompt answered
 * "Session is closed" (#5501).
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/atomic-ai/compat";
import type { Terminal } from "@bastani/atomic-tui";
import { afterEach, beforeAll, test, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { createUnstartedAgentSessionFromServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import type { ExtensionFactory } from "../src/core/extensions/types.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { normalizeRenderedOutput } from "./interactive-mode-status-helpers.js";

/** Each case builds a real interactive host over a real session, which is slow on loaded Windows runners. */
const INTERACTIVE_HOST_TIMEOUT_MS = 90_000;
const NO_BUILTINS = { workflows: false, subagents: false, mcp: false, "web-access": false, intercom: false } as const;

class FakeTerminal implements Terminal {
	columns = 160;
	rows = 40;
	kittyProtocolActive = true;
	start(): void {}
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

const cleanup: Array<() => Promise<void>> = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
});

/**
 * An interactive host over an unstarted session, as the CLI builds it: the host's bind starts the extensions. With
 * `settlesStartupTrust`, the first session finishes startup in place once trust is settled, as a CLI startup that asks
 * the project trust question or loads `-e` extensions does.
 */
async function createMode(extension: ExtensionFactory, options: { settlesStartupTrust?: boolean } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-5501-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-5501-agent-"));
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
				reasoning: model.reasoning,
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
				builtinPackagePaths: [],
				extensionFactories: [extension],
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
		if (options.settlesStartupTrust && runtimeOptions.sessionStartEvent === undefined) {
			services.completeStartup = () => created.session.completeStartupResources(services.resourceLoader);
		}
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const mode = new InteractiveMode(runtime, { terminal: new FakeTerminal() });
	cleanup.push(async () => {
		mode.stop();
		await runtime.dispose();
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});
	return { mode, faux };
}

function occurrences(text: string, part: string): number {
	return text.split(part).length - 1;
}

test(
	"the in-process interactive host keeps its session when an extension throws in session_start and shows the error once (#5501)",
	async () => {
		const { mode, faux } = await createMode((pi) => {
			pi.on("session_start", () => {
				throw new Error("boom in session_start");
			});
		});

		await mode.bindCurrentSessionExtensions();

		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: boom in session_start'), 1, chat);
		assert.equal(occurrences(chat, "Extension startup failed"), 0, chat);
		faux.setResponses([fauxAssistantMessage("still working")]);
		await mode.session.prompt("hello");
		const last = mode.session.messages.at(-1);
		assert.deepEqual(last?.role === "assistant" ? last.content : undefined, [
			{ type: "text", text: "still working" },
		]);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"an extension error reported during deferred interactive startup stays on screen after the transcript is rebuilt (#5501)",
	async () => {
		let starts = 0;
		const { mode } = await createMode((pi) => {
			pi.on("session_start", () => {
				// Only the first start throws, so the startup reload that follows reports nothing more.
				if (starts++ === 0) throw new Error("boom in session_start");
			});
		});
		mode.deferredStartupPending = true;

		await mode.completeDeferredStartup();

		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(starts, 2, "the startup reload started the extension again");
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: boom in session_start'), 1, chat);
		assert.equal(occurrences(chat, "Extension loading failed"), 0, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"one interactive startup shows a resources_discover failure once when startup discovers resources twice (#5501)",
	async () => {
		const { mode } = await createMode((pi) => {
			pi.on("resources_discover", () => {
				throw new Error("review discovery failure");
			});
		});
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: review discovery failure'), 1, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"a startup that settles project trust shows a resources_discover failure once, and /reload still shows it (#5501)",
	async () => {
		let discoveries = 0;
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", () => {
					discoveries++;
					throw new Error("discovery failure");
				});
			},
			{ settlesStartupTrust: true },
		);
		mode.deferredStartupPending = true;

		await mode.completeDeferredStartup();

		const error = 'Extension "<inline:1>" error: discovery failure';
		assert.equal(discoveries, 2, "settling trust discovered the resources again, as documented");
		const startupChat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(startupChat, error), 1, startupChat);

		await mode.handleReloadCommand();

		const reloadChat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(discoveries, 3);
		assert.equal(occurrences(reloadChat, error), 2, reloadChat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"/reload in the interactive host shows the error of an extension whose session_start throws and keeps the reload (#5501)",
	async () => {
		const { mode } = await createMode((pi) => {
			pi.on("session_start", (event) => {
				if (event.reason === "reload") throw new Error("boom in reload");
			});
			pi.registerCommand("reloaded-command", { description: "registered by every load", handler: async () => {} });
		});
		await mode.bindCurrentSessionExtensions();
		const runnerBefore = mode.session.extensionRunner;

		await mode.handleReloadCommand();

		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: boom in reload'), 1, chat);
		assert.equal(occurrences(chat, "Reload failed"), 0, chat);
		assert.notEqual(mode.session.extensionRunner, runnerBefore, "the reload took effect");
		assert.ok(mode.session.extensionRunner.getCommand("reloaded-command"));
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"/new in the interactive host shows the error of an extension whose session_start throws and opens the new session (#5501)",
	async () => {
		const { mode, faux } = await createMode((pi) => {
			pi.on("session_start", (event) => {
				if (event.reason === "new") throw new Error("boom in new");
			});
		});
		await mode.bindCurrentSessionExtensions();
		const exit = vi.spyOn(process, "exit").mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		cleanup.push(async () => exit.mockRestore());
		const previous = mode.session;

		await mode.handleClearCommand();

		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.notEqual(mode.session, previous, "the new session replaced the old one");
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: boom in new'), 1, chat);
		faux.setResponses([fauxAssistantMessage("new session works")]);
		await mode.session.prompt("hello");
		const last = mode.session.messages.at(-1);
		assert.deepEqual(last?.role === "assistant" ? last.content : undefined, [
			{ type: "text", text: "new session works" },
		]);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

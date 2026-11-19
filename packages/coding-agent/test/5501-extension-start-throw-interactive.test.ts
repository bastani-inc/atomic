/**
 * The in-process interactive host reports an extension whose `session_start` throws and keeps its session: the error
 * is shown once, it stays on screen after deferred startup rebuilds the transcript, and the session still answers
 * prompts. Before, the bind rejected with `ExtensionStartupError`, the session was closed and every prompt answered
 * "Session is closed" (#5501).
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { ExtensionFactory, InlineExtension, LoadExtensionsResult } from "../src/core/extensions/types.js";
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
async function createMode(
	extension: ExtensionFactory | InlineExtension[],
	options: {
		settlesStartupTrust?: boolean;
		additionalExtensionPaths?: string[];
		extensionsOverride?: (base: LoadExtensionsResult) => LoadExtensionsResult;
	} = {},
) {
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
				extensionFactories: Array.isArray(extension) ? extension : [extension],
				additionalExtensionPaths: options.additionalExtensionPaths,
				extensionsOverride: options.extensionsOverride,
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

type DiscoveryHandler = (...args: unknown[]) => Promise<unknown>;

function rebuildDiscovery(wrap: (handler: DiscoveryHandler) => DiscoveryHandler) {
	return (base: LoadExtensionsResult): LoadExtensionsResult => ({
		...base,
		extensions: base.extensions.map((ext) => {
			const discovered = ext.handlers.get("resources_discover");
			if (!discovered) return ext;
			const handlers = new Map(ext.handlers);
			handlers.set("resources_discover", discovered.map(wrap));
			return { ...ext, handlers };
		}),
	});
}

test(
	"startup reports both handlers when a factory changes the handler behind a rebuilt forwarder (#5501)",
	async () => {
		const calls: string[] = [];
		function firstDirectory() {
			calls.push("first");
			throw new Error("directory unavailable");
		}
		function secondDirectory() {
			calls.push("second");
			throw new Error("directory unavailable");
		}
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", calls.length === 0 ? firstDirectory : secondDirectory);
			},
			{
				extensionsOverride: rebuildDiscovery(
					(original) =>
						(...args) =>
							original(...args),
				),
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		assert.deepEqual(calls, ["first", "second"]);
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(occurrences(chat, "at firstDirectory"), 1, chat);
		assert.equal(occurrences(chat, "at secondDirectory"), 1, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each(["its own", "the first"] as const)(
	"startup reports both installations when each forwards to %s handler (#5501)",
	async (delegate) => {
		let calls = 0;
		const factory: ExtensionFactory = (pi) => {
			pi.on("resources_discover", () => {
				calls++;
				throw new Error("directory unavailable");
			});
		};
		const originals = new Map<string, DiscoveryHandler>();
		const paths = ["<inline:first>", "<inline:second>"];
		const forwarders = new Map(
			paths.map((path) => [
				path,
				(...args: unknown[]) => originals.get(delegate === "the first" ? paths[0] : path)!(...args),
			]),
		);
		let pass = 0;
		const { mode } = await createMode(
			[
				{ name: "first", factory },
				{ name: "second", factory },
			],
			{
				extensionsOverride(base) {
					const path = paths[pass++];
					const ext = base.extensions.find((entry) => entry.path === path)!;
					for (const entry of base.extensions) {
						const handler = entry.handlers.get("resources_discover")?.[0];
						if (handler) originals.set(entry.path, handler);
					}
					const handlers = new Map(ext.handlers);
					handlers.set("resources_discover", [forwarders.get(ext.path)!]);
					return { ...base, extensions: [{ ...ext, handlers }] };
				},
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		assert.equal(calls, 2);
		const chat = normalizeRenderedOutput(mode.chatContainer);
		for (const path of paths) assert.equal(occurrences(chat, `Extension "${path}" error: directory unavailable`), 1);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"startup reports both failures when rebuilt discovery callbacks replace the handler's error (#5501)",
	async () => {
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", () => {
					throw new Error("directory unavailable");
				});
			},
			{
				extensionsOverride: rebuildDiscovery((original) => (...args) => {
					try {
						return original(...args);
					} catch {
						throw new Error("directory unavailable");
					}
				}),
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const row = 'Extension "<inline:1>" error: directory unavailable';
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 2);
		await mode.handleReloadCommand();
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 3);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each(["then", "skillPaths"])(
	"startup reports each failing %s getter installed by a rebuilt discovery callback (#5501)",
	async (property) => {
		let getterCalls = 0;
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", () => ({ skillPaths: [] }));
			},
			{
				extensionsOverride: rebuildDiscovery(
					(original) =>
						(...args) =>
							Object.defineProperty(original(...args), property, {
								get() {
									getterCalls++;
									throw new Error("directory unavailable");
								},
							}),
				),
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const row = 'Extension "<inline:1>" error: directory unavailable';
		assert.equal(getterCalls, 2);
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 2);
		await mode.handleReloadCommand();
		assert.equal(getterCalls, 3);
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 3);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"startup reports distinct discovery handlers with the same error but not a repeat of the same handler (#5501)",
	async () => {
		let discoveries = 0;
		const { mode } = await createMode(
			(pi) => {
				// Removing a preceding handler changes the others' list positions, not their identities.
				const unsubscribe = pi.on("resources_discover", () => unsubscribe());
				pi.on("resources_discover", function firstDirectory() {
					discoveries++;
					throw new Error("unavailable directory");
				});
				pi.on("resources_discover", function secondDirectory() {
					if (discoveries === 2) throw new Error("unavailable directory");
				});
			},
			{ settlesStartupTrust: true },
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(discoveries, 2);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: unavailable directory'), 2, chat);
		assert.equal(occurrences(chat, "at firstDirectory"), 1, chat);
		assert.equal(occurrences(chat, "at secondDirectory"), 1, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"startup reports a loader override and a factory discovery handler separately when both throw the same error (#5501)",
	async () => {
		let overrides = 0;
		let discoveries = 0;
		const { mode } = await createMode(
			(pi) => {
				pi.on("resources_discover", function factoryDirectory() {
					discoveries++;
					throw new Error("unavailable directory");
				});
			},
			{
				settlesStartupTrust: true,
				extensionsOverride(base) {
					const extension = base.extensions.find((entry) => entry.path === "<inline:1>");
					extension?.handlers.get("resources_discover")?.unshift(async function overrideDirectory() {
						if (++overrides === 2) throw new Error("unavailable directory");
					});
					return base;
				},
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(overrides, 2);
		assert.equal(discoveries, 2);
		assert.equal(occurrences(chat, "at factoryDirectory"), 1, chat);
		assert.equal(occurrences(chat, "at overrideDirectory"), 1, chat);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: unavailable directory'), 2, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"a startup reload reports both registrations of a raw session_start callback beside the factory callback (#5501)",
	async () => {
		let rawCalls = 0;
		let factoryCalls = 0;
		async function sharedStartup() {
			if (++rawCalls > 2) throw new Error("startup error");
		}
		const { mode } = await createMode(
			(pi) => {
				pi.on("session_start", function factoryStartup() {
					factoryCalls++;
					throw new Error("startup error");
				});
			},
			{
				extensionsOverride(base) {
					const extension = base.extensions.find((entry) => entry.path === "<inline:1>");
					extension?.handlers.get("session_start")?.unshift(sharedStartup, sharedStartup);
					return base;
				},
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(factoryCalls, 2);
		assert.equal(rawCalls, 4);
		assert.equal(occurrences(chat, "at factoryStartup"), 1, chat);
		assert.equal(occurrences(chat, "at sharedStartup"), 2, chat);
		assert.equal(occurrences(chat, 'Extension "<inline:1>" error: startup error'), 3, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test(
	"a rediscovered file reports its handler once at startup and again on /reload (#5501)",
	async () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-5501-file-"));
		cleanup.push(async () => rmSync(dir, { recursive: true, force: true }));
		const extension = join(dir, "extension.ts");
		const calls = join(dir, "calls");
		writeFileSync(
			extension,
			`import {appendFileSync} from "node:fs";
		export default (pi) => {
			pi.on("resources_discover", () => {
				appendFileSync(${JSON.stringify(calls)}, "x");
				throw "file discovery failed";
			});
		};`,
		);
		const { mode } = await createMode([], { additionalExtensionPaths: [extension] });
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const row = "error: file discovery failed";
		assert.equal(readFileSync(calls, "utf8"), "xx");
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 1);
		await mode.handleReloadCommand();
		assert.equal(readFileSync(calls, "utf8"), "xxx");
		assert.equal(occurrences(normalizeRenderedOutput(mode.chatContainer), row), 2);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each([false, true])(
	"startup distinguishes two raw installations from pi.on even for the same callable (separate lists: %s) (#5501)",
	async (separateLists) => {
		let calls = 0;
		async function sharedSite() {
			// With separate lists the last installation only fails on the completion pass.
			if (++calls !== 3 || !separateLists) throw new Error("shared error");
		}
		const factory: ExtensionFactory = (pi) => {
			pi.on("resources_discover", sharedSite);
		};
		const { mode } = await createMode(
			[
				{ name: "same", factory },
				{ name: "same", factory: () => {} },
			],
			{
				settlesStartupTrust: true,
				extensionsOverride(base) {
					const [a, b] = base.extensions.filter((ext) => ext.path === "<inline:same>");
					a.handlers.get("resources_discover")!.push(sharedSite);
					const target = separateLists ? b : a;
					target.handlers.set("resources_discover", [
						...(target.handlers.get("resources_discover") ?? []),
						sharedSite,
					]);
					return base;
				},
			},
		);
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		assert.equal(calls, 6);
		assert.equal(occurrences(chat, "at sharedSite"), 3, chat);
		assert.equal(occurrences(chat, 'Extension "<inline:same>" error: shared error'), 3, chat);
	},
	INTERACTIVE_HOST_TIMEOUT_MS,
);

test.each([
	{ label: "two named factories", name: "filesystem", deferred: false, copy: false },
	{ label: "named and unnamed factories", name: "2", deferred: false, copy: false },
	{ label: "two named factories re-evaluated by deferred startup", name: "filesystem", deferred: true, copy: false },
	{ label: "same-named factories copied by a loader override", name: "filesystem", deferred: true, copy: true },
])(
	"startup distinguishes $label with the same displayed extension path and /reload reports them again (#5501)",
	async ({ name, deferred, copy }) => {
		let left = 0;
		let right = 0;
		const first: ExtensionFactory = (pi) => {
			pi.on("resources_discover", function firstProvider() {
				left++;
				throw new Error("provider error");
			});
		};
		const second: ExtensionFactory = (pi) => {
			pi.on("resources_discover", function secondProvider() {
				if (++right >= 2) throw new Error("provider error");
			});
		};
		const { mode } = await createMode([{ name, factory: first }, name === "2" ? second : { name, factory: second }], {
			settlesStartupTrust: !deferred,
			extensionsOverride: copy
				? (base) => ({ ...base, extensions: base.extensions.map((ext) => ({ ...ext })) })
				: undefined,
		});
		mode.deferredStartupPending = true;
		await mode.completeDeferredStartup();
		const chat = normalizeRenderedOutput(mode.chatContainer);
		const row = `Extension "<inline:${name}>" error: provider error`;
		assert.deepEqual([left, right], [2, 2]);
		assert.equal(occurrences(chat, "at firstProvider"), 1, chat);
		assert.equal(occurrences(chat, "at secondProvider"), 1, chat);
		assert.equal(occurrences(chat, row), 2, chat);
		await mode.handleReloadCommand();
		const reload = normalizeRenderedOutput(mode.chatContainer);
		assert.deepEqual([left, right], [3, 3]);
		assert.equal(occurrences(reload, row), 4, reload);
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

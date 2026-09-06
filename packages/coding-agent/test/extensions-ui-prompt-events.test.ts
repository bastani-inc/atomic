import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import type {
	ExtensionFactory,
	ExtensionUIContext,
	UIPromptEndEvent,
	UIPromptKind,
	UIPromptStartEvent,
} from "../src/core/extensions/types.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { EngineProjectTrustService } from "../src/modes/interactive-engine/engine-project-trust.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import {
	type InteractiveEngineCommand,
	parseInteractiveEngineCommand,
} from "../src/modes/interactive-engine/protocol.js";
import "../src/modes/interactive/interactive-extension-runtime.ts";
import "../src/modes/interactive/interactive-session-routing.ts";
import type { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type UIPromptEvent = UIPromptStartEvent | UIPromptEndEvent;

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (reason: Error) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createUI(overrides: Partial<ExtensionUIContext> = {}): ExtensionUIContext {
	return { ...noOpUIContext, ...overrides };
}

async function flushNotifications(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function createRunner(
	options: {
		onStart?: (event: UIPromptStartEvent) => void | Promise<void>;
		onEnd?: (event: UIPromptEndEvent) => void | Promise<void>;
		configure?: ExtensionFactory;
	} = {},
): Promise<{ runner: ExtensionRunner; events: UIPromptEvent[] }> {
	const events: UIPromptEvent[] = [];
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		async (pi) => {
			pi.on("ui_prompt_start", async (event) => {
				events.push(event);
				await options.onStart?.(event);
			});
			pi.on("ui_prompt_end", async (event) => {
				events.push(event);
				await options.onEnd?.(event);
			});
			await options.configure?.(pi);
		},
		process.cwd(),
		createEventBus(),
		runtime,
		"<ui-prompt-events>",
	);
	return {
		runner: new ExtensionRunner([extension], runtime, process.cwd(), {} as never, {} as never),
		events,
	};
}

test("in-process extension shortcuts emit prompt lifecycle events", async () => {
	const shortcutFinished = deferred<void>();
	const { runner, events } = await createRunner({
		configure: (pi) => {
			pi.registerShortcut("ctrl+g", {
				description: "Open a prompt",
				handler: async (ctx) => {
					assert.equal(await ctx.ui.select("Shortcut prompt", ["one"]), "one");
					shortcutFinished.resolve();
				},
			});
		},
	});
	const rawUI = createUI({ select: async () => "one" });
	runner.setUIContext(rawUI, "tui");

	let onExtensionShortcut: ((data: string) => boolean) | undefined;
	const context = {
		keybindings: { getEffectiveConfig: () => ({}) },
		sessionManager: { getCwd: () => process.cwd() },
		session: {
			scopedModels: [],
			model: undefined,
			modelRuntime: {},
			isStreaming: false,
			settingsManager: { isProjectTrusted: () => true },
			agent: { signal: new AbortController().signal },
			pendingMessageCount: 0,
			systemPrompt: "",
			abort: () => {},
			getContextUsage: () => undefined,
			compact: async () => undefined,
		},
		createExtensionUIContext: () => rawUI,
		get defaultEditor() {
			return {
				set onExtensionShortcut(handler: (data: string) => boolean) {
					onExtensionShortcut = handler;
				},
			};
		},
		showError: (message: string) => assert.fail(message),
	};
	const setup = Reflect.get(InteractiveModeBase.prototype, "setupExtensionShortcuts") as (
		this: typeof context,
		extensionRunner: ExtensionRunner,
	) => void;

	setup.call(context, runner);
	assert.equal(onExtensionShortcut?.("\x07"), true);
	await shortcutFinished.promise;
	await flushNotifications();

	assert.deepEqual(events, [
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Shortcut prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Shortcut prompt" },
	]);
});

test("all blocking extension UI prompts emit lifecycle events and preserve their arguments", async () => {
	const { runner, events } = await createRunner();
	const signal = new AbortController().signal;
	const dialogOptions = { signal };
	const customOptions = { overlay: true } as const;
	const customFactory: Parameters<ExtensionUIContext["custom"]>[0] = () => ({
		render: () => [],
		invalidate: () => {},
	});
	const calls: UIPromptKind[] = [];

	runner.setUIContext(
		createUI({
			select: async (title, options, opts) => {
				assert.equal(title, "Select title");
				assert.deepEqual(options, ["one", "two"]);
				assert.equal(opts, dialogOptions);
				calls.push("select");
				return "one";
			},
			confirm: async (title, message, opts) => {
				assert.equal(title, "Confirm title");
				assert.equal(message, "Continue?");
				assert.equal(opts, dialogOptions);
				calls.push("confirm");
				return true;
			},
			input: async (title, placeholder, opts) => {
				assert.equal(title, "Input title");
				assert.equal(placeholder, "Type here");
				assert.equal(opts, dialogOptions);
				calls.push("input");
				return "typed";
			},
			editor: async (title, prefill, opts) => {
				assert.equal(title, "Editor title");
				assert.equal(prefill, "draft");
				assert.equal(opts, dialogOptions);
				calls.push("editor");
				return "edited";
			},
			custom: (async (factory, options) => {
				assert.equal(factory, customFactory);
				assert.equal(options, customOptions);
				calls.push("custom");
				return "custom result";
			}) as ExtensionUIContext["custom"],
		}),
	);

	const ui = runner.getUIContext();
	assert.equal(await ui.select("Select title", ["one", "two"], dialogOptions), "one");
	assert.equal(await ui.confirm("Confirm title", "Continue?", dialogOptions), true);
	assert.equal(await ui.input("Input title", "Type here", dialogOptions), "typed");
	assert.equal(await ui.editor("Editor title", "draft", dialogOptions), "edited");
	assert.equal(await ui.custom(customFactory, customOptions), "custom result");
	await flushNotifications();

	assert.deepEqual(calls, ["select", "confirm", "input", "editor", "custom"]);
	assert.deepEqual(events, [
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Select title" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Select title" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "Confirm title" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "Confirm title" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "Input title" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "input", title: "Input title" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "editor", title: "Editor title" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "editor", title: "Editor title" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "custom" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "custom" },
	]);
});

test("Atomic-only host UI methods pass through without prompt lifecycle events", async () => {
	const { runner, events } = await createRunner();
	const hostInputForm: NonNullable<ExtensionUIContext["hostInputForm"]> = async () => undefined;
	const hostSessionPicker: NonNullable<ExtensionUIContext["hostSessionPicker"]> = () => ({
		result: Promise.resolve(undefined),
		update: () => {},
		error: () => {},
		close: () => {},
	});
	runner.setUIContext(createUI({ hostInputForm, hostSessionPicker }));

	const ui = runner.getUIContext();
	assert.equal(ui.hostInputForm, hostInputForm);
	assert.equal(ui.hostSessionPicker, hostSessionPicker);
	await flushNotifications();
	assert.deepEqual(events, []);
});

test("nested prompts coalesce into the outer prompt span", async () => {
	const { runner, events } = await createRunner();
	const outer = deferred<string | undefined>();
	const inner = deferred<string | undefined>();
	let ui!: ExtensionUIContext;

	runner.setUIContext(
		createUI({
			select: async () => {
				const nested = ui.input("Nested input");
				inner.resolve("nested value");
				await nested;
				return outer.promise;
			},
			input: () => inner.promise,
		}),
	);
	ui = runner.getUIContext();

	const outerPrompt = ui.select("Outer select", ["one"]);
	await flushNotifications();
	assert.deepEqual(events, [{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Outer select" }]);

	outer.resolve("one");
	assert.equal(await outerPrompt, "one");
	await flushNotifications();

	assert.deepEqual(events, [
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Outer select" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Outer select" },
	]);
});

test("overlapping prompts retain outer metadata until every prompt settles", async () => {
	const { runner, events } = await createRunner();
	const first = deferred<string | undefined>();
	const second = deferred<boolean>();
	runner.setUIContext(
		createUI({
			select: () => first.promise,
			confirm: () => second.promise,
		}),
	);
	const ui = runner.getUIContext();

	const firstPrompt = ui.select("Outer title", ["one"]);
	const secondPrompt = ui.confirm("Inner title", "Continue?");
	await flushNotifications();
	assert.equal(events.length, 1);

	first.resolve("one");
	assert.equal(await firstPrompt, "one");
	await flushNotifications();
	assert.equal(events.length, 1);

	second.resolve(true);
	assert.equal(await secondPrompt, true);
	await flushNotifications();
	assert.deepEqual(events, [
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Outer title" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Outer title" },
	]);
});

test("synchronous throws and asynchronous rejections each end their prompt span once", async () => {
	const { runner, events } = await createRunner();
	const syncError = new Error("sync failure");
	const asyncError = new Error("async failure");
	runner.setUIContext(
		createUI({
			select: () => {
				throw syncError;
			},
			input: async () => {
				throw asyncError;
			},
		}),
	);
	const ui = runner.getUIContext();

	assert.throws(() => ui.select("Sync prompt", ["one"]), syncError);
	await assert.rejects(ui.input("Async prompt"), asyncError);
	await flushNotifications();

	assert.deepEqual(events, [
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Sync prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Sync prompt" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "input", title: "Async prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "input", title: "Async prompt" },
	]);
});

test("pending lifecycle handlers do not delay prompt display or settlement", async () => {
	const startHandler = deferred<void>();
	const endHandler = deferred<void>();
	const { runner, events } = await createRunner({
		onStart: () => startHandler.promise,
		onEnd: () => endHandler.promise,
	});
	const prompt = deferred<string | undefined>();
	let opened = false;
	runner.setUIContext(
		createUI({
			select: () => {
				opened = true;
				return prompt.promise;
			},
		}),
	);

	const result = runner.getUIContext().select("Queued notifications", ["one"]);
	assert.equal(opened, true);
	await flushNotifications();
	assert.equal(events[0]?.type, "ui_prompt_start");

	prompt.resolve("one");
	assert.equal(await result, "one");
	await flushNotifications();
	assert.deepEqual(
		events.map((event) => event.type),
		["ui_prompt_start", "ui_prompt_end"],
	);

	startHandler.resolve();
	endHandler.resolve();
});

test("rebinding the UI context closes the old span without corrupting the new span", async () => {
	const { runner, events } = await createRunner();
	const oldPrompt = deferred<string | undefined>();
	const newPrompt = deferred<boolean>();
	runner.setUIContext(createUI({ select: () => oldPrompt.promise }));
	const oldResult = runner.getUIContext().select("Old prompt", ["one"]);
	await flushNotifications();

	runner.setUIContext(createUI({ confirm: () => newPrompt.promise }));
	const newResult = runner.getUIContext().confirm("New prompt", "Continue?");
	await flushNotifications();

	oldPrompt.resolve("one");
	assert.equal(await oldResult, "one");
	await flushNotifications();
	assert.equal(events.length, 3);

	newPrompt.resolve(true);
	assert.equal(await newResult, true);
	await flushNotifications();
	assert.deepEqual(events, [
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "select", title: "Old prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "select", title: "Old prompt" },
		{ type: "ui_prompt_start", reason: "ui_prompt", kind: "confirm", title: "New prompt" },
		{ type: "ui_prompt_end", reason: "ui_prompt", kind: "confirm", title: "New prompt" },
	]);
});

// #2873: exercise the real host command and selector cancellation/disposal callbacks.
test("/trust reports a balanced wait on cancel, selection, and selector replacement", async () => {
	initTheme("dark");
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-trust-prompt-"));
	try {
		for (const action of ["cancel", "select", "dispose"] as const) {
			const { runner, events } = await createRunner();
			runner.setUIContext(createUI(), "tui");
			let mounted!: { component: TrustSelectorComponent; dispose?: () => void };
			const host = {
				sessionManager: { getCwd: () => agentDir },
				runtimeHost: { session: { extensionRunner: runner }, services: { agentDir } },
				settingsManager: { isProjectTrusted: () => false },
				showSelector: (create: (done: () => void) => typeof mounted) => {
					mounted = create(() => mounted.dispose?.());
				},
				showStatus: () => {},
				showError: (message: string) => assert.fail(message),
				ui: { requestRender: () => {} },
			};
			const showTrust = Reflect.get(InteractiveModeBase.prototype, "showTrustSelector") as (
				this: typeof host,
			) => void;
			showTrust.call(host);
			await flushNotifications();
			assert.deepEqual(events, [
				{ type: "ui_prompt_start", reason: "project_trust", kind: "select", title: "Project trust" },
			]);
			if (action === "dispose") mounted.dispose?.();
			else mounted.component.handleInput(action === "cancel" ? "\x1b" : "\n");
			await flushNotifications();
			assert.deepEqual(events, [
				{ type: "ui_prompt_start", reason: "project_trust", kind: "select", title: "Project trust" },
				{ type: "ui_prompt_end", reason: "project_trust", kind: "select", title: "Project trust" },
			]);
		}
	} finally {
		rmSync(agentDir, { recursive: true, force: true });
	}
});

function createIsolatedTrustRuntime(runner: ExtensionRunner) {
	const service = new EngineProjectTrustService(() => runner);
	const commands: InteractiveEngineCommand[] = [];
	let generation = 1;
	let transportFailed = false;
	const runtime = new IsolatedInteractiveRuntime(
		{ session: {}, services: {}, diagnostics: [] } as never,
		async () => {
			throw new Error("unused runtime factory");
		},
		{
			onEvent: () => () => {},
			onGenerationEnded: () => () => {},
			getGeneration: () => generation,
			sendInteractiveEngineCommand: (command: InteractiveEngineCommand) => {
				if (transportFailed) throw new Error("transport closed");
				commands.push(command);
				assert.equal(service.handleLine(JSON.stringify(command)), true);
			},
		} as never,
	);
	return {
		runtime,
		service,
		commands,
		replaceGeneration: () => {
			service.dispose();
			generation++;
		},
		failTransport: () => {
			transportFailed = true;
		},
	};
}

// #2873: the isolated host must notify the child runner, not its empty local runner.
test("isolated host trust waits reach subscribers and coalesce with extension prompts", async () => {
	for (const outerReason of ["project_trust", "ui_prompt"] as const) {
		const { runner, events } = await createRunner();
		const extension = deferred<boolean>();
		const trust = deferred<string>();
		runner.setUIContext(createUI({ confirm: () => extension.promise }), "tui");
		const { runtime, commands } = createIsolatedTrustRuntime(runner);
		const openTrust = () => runtime.withProjectTrustPrompt("select", "Project trust", () => trust.promise);
		const openExtension = () => runner.getUIContext().confirm("Extension", "Continue?");
		const first = outerReason === "project_trust" ? openTrust() : openExtension();
		const second = outerReason === "project_trust" ? openExtension() : openTrust();
		await flushNotifications();
		assert.equal(events.length, 1);
		assert.equal(events[0].reason, outerReason);
		trust.resolve("no");
		await flushNotifications();
		assert.equal(events.length, 1);
		extension.resolve(false);
		await Promise.all([first, second]);
		await flushNotifications();
		assert.deepEqual(events[1], { ...events[0], type: "ui_prompt_end" });
		assert.equal(commands.length, 2);
		assert.equal(commands[0].componentId, commands[1].componentId);
	}
});

test("isolated trust notification failures and retired generations never block a host decision", async () => {
	const { runner, events } = await createRunner();
	runner.setUIContext(createUI(), "tui");
	const probe = createIsolatedTrustRuntime(runner);
	const trust = deferred<boolean>();
	const pending = probe.runtime.withProjectTrustPrompt("select", "Project trust", () => trust.promise);
	await flushNotifications();
	probe.replaceGeneration();
	trust.resolve(false);
	assert.equal(await pending, false);
	await flushNotifications();
	assert.equal(probe.commands.length, 1, "no stale close is sent to the replacement engine");
	assert.deepEqual(
		events.map((event) => event.type),
		["ui_prompt_start", "ui_prompt_end"],
	);
	probe.failTransport();
	assert.equal(await probe.runtime.withProjectTrustPrompt("select", "Project trust", async () => true), true);
	assert.equal(probe.commands.length, 1);
});

test("trust control frames reject malformed payloads and tolerate duplicate delivery", async () => {
	const { runner, events } = await createRunner();
	runner.setUIContext(createUI(), "tui");
	const service = new EngineProjectTrustService(() => runner);
	for (const payload of [
		{ type: "engine_project_trust_start", componentId: "a", kind: "custom", title: "Trust" },
		{ type: "engine_project_trust_start", componentId: "a", kind: "select" },
		{ type: "engine_project_trust_end", componentId: 4 },
	])
		assert.equal(parseInteractiveEngineCommand(JSON.stringify(payload)), undefined);
	const start = JSON.stringify({
		type: "engine_project_trust_start",
		componentId: "a",
		kind: "select",
		title: "Trust",
	});
	const end = JSON.stringify({ type: "engine_project_trust_end", componentId: "a" });
	assert.equal(service.handleLine(start), true);
	assert.equal(service.handleLine(start), true);
	await flushNotifications();
	assert.equal(events.length, 1);
	service.handleLine(end);
	service.handleLine(end);
	await flushNotifications();
	assert.deepEqual(events[1], { ...events[0], type: "ui_prompt_end" });
	assert.equal(events.length, 2);
});

test("trust prompt failures and rebinding preserve one matching end", async () => {
	const { runner, events } = await createRunner();
	runner.setUIContext(createUI(), "tui");
	const failure = new Error("cannot mount selector");
	assert.throws(
		() =>
			runner.withProjectTrustPrompt("select", "Sync failure", () => {
				throw failure;
			}),
		failure,
	);
	await assert.rejects(
		runner.withProjectTrustPrompt("select", "Async failure", async () => {
			throw failure;
		}),
		failure,
	);
	const pending = deferred<void>();
	const result = runner.withProjectTrustPrompt("select", "Rebound", () => pending.promise);
	runner.setUIContext(createUI(), "tui");
	pending.resolve();
	await result;
	await flushNotifications();
	assert.deepEqual(events, [
		{ type: "ui_prompt_start", reason: "project_trust", kind: "select", title: "Sync failure" },
		{ type: "ui_prompt_end", reason: "project_trust", kind: "select", title: "Sync failure" },
		{ type: "ui_prompt_start", reason: "project_trust", kind: "select", title: "Async failure" },
		{ type: "ui_prompt_end", reason: "project_trust", kind: "select", title: "Async failure" },
		{ type: "ui_prompt_start", reason: "project_trust", kind: "select", title: "Rebound" },
		{ type: "ui_prompt_end", reason: "project_trust", kind: "select", title: "Rebound" },
	]);
});

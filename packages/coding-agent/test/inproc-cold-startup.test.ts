import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getApiProvider, registerApiProvider, resetApiProviders } from "@bastani/atomic-ai/compat";
import { afterEach, describe, it, vi } from "vitest";
import { NODE_TS_SOURCE_HOOK } from "../../../test/helpers/node-ts-sources.js";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	armPostStartupHighlightWarmup,
	onPostStartupTimerFired,
	stopPostStartupHighlightWarmup,
} from "../src/modes/interactive/post-startup-highlight.ts";
import * as syntaxHighlight from "../src/utils/syntax-highlight.ts";

const PREWARM_SYMBOL = Symbol.for("@bastani/atomic-ai/api-prewarm");
const SYNTAX_HIGHLIGHT_SRC = resolve(import.meta.dirname, "../src/utils/syntax-highlight.ts");

function createInprocRunHarness(options: {
	deferredStartupGate: Promise<void>;
	promptGate: Promise<void>;
	promptThrows?: Error;
	initialSubmission?: { text: string; draft?: { text: string; cursorLine: number; cursorCol: number } };
	deferredStartupPending?: boolean;
	initialMessages?: string[];
	onPrompt?: (text: string, emit: (event: Record<string, unknown>) => void, turnIndex: number) => Promise<void>;
}) {
	const ui = {
		invalidate: vi.fn(),
		requestRender: vi.fn(),
		terminal: { setProgress: vi.fn() },
	};
	const listeners = new Set<(event: Record<string, unknown>) => void>();
	const emitEvent = (event: Record<string, unknown>) => {
		for (const listener of [...listeners]) listener(event);
	};
	let turnIndex = 0;
	const mode: Record<string, unknown> = {
		options: {
			...(options.initialMessages ? { initialMessages: options.initialMessages } : {}),
		},
		runtimeHost: { modelFallbackMessage: undefined },
		version: "0.0.0",
		isInitialized: false,
		isShuttingDown: false,
		postStartupTimer: undefined,
		deferredStartupPending: options.deferredStartupPending ?? true,
		deferredStartupPromise: undefined,
		promptTurnWorkingLoaderActive: false,
		promptTurn: undefined,
		managedToolReadiness: "on-init",
		compactionQueuedMessages: [],
		compactionActive: false,
		workingRunMeter: { stop: vi.fn(), snapshot: () => undefined },
		startupNoticesContainer: { children: [], addChild: vi.fn() },
		resourceDisclosureContainer: { children: [] },
		chatContainer: { children: [] },
		editorContainer: { children: [] },
		statusContainer: { clear: vi.fn() },
		settingsManager: SettingsManager.inMemory({ lastChangelogVersion: "0.0.0" }),
		ui,
		editor: {
			getExpandedText: () => "",
			getText: () => "",
			setText: vi.fn(),
			restoreDraft: vi.fn(),
		},
		defaultEditor: {
			getExpandedText: () => "",
			getText: () => "",
			setText: vi.fn(),
			restoreDraft: vi.fn(),
		},
		footer: { dispose: vi.fn() },
		footerDataProvider: { startGitWatcher: vi.fn(), dispose: vi.fn() },
		themeController: { applyFromSettings: vi.fn().mockResolvedValue(undefined), disableAutoSync: vi.fn() },
		sessionStartup: { cancelled: false },
		pendingUserInputs: options.initialSubmission ? [options.initialSubmission] : [],
		startupReplayActiveInput: undefined,
		inputHandlerReadyRecorded: false,
		userMessagesShownBySession: 0,
		session: {
			state: { messages: [] },
			isStreaming: false,
			model: undefined,
			modelRuntime: { getError: () => undefined, getWarning: () => undefined },
			subscribe: vi.fn((listener: (event: Record<string, unknown>) => void) => {
				listeners.add(listener);
				return () => listeners.delete(listener);
			}),
			resumeQueuedMessages: vi.fn().mockResolvedValue(undefined),
			_tryExecuteExtensionCommand: vi.fn().mockResolvedValue(false),
			prompt: vi.fn(async (text: string, promptOpts?: { preflightResult?: (ok: boolean, d?: string) => void }) => {
				const currentTurn = ++turnIndex;
				if (options.onPrompt) {
					await options.onPrompt(text, emitEvent, currentTurn);
					promptOpts?.preflightResult?.(true, "started");
					return;
				}
				await options.promptGate;
				if (options.promptThrows) {
					promptOpts?.preflightResult?.(false);
					throw options.promptThrows;
				}
				promptOpts?.preflightResult?.(true, "started");
			}),
		},
		init: vi.fn(async function (this: Record<string, unknown>) {
			this.isInitialized = true;
		}),
		startManagedToolReadiness: vi.fn(),
		showWorkingLoaderNow: vi.fn(),
		stopWorkingLoader: vi.fn(),
		clearWorkingLoader: vi.fn(),
		showError: vi.fn(),
		showWarning: vi.fn(),
		showNewVersionNotification: vi.fn(),
		showPackageUpdateNotification: vi.fn(),
		checkForPackageUpdates: vi.fn().mockResolvedValue([]),
		checkTmuxKeyboardSetup: vi.fn().mockResolvedValue(undefined),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
		updateTerminalTitle: vi.fn(),
		discardDeferredRenderedUserInput: vi.fn(),
		expectStartedUserInput: vi.fn(),
		showStartupNoticesIfNeeded: vi.fn(),
		disposeActiveSelector: vi.fn(),
		disposeInteractiveEngineHost: vi.fn(),
		clearExtensionTerminalInputListeners: vi.fn(),
		unregisterSignalHandlers: vi.fn(),
		stopInteractiveTui: vi.fn(),
		completeDeferredStartup: vi.fn(async function (this: Record<string, unknown>) {
			await options.deferredStartupGate;
			this.deferredStartupPending = false;
		}),
		ensureDeferredStartupComplete: InteractiveMode.prototype.ensureDeferredStartupComplete,
		getUserInput: InteractiveMode.prototype.getUserInput,
		runUserPromptTurn: InteractiveMode.prototype.runUserPromptTurn,
		stop: InteractiveMode.prototype.stop,
	};
	return { mode, ui, emitEvent };
}

afterEach(() => {
	resetApiProviders();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("in-process cold startup highlight scheduling and API prewarm", () => {
	it("defers background loadAllHighlightLanguages until both deferred startup and active first prompt turn settle, then runs after quiet window", async () => {
		vi.useFakeTimers();
		const loadHighlightSpy = vi.spyOn(syntaxHighlight, "loadAllHighlightLanguages").mockResolvedValue();
		const deferredGate = Promise.withResolvers<void>();
		const promptGate = Promise.withResolvers<void>();
		const { mode, ui } = createInprocRunHarness({
			deferredStartupGate: deferredGate.promise,
			promptGate: promptGate.promise,
			initialSubmission: { text: "hello" },
		});

		void InteractiveMode.prototype.run.call(mode as unknown as InteractiveMode);
		// Let init() finish and runUserPromptTurn enter completeDeferredStartup().
		await vi.advanceTimersByTimeAsync(10);
		assert.equal(loadHighlightSpy.mock.calls.length, 0);

		// Advance past the 500ms postStartupTimer while deferred startup is still running (cold Windows).
		await vi.advanceTimersByTimeAsync(700);
		assert.equal(
			loadHighlightSpy.mock.calls.length,
			0,
			"loadAllHighlightLanguages must not run while deferred startup is in progress",
		);

		// Finish deferred startup while session.prompt() is still in flight (loading API / sending HTTP POST).
		deferredGate.resolve();
		await vi.advanceTimersByTimeAsync(700);
		assert.equal(
			loadHighlightSpy.mock.calls.length,
			0,
			"loadAllHighlightLanguages must not run while the first prompt turn is still in flight",
		);

		// Finish the prompt turn; highlight warmup must NOT fire synchronously (0ms) right behind turn end,
		// then MUST fire once the quiet window elapses so languages are never starved.
		promptGate.resolve();
		await vi.advanceTimersByTimeAsync(50);
		assert.equal(
			loadHighlightSpy.mock.calls.length,
			0,
			"loadAllHighlightLanguages must wait for the quiet window after turn completion",
		);

		await vi.advanceTimersByTimeAsync(500);
		assert.equal(loadHighlightSpy.mock.calls.length, 1);
		assert.ok(ui.invalidate.mock.calls.length >= 1);
		assert.ok(ui.requestRender.mock.calls.length >= 1);

		mode.isShuttingDown = true;
		InteractiveMode.prototype.stop.call(mode as unknown as InteractiveMode);
	});

	it("releases the highlight gate after a failed preflight turn and cancels cleanly on stop()", async () => {
		vi.useFakeTimers();
		const loadHighlightSpy = vi.spyOn(syntaxHighlight, "loadAllHighlightLanguages").mockResolvedValue();

		// Part A: preflight error must not starve background highlight warmup once quiet.
		const deferredA = Promise.withResolvers<void>();
		const promptA = Promise.withResolvers<void>();
		const harnessA = createInprocRunHarness({
			deferredStartupGate: deferredA.promise,
			promptGate: promptA.promise,
			promptThrows: new Error("no credentials"),
			initialSubmission: { text: "hello" },
		});
		void InteractiveMode.prototype.run.call(harnessA.mode as unknown as InteractiveMode);
		await vi.advanceTimersByTimeAsync(600);
		assert.equal(loadHighlightSpy.mock.calls.length, 0);
		deferredA.resolve();
		promptA.resolve();
		await vi.advanceTimersByTimeAsync(600);
		assert.equal(loadHighlightSpy.mock.calls.length, 1, "failed preflight must release gate and allow warmup");
		harnessA.mode.isShuttingDown = true;
		InteractiveMode.prototype.stop.call(harnessA.mode as unknown as InteractiveMode);

		// Part B: stop() during quiet re-arm cancels warmup completely with zero extra calls or renders.
		loadHighlightSpy.mockClear();
		const deferredB = Promise.withResolvers<void>();
		const promptB = Promise.withResolvers<void>();
		const harnessB = createInprocRunHarness({
			deferredStartupGate: deferredB.promise,
			promptGate: promptB.promise,
			initialSubmission: { text: "hello" },
		});
		void InteractiveMode.prototype.run.call(harnessB.mode as unknown as InteractiveMode);
		await vi.advanceTimersByTimeAsync(600);
		deferredB.resolve();
		promptB.resolve();
		await vi.advanceTimersByTimeAsync(50);
		harnessB.mode.isShuttingDown = true;
		InteractiveMode.prototype.stop.call(harnessB.mode as unknown as InteractiveMode);
		const rendersAfterStop = harnessB.ui.requestRender.mock.calls.length;
		await vi.advanceTimersByTimeAsync(2000);
		assert.equal(
			loadHighlightSpy.mock.calls.length,
			0,
			"stop() must prevent deferred highlight warmup from starting",
		);
		assert.equal(harnessB.ui.requestRender.mock.calls.length, rendersAfterStop);
	});

	it("completeDeferredStartup starts in-process model API prewarm immediately even when an early prompt turn is active, while respecting extension-streamed models and isolated hosts", async () => {
		let prewarmCalls = 0;
		const customApi = "test-inproc-prewarm-api" as "openai-completions";
		registerApiProvider({
			api: customApi,
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		});
		Object.defineProperty(getApiProvider(customApi)!, PREWARM_SYMBOL, {
			value: async () => {
				prewarmCalls += 1;
			},
			enumerable: false,
			configurable: true,
		});

		const makeMode = (opts: { streamsThroughExtension: boolean; isShuttingDown?: boolean }) => ({
			options: {},
			runtimeHost: undefined,
			isShuttingDown: opts.isShuttingDown ?? false,
			session: {
				state: { messages: [] },
				model: { provider: "loop", id: "test-model", api: customApi },
				reload: vi.fn().mockResolvedValue(undefined),
				resourceLoader: { getThemes: () => ({ themes: [], diagnostics: [] }) },
				extensionRunner: { getShortcuts: () => new Map() },
				modelRuntime: {
					getError: () => undefined,
					getWarning: () => undefined,
					streamsThroughExtension: () => opts.streamsThroughExtension,
				},
				_getToolStatusWithoutGit: () => ({ missing: [] }),
			},
			settingsManager: SettingsManager.inMemory({ lastChangelogVersion: "0.0.0" }),
			bindCurrentSessionExtensions: vi.fn().mockResolvedValue(undefined),
			applyRuntimeSettings: vi.fn(),
			rebuildChatFromMessages: vi.fn(),
			promptTurnWorkingLoaderActive: true,
			stopWorkingLoader: vi.fn(),
			deferredStartupPending: true,
			themeController: { applyFromSettings: vi.fn().mockResolvedValue(undefined) },
			setupAutocompleteProvider: vi.fn(),
			setupExtensionShortcuts: vi.fn(),
			retryDeferredModelRestore: vi.fn().mockResolvedValue(undefined),
			showLoadedResources: vi.fn(),
			resourceDisclosureContainer: {},
			startupNoticesContainer: {},
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn().mockResolvedValue(undefined),
			showStartupNoticesIfNeeded: vi.fn(),
			reportModelCatalogWarning: vi.fn(),
			updateAvailableProviderCount: vi.fn().mockResolvedValue(undefined),
			updateEditorBorderColor: vi.fn(),
			ui: { requestRender: vi.fn() },
			chatContainer: { children: [] },
			startSessionRecovery: vi.fn(),
		});

		// Built-in / models.json provider with early Enter active -> prewarms BEFORE completeDeferredStartup resolves.
		await InteractiveMode.prototype.completeDeferredStartup.call(
			makeMode({ streamsThroughExtension: false }) as unknown as InteractiveMode,
		);
		assert.equal(prewarmCalls, 1, "in-process early-Enter deferred startup must overlap model API prewarm");

		// Extension-streamed provider -> must NOT prewarm Atomic's implementation.
		prewarmCalls = 0;
		await InteractiveMode.prototype.completeDeferredStartup.call(
			makeMode({ streamsThroughExtension: true }) as unknown as InteractiveMode,
		);
		assert.equal(prewarmCalls, 0);

		// Shutting down -> must NOT prewarm.
		prewarmCalls = 0;
		await InteractiveMode.prototype.completeDeferredStartup.call(
			makeMode({ streamsThroughExtension: false, isShuttingDown: true }) as unknown as InteractiveMode,
		);
		assert.equal(prewarmCalls, 0);
	});

	it("loadAllHighlightLanguages yields across event-loop turns, honors AbortSignal, resumes to completion, and preserves pre-registered overrides", () => {
		const script = [
			NODE_TS_SOURCE_HOOK,
			`import assert from "node:assert/strict";`,
			`const { loadAllHighlightLanguages, supportsLanguage, highlight } = await import(${JSON.stringify(pathToFileURL(SYNTAX_HIGHLIGHT_SRC).href)});`,
			`const hljs = (await import("highlight.js/lib/core.js")).default;`,
			`hljs.registerLanguage("python", () => ({ keywords: "custompyonly" }));`,
			`assert.equal(supportsLanguage("ada"), false);`,
			`const ac = new AbortController();`,
			`let abortedTurns = 0;`,
			`let abortedDone = false;`,
			`const abortTick = () => { abortedTurns++; if (abortedTurns === 2) ac.abort(); if (!abortedDone) setImmediate(abortTick); };`,
			`setImmediate(abortTick);`,
			`await loadAllHighlightLanguages({ signal: ac.signal });`,
			`abortedDone = true;`,
			`const countAfterAbort = hljs.listLanguages().length;`,
			`let fullTurns = 0;`,
			`let fullDone = false;`,
			`const fullTick = () => { fullTurns++; if (!fullDone) setImmediate(fullTick); };`,
			`setImmediate(fullTick);`,
			`await loadAllHighlightLanguages();`,
			`fullDone = true;`,
			`assert.ok(fullTurns >= 3, "expected chunked loadAllHighlightLanguages to yield across turns, got " + fullTurns);`,
			`assert.equal(supportsLanguage("ada"), true, "ada must be registered after full load");`,
			`assert.equal(supportsLanguage("htmlbars"), true, "htmlbars must be registered after full load");`,
			`assert.equal(hljs.listLanguages().includes("htmlbars"), true, "htmlbars must not be skipped due to handlebars alias");`,
			`assert.equal(supportsLanguage("zephir"), true, "zephir must be registered after full load");`,
			`assert.ok(countAfterAbort < hljs.listLanguages().length, "abort must stop before loading every remaining language: " + countAfterAbort + " vs " + hljs.listLanguages().length);`,
			`const pyHtml = highlight("custompyonly", { language: "python", theme: { keyword: (t) => "[kw:" + t + "]" } });`,
			`assert.equal(pyHtml, "[kw:custompyonly]");`,
			`console.log(JSON.stringify({ abortedTurns, countAfterAbort, finalCount: hljs.listLanguages().length, fullTurns }));`,
		].join("\n");
		const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
			encoding: "utf8",
			timeout: 30_000,
			env: { ...process.env, NODE_OPTIONS: "" },
		});
		assert.equal(res.status, 0, `child failed:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
	});

	it("starts background highlight warmup during a long 3s streaming first turn once assistant streaming begins, so +2s YAML blocks highlight live", async () => {
		vi.useFakeTimers();
		const loadHighlightSpy = vi.spyOn(syntaxHighlight, "loadAllHighlightLanguages").mockResolvedValue();
		const deferredGate = Promise.withResolvers<void>();
		const longTurnEnd = Promise.withResolvers<void>();
		const { mode, ui, emitEvent } = createInprocRunHarness({
			deferredStartupGate: deferredGate.promise,
			promptGate: longTurnEnd.promise,
			initialSubmission: { text: "show yaml" },
			onPrompt: async (_text, emit) => {
				emit({ type: "agent_start" });
				await new Promise((r) => setTimeout(r, 100));
				// Provider request has left and assistant streaming starts at +700ms (100ms after deferred startup).
				emit({ type: "message_start", message: { role: "assistant", content: [] } });
				// Long multi-step turn stays streaming for 3s (YAML arrives around +2s).
				await longTurnEnd.promise;
			},
		});

		void InteractiveMode.prototype.run.call(mode as unknown as InteractiveMode);
		// Cold deferred startup still in progress past 500ms -> warmup stays gated.
		await vi.advanceTimersByTimeAsync(600);
		assert.equal(loadHighlightSpy.mock.calls.length, 0, "must not run while deferred startup is active");

		// Finish deferred startup at 600ms; before assistant message_start (+700ms) warmup still waits.
		deferredGate.resolve();
		await vi.advanceTimersByTimeAsync(50);
		assert.equal(
			loadHighlightSpy.mock.calls.length,
			0,
			"must not run before first provider request starts streaming",
		);

		// Advance to +2000ms (still mid-turn — longTurnEnd has NOT resolved!).
		await vi.advanceTimersByTimeAsync(1350);
		assert.equal(
			loadHighlightSpy.mock.calls.length,
			1,
			"background highlight warmup must start during a long streaming turn before +2s",
		);
		assert.ok(ui.invalidate.mock.calls.length >= 1);
		assert.ok(ui.requestRender.mock.calls.length >= 1);

		// End the 3s turn and shut down cleanly.
		emitEvent({ type: "agent_end" });
		longTurnEnd.resolve();
		await vi.advanceTimersByTimeAsync(100);
		mode.isShuttingDown = true;
		InteractiveMode.prototype.stop.call(mode as unknown as InteractiveMode);
	});

	it("loads background highlight grammars by turn 3 across 10 back-to-back turns with 80ms gaps on both in-process and isolated hosts (including when turn 1 crosses 500ms)", async () => {
		vi.useFakeTimers();
		for (const deferredStartupPending of [true, false]) {
			for (const turn1DurationMs of [200, 550]) {
				const loadHighlightSpy = vi.spyOn(syntaxHighlight, "loadAllHighlightLanguages").mockResolvedValue();
				let loadedAtTurn = 0;
				let activeTurn = 0;
				loadHighlightSpy.mockImplementation(async () => {
					if (loadedAtTurn === 0) loadedAtTurn = activeTurn;
				});
				const deferredGate = Promise.withResolvers<void>();
				const { mode } = createInprocRunHarness({
					deferredStartupGate: deferredGate.promise,
					promptGate: Promise.resolve(),
					deferredStartupPending,
					onPrompt: async (_text, _emit, turnIdx) => {
						activeTurn = turnIdx;
						// Turn 1 takes turn1DurationMs (either <500ms or >500ms so waiting_for_gate is entered),
						// subsequent turns take 200ms with 80ms gaps (worst case: no streaming events emitted).
						await new Promise((r) => setTimeout(r, turnIdx === 1 ? turn1DurationMs : 200));
					},
				});
				// Feed 10 turns separated by 80ms gaps via a custom getUserInput loop.
				let nextTurnToFeed = 1;
				mode.getUserInput = async () => {
					if (nextTurnToFeed > 10) return new Promise(() => {});
					const idx = nextTurnToFeed++;
					if (idx > 1) await new Promise((r) => setTimeout(r, 80));
					return { text: `turn ${idx}` };
				};

				void InteractiveMode.prototype.run.call(mode as unknown as InteractiveMode);
				// Resolve deferred startup quickly (50ms) so turn 1 runs right away.
				await vi.advanceTimersByTimeAsync(50);
				deferredGate.resolve();
				// Advance through all 10 back-to-back turns.
				await vi.advanceTimersByTimeAsync(3500);

				assert.equal(
					loadHighlightSpy.mock.calls.length,
					1,
					`back-to-back turns must not starve highlight warmup (deferred=${deferredStartupPending}, t1=${turn1DurationMs})`,
				);
				assert.ok(
					loadedAtTurn >= 1 && loadedAtTurn <= 3,
					`expected warmup loaded by turn 3, got turn ${loadedAtTurn} (deferred=${deferredStartupPending}, t1=${turn1DurationMs})`,
				);

				mode.isShuttingDown = true;
				InteractiveMode.prototype.stop.call(mode as unknown as InteractiveMode);
				loadHighlightSpy.mockRestore();
			}
		}
	});

	it("enforces a hard max-deferral cap when the first provider request takes a long time to answer", async () => {
		vi.useFakeTimers();
		const loadHighlightSpy = vi.spyOn(syntaxHighlight, "loadAllHighlightLanguages").mockResolvedValue();
		const deferredGate = Promise.withResolvers<void>();
		const neverResolves = new Promise<void>(() => {});
		const { mode } = createInprocRunHarness({
			deferredStartupGate: deferredGate.promise,
			promptGate: neverResolves,
			initialSubmission: { text: "slow provider" },
		});

		void InteractiveMode.prototype.run.call(mode as unknown as InteractiveMode);
		// Cold deferred startup finishes at 600ms, then provider stalls silently for >2s.
		await vi.advanceTimersByTimeAsync(600);
		assert.equal(loadHighlightSpy.mock.calls.length, 0);
		deferredGate.resolve();
		await vi.advanceTimersByTimeAsync(200);
		assert.equal(loadHighlightSpy.mock.calls.length, 0, "must still wait briefly after deferred startup");

		// Advance past 500ms + hard max-deferral cap (total <= 1800ms after init) -> MUST fire!
		await vi.advanceTimersByTimeAsync(1100);
		assert.equal(
			loadHighlightSpy.mock.calls.length,
			1,
			"hard max-deferral cap must fire even if the first turn never emits streaming events",
		);

		mode.isShuttingDown = true;
		InteractiveMode.prototype.stop.call(mode as unknown as InteractiveMode);
	});

	it("does not invoke the warmup runner when stop() is called synchronously before its microtask drains", async () => {
		const runner = vi.fn();
		const host = {
			isShuttingDown: false,
			deferredStartupPending: false,
			deferredStartupPromise: undefined,
		};
		armPostStartupHighlightWarmup(host, runner);
		// Triggers startBackgroundWarmup(), which schedules runner() on a microtask.
		onPostStartupTimerFired(host);
		// Synchronous stop() before microtasks flush must abort and prevent runner() from running.
		host.isShuttingDown = true;
		stopPostStartupHighlightWarmup(host);
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(runner.mock.calls.length, 0, "runner must not execute after synchronous stop()");
	});
});

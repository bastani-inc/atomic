import { stripVTControlCharacters } from "node:util";
import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type WorkingLoader = Text & { stop: () => void };

type PromptTurnContext = {
	statusContainer: Container;
	startupNoticesContainer: Container;
	loadingAnimation: WorkingLoader | undefined;
	workingVisible: boolean;
	promptTurnWorkingLoaderActive: boolean;
	deferredStartupPending: boolean;
	deferredStartupPromise: Promise<void> | undefined;
	options: { deferredModelScopePatterns?: string[] };
	session: {
		isStreaming: boolean;
		subscribe: (listener: (event: { type: string }) => void) => () => void;
		reload: (options: { reason: string }) => Promise<void>;
		resumeQueuedMessages: () => Promise<boolean>;
		prompt: (text: string) => Promise<void>;
		resourceLoader: { getThemes: () => { themes: [] } };
		extensionRunner: Record<string, never>;
		modelRegistry: { getError: () => string | undefined };
		_tryExecuteBuiltinSlashCommand: (text: string) => Promise<boolean>;
		_tryExecuteExtensionCommand: (text: string) => Promise<boolean>;
	};
	settingsManager: { getClearOnShrink: () => boolean };
	themeController: { applyFromSettings: () => Promise<void> };
	bindCurrentSessionExtensions: () => Promise<void>;
	setupAutocompleteProvider: () => void;
	setupExtensionShortcuts: (runner: unknown) => void;
	retryDeferredModelRestore: (container?: Container) => Promise<void>;
	showLoadedResources: () => void;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
	showStartupNoticesIfNeeded: () => void;
	updateAvailableProviderCount: () => Promise<void>;
	updateEditorBorderColor: () => void;
	discardDeferredRenderedUserInput: (text: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
	createWorkingLoader: () => WorkingLoader;
	stopWorkingLoader: () => void;
	showWorkingLoaderNow: () => void;
	ensureDeferredStartupComplete: () => Promise<void>;
	completeDeferredStartup: () => Promise<void>;
	runUserPromptTurn: (userInput: string) => Promise<void>;
};

function proto<K extends string>(name: K): unknown {
	return Reflect.get(InteractiveMode.prototype, name);
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function createContext(overrides: {
	themeGate?: Promise<void>;
	promptGate?: Promise<void>;
	slashHandled?: boolean;
}): PromptTurnContext {
	const loaders: WorkingLoader[] = [];
	const context = {
		statusContainer: new Container(),
		startupNoticesContainer: new Container(),
		loadingAnimation: undefined,
		workingVisible: true,
		promptTurnWorkingLoaderActive: false,
		deferredStartupPending: true,
		deferredStartupPromise: undefined,
		options: {},
		session: {
			isStreaming: false,
			subscribe: vi.fn(() => () => {}),
			reload: vi.fn(async () => {}),
			resumeQueuedMessages: vi.fn(async () => false),
			prompt: vi.fn(async () => {
				context.session.isStreaming = true;
				await (overrides.promptGate ?? Promise.resolve());
				context.session.isStreaming = false;
			}),
			resourceLoader: { getThemes: () => ({ themes: [] as [] }) },
			extensionRunner: {},
			modelRegistry: { getError: () => undefined },
			_tryExecuteBuiltinSlashCommand: vi.fn(async () => overrides.slashHandled === true),
			_tryExecuteExtensionCommand: vi.fn(async () => false),
		},
		settingsManager: { getClearOnShrink: () => false },
		themeController: {
			applyFromSettings: vi.fn(async () => {
				await (overrides.themeGate ?? Promise.resolve());
			}),
		},
		bindCurrentSessionExtensions: vi.fn(async () => {}),
		setupAutocompleteProvider: vi.fn(),
		setupExtensionShortcuts: vi.fn(),
		retryDeferredModelRestore: vi.fn(async () => {}),
		showLoadedResources: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
		showStartupNoticesIfNeeded: vi.fn(),
		updateAvailableProviderCount: vi.fn(async () => {}),
		updateEditorBorderColor: vi.fn(),
		discardDeferredRenderedUserInput: vi.fn(),
		showError: vi.fn(),
		ui: { requestRender: vi.fn() },
		createWorkingLoader: vi.fn(() => {
			const loader = Object.assign(new Text("Working...", 0, 0), { stop: vi.fn() }) as WorkingLoader;
			loaders.push(loader);
			return loader;
		}),
		stopWorkingLoader: proto("stopWorkingLoader"),
		showWorkingLoaderNow: proto("showWorkingLoaderNow"),
		ensureDeferredStartupComplete: proto("ensureDeferredStartupComplete"),
		completeDeferredStartup: proto("completeDeferredStartup"),
		runUserPromptTurn: proto("runUserPromptTurn"),
	} as unknown as PromptTurnContext;
	return context;
}

function indicatorVisible(context: PromptTurnContext): boolean {
	const mounted =
		context.loadingAnimation !== undefined && context.statusContainer.children.includes(context.loadingAnimation);
	return mounted && stripVTControlCharacters(context.statusContainer.render(80).join("\n")).includes("Working...");
}

describe("prompt turn working indicator continuity", () => {
	it("keeps the indicator mounted through deferred startup and prompt preflight", async () => {
		const themeGate = deferred();
		const promptGate = deferred();
		const context = createContext({ themeGate: themeGate.promise, promptGate: promptGate.promise });

		const turn = context.runUserPromptTurn.call(context, "resume this work");

		// Deferred startup is blocked partway through, after session.reload().
		await vi.waitFor(() => expect(context.themeController.applyFromSettings).toHaveBeenCalled());
		expect(context.session.reload).toHaveBeenCalled();
		expect(indicatorVisible(context)).toBe(true);

		themeGate.resolve();

		// Prompt preflight is now in flight; the indicator must still be visible.
		await vi.waitFor(() => expect(context.session.prompt).toHaveBeenCalled());
		expect(indicatorVisible(context)).toBe(true);

		promptGate.resolve();
		await turn;
		expect(context.promptTurnWorkingLoaderActive).toBe(false);
	});

	it("removes the indicator when a submission resolves without starting a turn", async () => {
		const context = createContext({ slashHandled: true });

		await context.runUserPromptTurn.call(context, "/hotkeys");

		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(indicatorVisible(context)).toBe(false);
		expect(context.loadingAnimation).toBeUndefined();
		expect(context.promptTurnWorkingLoaderActive).toBe(false);
	});

	it("keeps the indicator through failed deferred startup until prompt preflight, then clears it when no turn starts", async () => {
		const context = createContext({});
		context.session.reload = vi.fn(async () => {
			throw new Error("reload failed");
		});
		let promptSawIndicator = false;
		context.session.prompt = vi.fn(async () => {
			promptSawIndicator = indicatorVisible(context);
		});

		await context.runUserPromptTurn.call(context, "resume after startup failure");

		expect(promptSawIndicator).toBe(true);
		expect(context.deferredStartupPending).toBe(false);
		expect(context.showError).toHaveBeenCalledWith("Extension loading failed: reload failed");
		expect(context.maybeWarnAboutAnthropicSubscriptionAuth).toHaveBeenCalled();
		expect(context.session.prompt).toHaveBeenCalled();
		expect(indicatorVisible(context)).toBe(false);
		expect(context.loadingAnimation).toBeUndefined();
		expect(context.promptTurnWorkingLoaderActive).toBe(false);
	});

	it("still stops the indicator when deferred startup runs outside a prompt turn", async () => {
		const context = createContext({});
		context.showWorkingLoaderNow.call(context);
		expect(indicatorVisible(context)).toBe(true);

		await context.completeDeferredStartup.call(context);

		expect(indicatorVisible(context)).toBe(false);
		expect(context.deferredStartupPending).toBe(false);
	});
});

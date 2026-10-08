import assert from "node:assert/strict";
import { type Component, Container } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const timingMock = vi.hoisted(() => ({ labels: [] as string[] }));

const engineWaitMock = vi.hoisted(() => ({ wait: vi.fn(async () => {}) }));
const startupBindingMock = vi.hoisted(() => ({ bind: vi.fn(async () => {}) }));
const catalogStartupMock = vi.hoisted(() => ({ updateProviderCount: vi.fn() }));

vi.mock("../src/modes/interactive/interactive-initial-session-binding.ts", () => ({
	bindInitialEagerSession: startupBindingMock.bind,
}));

vi.mock("../src/modes/interactive/interactive-model-catalog-startup.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive/interactive-model-catalog-startup.ts")>()),
	updateProviderCountFromSnapshot: catalogStartupMock.updateProviderCount,
}));

vi.mock("../src/modes/interactive-engine/extension-ui-bridge.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/modes/interactive-engine/extension-ui-bridge.ts")>()),
	waitForInteractiveEngineBound: engineWaitMock.wait,
}));

vi.mock("../src/core/timings.ts", () => ({
	recordTimeSinceReset: vi.fn((label: string) => {
		timingMock.labels.push(label);
	}),
}));

type TestNode = Record<string, never>;

type InputContext = {
	onInputCallback?: (text: string) => void;
	pendingUserInputs: string[];
	startupReplayActiveInput?: string;
	inputHandlerReadyRecorded?: boolean;
	drainStartupReplayCommands?: () => Promise<void>;
	showStartupNoticesIfNeeded?: (container: unknown) => void;
	startupNoticesContainer?: unknown;
	footerDataProvider: { startGitWatcher: () => void };
	deferredStartupPending?: boolean;
	ensureDeferredStartupComplete?: () => Promise<void>;
};

type StartupNoticesContext = {
	startupNoticesShown: boolean;
	startupNoticesPrepared: boolean;
	hadLastChangelogVersionAtStartup: boolean;
	changelogMarkdown?: string;
	firstRunNoticeVisible: boolean;
	firstRunOnboardingNoticeComponents?: TestNode[];
	settingsManager: {
		getLastChangelogVersion?: () => string | undefined;
		setOnboardedVersion?: (version: string) => void;
		getCollapseChangelog: () => boolean;
	};
	version?: string;
	getChangelogForDisplay: () => string | undefined;
	initializeFirstRunOnboardingMarkers: () => void;
	isFirstRunOnboardingEligible: () => boolean;
	chatContainer: { children: TestNode[]; addChild?: (child: TestNode) => void };
	ui: { requestRender: () => void };
};

type InitContext = {
	programStatus: { report: () => void };
	settingsManager: { getFullscreenScrollbar: () => "auto" };
	isInitialized: boolean;
	registerSignalHandlers: () => void;
	ui: {
		addChild: (child: TestNode) => void;
		setFocus: (target: TestNode) => void;
		start: () => void;
		requestRender: () => void;
	};
	headerContainer: TestNode;
	documentContainer: TestNode;
	chatContainer: TestNode;
	pendingMessagesContainer: TestNode;
	statusContainer: TestNode;
	widgetContainerAbove: TestNode;
	usageMeter: TestNode;
	editorContainer: TestNode;
	footer: TestNode;
	footerContainer: TestNode;
	widgetContainerBelow: TestNode;
	editor: TestNode;
	renderWidgets: () => void;
	mountInteractiveTui: (tui: InitContext["ui"], components: TestNode[]) => void;
	setupKeyHandlers: () => void;
	setupEditorSubmitHandler: () => void;
	pendingUserInputs: string[];
	defaultEditor: { setText?: (text: string) => void };
	options: { startupInputCapture?: { consume: () => { text: string; submissions: string[] } } };
	startupReplayInputs: string[];
	footerDataProvider: { onBranchChange: (callback: () => void) => void; startGitWatcher: () => void };
	themeController: { applyFromSettings: () => Promise<void> };
};

type PromptTurnContext = {
	deferredStartupPending: boolean;
	deferredStartupPromise?: Promise<void>;
	session: {
		isStreaming: boolean;
		subscribe: (listener: (event: { type: string }) => void) => () => void;
		resumeQueuedMessages: () => Promise<boolean>;
		prompt: (text: string) => Promise<void>;
	};
	showWorkingLoaderNow: () => void;
	ensureDeferredStartupComplete: () => Promise<void>;
	showLoadedResources: (options?: unknown) => void;
	maybeWarnAboutAnthropicSubscriptionAuth: () => Promise<void>;
	discardDeferredRenderedUserInput: (text: string) => void;
	showError: (message: string) => void;
	stopWorkingLoader: () => void;
	startupNoticesContainer: TestNode;
};

type InteractiveModePrivate = {
	getUserInput(this: InputContext): Promise<string>;
	showStartupNoticesIfNeeded(this: StartupNoticesContext): void;
	init(this: InitContext): Promise<void>;
	runUserPromptTurn(this: PromptTurnContext, userInput: string): Promise<void>;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

async function waitForImmediate(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

function createPromptTurnContext(
	options: { deferredStartupPending?: boolean; deferredStartupPromise?: Promise<void> } = {},
): PromptTurnContext {
	return {
		deferredStartupPending: options.deferredStartupPending ?? false,
		deferredStartupPromise: options.deferredStartupPromise,
		session: {
			isStreaming: false,
			subscribe: vi.fn(() => () => {}),
			resumeQueuedMessages: vi.fn(async () => false),
			prompt: vi.fn(async () => {}),
		},
		showWorkingLoaderNow: vi.fn(),
		ensureDeferredStartupComplete: vi.fn(async () => {}),
		showLoadedResources: vi.fn(),
		maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(async () => {}),
		discardDeferredRenderedUserInput: vi.fn(),
		showError: vi.fn(),
		stopWorkingLoader: vi.fn(),
		startupNoticesContainer: {},
	};
}

describe("InteractiveMode startup latency hooks", () => {
	it("records input handler readiness when the input callback is installed", async () => {
		timingMock.labels.length = 0;
		const context: InputContext = {
			pendingUserInputs: [],
			inputHandlerReadyRecorded: false,
			footerDataProvider: { startGitWatcher: vi.fn() },
			showStartupNoticesIfNeeded: vi.fn(),
			startupNoticesContainer: {},
		};

		const inputPromise = interactiveModePrototype.getUserInput.call(context);

		expect(context.onInputCallback).toBeTypeOf("function");
		expect(timingMock.labels).toEqual(["interactive-input-handler-ready"]);
		expect(context.footerDataProvider.startGitWatcher).not.toHaveBeenCalled();
		await waitForImmediate();
		expect(context.footerDataProvider.startGitWatcher).toHaveBeenCalledTimes(1);

		context.onInputCallback?.("ready prompt");
		await expect(inputPromise).resolves.toBe("ready prompt");
	});

	it("starts deferred startup in the background after input readiness", async () => {
		timingMock.labels.length = 0;
		let markDeferredStarted: (() => void) | undefined;
		const deferredStarted = new Promise<void>((resolve) => {
			markDeferredStarted = resolve;
		});
		const context: InputContext = {
			pendingUserInputs: [],
			inputHandlerReadyRecorded: false,
			footerDataProvider: { startGitWatcher: vi.fn() },
			showStartupNoticesIfNeeded: vi.fn(),
			startupNoticesContainer: {},
			deferredStartupPending: true,
			ensureDeferredStartupComplete: vi.fn(async () => {
				markDeferredStarted?.();
			}),
		};

		const inputPromise = interactiveModePrototype.getUserInput.call(context);

		expect(context.onInputCallback).toBeTypeOf("function");
		expect(context.ensureDeferredStartupComplete).not.toHaveBeenCalled();
		context.onInputCallback?.("ready prompt");
		await expect(inputPromise).resolves.toBe("ready prompt");

		await waitForImmediate();
		await deferredStarted;

		expect(context.footerDataProvider.startGitWatcher).toHaveBeenCalledTimes(1);
		expect(context.ensureDeferredStartupComplete).toHaveBeenCalledTimes(1);
	});

	it("does not record input handler readiness for queued startup input", async () => {
		timingMock.labels.length = 0;
		const context: InputContext = {
			pendingUserInputs: ["queued prompt"],
			inputHandlerReadyRecorded: false,
			footerDataProvider: { startGitWatcher: vi.fn() },
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");

		expect(context.onInputCallback).toBeUndefined();
		await waitForImmediate();
		expect(context.footerDataProvider.startGitWatcher).not.toHaveBeenCalled();
		expect(timingMock.labels).not.toContain("interactive-input-handler-ready");
	});

	it("keeps startup confirmation keyboard focus while the engine binds (#3468)", async () => {
		initTheme("dark");
		let focused: Component | undefined;
		const context = {
			programStatus: { report: vi.fn(), setBlocked: vi.fn() },
			init: InteractiveMode.prototype.init,
			showExtensionConfirm: InteractiveMode.prototype.showExtensionConfirm,
			showExtensionSelector: InteractiveMode.prototype.showExtensionSelector,
			hideExtensionSelector: InteractiveMode.prototype.hideExtensionSelector,
			runtimeHost: {},
			isInitialized: false,
			registerSignalHandlers: vi.fn(),
			ui: {
				addChild: vi.fn(),
				setFocus: (component: Component) => {
					focused = component;
				},
				start: vi.fn(),
				requestRender: vi.fn(),
			},
			headerContainer: new Container(),
			documentContainer: new Container(),
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			statusContainer: new Container(),
			widgetContainerAbove: new Container(),
			usageMeter: new Container(),
			editorContainer: new Container(),
			footerContainer: new Container(),
			widgetContainerBelow: new Container(),
			editor: { render: () => [], handleInput: vi.fn() },
			renderWidgets: vi.fn(),
			mountInteractiveTui: vi.fn(),
			setupKeyHandlers: vi.fn(),
			setupEditorSubmitHandler: vi.fn(),
			disposeActiveSelector: vi.fn(),
			pendingUserInputs: [],
			defaultEditor: {},
			options: {},
			startupReplayInputs: [],
			footerDataProvider: { onBranchChange: vi.fn() },
			themeController: { applyFromSettings: vi.fn(async () => {}) },
			settingsManager: { getFullscreenScrollbar: () => "auto", getQuietStartup: () => false },
			getStartupIdentityText: () => "Atomic v0.0.0",
			shouldShowStartupHeader: () => true,
			isShuttingDown: false,
			deferredStartupPending: false,
			ensureManagedToolsReady: vi.fn(async () => {}),
			attachStartupNoticesContainer: vi.fn(),
			renderInitialMessages: vi.fn(),
		} as unknown as InteractiveMode;
		const controller = new AbortController();
		const confirmation = context.showExtensionConfirm("Resume interrupted workflows?", "Resume now?", {
			signal: controller.signal,
		});
		engineWaitMock.wait.mockImplementationOnce(async () => {
			await confirmation;
		});
		const init = context.init();
		try {
			await waitForImmediate();
			assert.equal(context.isInitialized, false);
			assert.equal(focused, context.extensionSelector);
			focused?.handleInput?.("\x1b[B");
			focused?.handleInput?.("\r");
			assert.equal(await confirmation, false);
			assert.equal(focused, context.editor);
		} finally {
			controller.abort();
			await init;
		}
	});

	it("paints the startup identity and editor before the isolated engine binds", async () => {
		startupBindingMock.bind.mockClear();
		catalogStartupMock.updateProviderCount.mockClear();
		let resolveEngine!: () => void;
		engineWaitMock.wait.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					resolveEngine = resolve;
				}),
		);
		const headerChildren: object[] = [];
		const context = {
			programStatus: { report: vi.fn() },
			runtimeHost: {},
			isInitialized: false,
			registerSignalHandlers: vi.fn(),
			ui: {
				addChild: vi.fn(),
				setFocus: vi.fn(),
				start: vi.fn(),
				requestRender: vi.fn(),
			},
			headerContainer: { addChild: (child: object) => headerChildren.push(child) },
			documentContainer: {},
			chatContainer: {},
			pendingMessagesContainer: {},
			statusContainer: {},
			widgetContainerAbove: {},
			usageMeter: {},
			editorContainer: {},
			footerContainer: {},
			widgetContainerBelow: {},
			editor: {},
			renderWidgets: vi.fn(),
			mountInteractiveTui: vi.fn(),
			setupKeyHandlers: vi.fn(),
			setupEditorSubmitHandler: vi.fn(),
			pendingUserInputs: [],
			defaultEditor: {},
			options: {},
			startupReplayInputs: [],
			footerDataProvider: { onBranchChange: vi.fn() },
			themeController: { applyFromSettings: vi.fn(async () => {}) },
			settingsManager: { getFullscreenScrollbar: () => "auto", getQuietStartup: () => false },
			getStartupIdentityText: () => "Atomic v0.0.0",
			shouldShowStartupHeader: () => true,
			isShuttingDown: false,
			deferredStartupPending: false,
			ensureManagedToolsReady: vi.fn(async () => {}),
			attachStartupNoticesContainer: vi.fn(),
			renderInitialMessages: vi.fn(),
		} as unknown as InitContext;

		const init = interactiveModePrototype.init.call(context);
		await waitForImmediate();

		expect(context.ui.start).toHaveBeenCalledTimes(1);
		expect(context.ui.setFocus).toHaveBeenCalledWith(context.editor);
		expect(headerChildren).toHaveLength(3);
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
		expect(context.isInitialized).toBe(false);
		expect(startupBindingMock.bind).not.toHaveBeenCalled();
		expect(catalogStartupMock.updateProviderCount).not.toHaveBeenCalled();

		resolveEngine();
		await expect(init).resolves.toBeUndefined();
		expect(startupBindingMock.bind).toHaveBeenCalledTimes(1);
		expect(startupBindingMock.bind).toHaveBeenCalledWith(context);
		expect(catalogStartupMock.updateProviderCount).toHaveBeenCalledTimes(1);
		expect(context.isInitialized).toBe(true);
	});

	it("does not start footer git watching during the inline init path", async () => {
		const themeReady = new Promise<void>(() => {});
		const context: InitContext = {
			programStatus: { report: vi.fn() },
			isInitialized: false,
			registerSignalHandlers: vi.fn(),
			ui: {
				addChild: vi.fn(),
				setFocus: vi.fn(),
				start: vi.fn(),
				requestRender: vi.fn(),
			},
			headerContainer: {},
			documentContainer: {},
			chatContainer: {},
			pendingMessagesContainer: {},
			statusContainer: {},
			widgetContainerAbove: {},
			usageMeter: {},
			editorContainer: {},
			footer: {},
			footerContainer: {},
			widgetContainerBelow: {},
			editor: {},
			renderWidgets: vi.fn(),
			mountInteractiveTui: vi.fn(),
			setupKeyHandlers: vi.fn(),
			setupEditorSubmitHandler: vi.fn(),
			pendingUserInputs: [],
			defaultEditor: {},
			options: {},
			startupReplayInputs: [],
			footerDataProvider: {
				onBranchChange: vi.fn(),
				startGitWatcher: vi.fn(),
			},
			themeController: { applyFromSettings: vi.fn(() => themeReady) },
			settingsManager: { getFullscreenScrollbar: () => "auto" },
		};

		void interactiveModePrototype.init.call(context);

		expect(context.ui.start).toHaveBeenCalledTimes(1);
		expect(context.footerDataProvider.startGitWatcher).not.toHaveBeenCalled();

		await waitForImmediate();
		expect(context.footerDataProvider.onBranchChange).toHaveBeenCalledTimes(1);
		expect(context.footerDataProvider.startGitWatcher).not.toHaveBeenCalled();
	});

	it("waits for deferred startup before the first normal prompt", async () => {
		const order: string[] = [];
		const context = createPromptTurnContext({ deferredStartupPending: true });
		context.ensureDeferredStartupComplete = vi.fn(async () => {
			order.push("deferred");
		});
		context.session.prompt = vi.fn(async () => {
			order.push("prompt");
		});

		await interactiveModePrototype.runUserPromptTurn.call(context, "hello");

		expect(order).toEqual(["deferred", "prompt"]);
		expect(context.session.prompt).toHaveBeenCalledWith("hello");
	});

	it("waits for deferred startup already in flight before prompting", async () => {
		const order: string[] = [];
		const context = createPromptTurnContext({
			deferredStartupPending: true,
			deferredStartupPromise: Promise.resolve(),
		});
		context.ensureDeferredStartupComplete = vi.fn(async () => {
			order.push("deferred");
		});
		context.session.prompt = vi.fn(async () => {
			order.push("prompt");
		});

		await interactiveModePrototype.runUserPromptTurn.call(context, "hello");

		expect(order).toEqual(["deferred", "prompt"]);
	});

	it("prepares startup notices only when notice rendering is requested", () => {
		const context: StartupNoticesContext = {
			startupNoticesShown: false,
			startupNoticesPrepared: false,
			hadLastChangelogVersionAtStartup: false,
			firstRunNoticeVisible: false,
			settingsManager: {
				getLastChangelogVersion: vi.fn(() => "0.1.0"),
				getCollapseChangelog: vi.fn(() => true),
			},
			getChangelogForDisplay: vi.fn(() => undefined),
			initializeFirstRunOnboardingMarkers: vi.fn(),
			isFirstRunOnboardingEligible: vi.fn(() => false),
			chatContainer: { children: [] },
			ui: { requestRender: vi.fn() },
		};

		expect(context.startupNoticesPrepared).toBe(false);

		interactiveModePrototype.showStartupNoticesIfNeeded.call(context);

		expect(context.startupNoticesPrepared).toBe(true);
		expect(context.hadLastChangelogVersionAtStartup).toBe(true);
		expect(context.getChangelogForDisplay).toHaveBeenCalledTimes(1);
		expect(context.initializeFirstRunOnboardingMarkers).toHaveBeenCalledTimes(1);
		expect(context.isFirstRunOnboardingEligible).toHaveBeenCalledTimes(1);
		expect(context.ui.requestRender).not.toHaveBeenCalled();
	});

	it("prepares missing startup notice state without clearing visible onboarding", () => {
		const children: TestNode[] = [];
		const context: StartupNoticesContext = {
			startupNoticesShown: false,
			startupNoticesPrepared: false,
			hadLastChangelogVersionAtStartup: false,
			firstRunNoticeVisible: true,
			firstRunOnboardingNoticeComponents: [],
			settingsManager: {
				getLastChangelogVersion: vi.fn(() => "0.1.0"),
				setOnboardedVersion: vi.fn(),
				getCollapseChangelog: vi.fn(() => true),
			},
			version: "0.2.0",
			getChangelogForDisplay: vi.fn(() => undefined),
			initializeFirstRunOnboardingMarkers: vi.fn(),
			isFirstRunOnboardingEligible: vi.fn(() => false),
			chatContainer: {
				children,
				addChild(child: TestNode) {
					this.children.push(child);
				},
			},
			ui: { requestRender: vi.fn() },
		};

		interactiveModePrototype.showStartupNoticesIfNeeded.call(context);

		expect(context.startupNoticesPrepared).toBe(true);
		expect(context.changelogMarkdown).toBeUndefined();
		expect(context.firstRunNoticeVisible).toBe(true);
		expect(context.getChangelogForDisplay).toHaveBeenCalledTimes(1);
		expect(context.initializeFirstRunOnboardingMarkers).toHaveBeenCalledTimes(1);
		expect(context.isFirstRunOnboardingEligible).not.toHaveBeenCalled();
		expect(context.chatContainer.children.length).toBeGreaterThan(0);
	});
});

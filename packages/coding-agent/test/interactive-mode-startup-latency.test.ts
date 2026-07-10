import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const timingMock = vi.hoisted(() => ({ labels: [] as string[] }));

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
	startupCookedInputRecovered?: boolean;
	inputHandlerReadyRecorded?: boolean;
	drainStartupReplayCommands?: () => Promise<void>;
	recoverCookedStartupInput?: () => boolean;
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
	isInitialized: boolean;
	registerSignalHandlers: () => void;
	ui: {
		addChild: (child: TestNode) => void;
		setFocus: (target: TestNode) => void;
		start: () => void;
		requestRender: () => void;
	};
	headerContainer: TestNode;
	chatContainer: TestNode;
	pendingMessagesContainer: TestNode;
	statusContainer: TestNode;
	widgetContainerAbove: TestNode;
	usageMeter: TestNode;
	editorContainer: TestNode;
	footer: TestNode;
	widgetContainerBelow: TestNode;
	editor: TestNode;
	renderWidgets: () => void;
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
	deferLoadedResourcesDisclosureUntilAgentEnd: boolean;
	pendingLoadedResourcesDisclosure: boolean;
	session: { isStreaming: boolean; prompt: (text: string) => Promise<void> };
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

function createPromptTurnContext(options: {
	deferredStartupPending?: boolean;
	deferredStartupPromise?: Promise<void>;
} = {}): PromptTurnContext {
	return {
		deferredStartupPending: options.deferredStartupPending ?? false,
		deferredStartupPromise: options.deferredStartupPromise,
		deferLoadedResourcesDisclosureUntilAgentEnd: false,
		pendingLoadedResourcesDisclosure: false,
		session: { isStreaming: false, prompt: vi.fn(async () => {}) },
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
			startupCookedInputRecovered: true,
			inputHandlerReadyRecorded: false,
			footerDataProvider: { startGitWatcher: vi.fn() },
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
			startupCookedInputRecovered: true,
			inputHandlerReadyRecorded: false,
			footerDataProvider: { startGitWatcher: vi.fn() },
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
			startupCookedInputRecovered: true,
			inputHandlerReadyRecorded: false,
			footerDataProvider: { startGitWatcher: vi.fn() },
		};

		await expect(interactiveModePrototype.getUserInput.call(context)).resolves.toBe("queued prompt");

		expect(context.onInputCallback).toBeUndefined();
		await waitForImmediate();
		expect(context.footerDataProvider.startGitWatcher).not.toHaveBeenCalled();
		expect(timingMock.labels).not.toContain("interactive-input-handler-ready");
	});

	it("does not start footer git watching during the inline init path", async () => {
		const themeReady = new Promise<void>(() => {});
		const context: InitContext = {
			isInitialized: false,
			registerSignalHandlers: vi.fn(),
			ui: {
				addChild: vi.fn(),
				setFocus: vi.fn(),
				start: vi.fn(),
				requestRender: vi.fn(),
			},
			headerContainer: {},
			chatContainer: {},
			pendingMessagesContainer: {},
			statusContainer: {},
			widgetContainerAbove: {},
			usageMeter: {},
			editorContainer: {},
			footer: {},
			widgetContainerBelow: {},
			editor: {},
			renderWidgets: vi.fn(),
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
		};

		void interactiveModePrototype.init.call(context);

		expect(context.ui.start).toHaveBeenCalledTimes(1);
		expect(context.footerDataProvider.onBranchChange).toHaveBeenCalledTimes(1);
		expect(context.footerDataProvider.startGitWatcher).not.toHaveBeenCalled();

		await waitForImmediate();
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
		expect(context.deferLoadedResourcesDisclosureUntilAgentEnd).toBe(false);
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

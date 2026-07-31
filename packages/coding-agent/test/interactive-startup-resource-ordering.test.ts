import assert from "node:assert/strict";
import { Container, Text } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { ExtensionUIContext } from "../src/core/extensions/index.ts";
import { bindInitialEagerSession } from "../src/modes/interactive/interactive-initial-session-binding.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	releaseStartupChatOutput,
	StartupChatContainer,
} from "../src/modes/interactive/interactive-startup-chat-container.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { attachInteractiveEngineHost } from "../src/modes/interactive-engine/extension-ui-bridge.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import type { RpcExtensionUIRequest, RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.ts";
import { createShowLoadedResourcesThis } from "./interactive-mode-status-resources-helpers.ts";

initTheme("dark");

function createOrderingMode(): InteractiveMode {
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, {
		chatContainer: new StartupChatContainer(),
		resourceDisclosureContainer: new Container(),
		startupNoticesContainer: new Container(),
		ui: { requestRender() {} },
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
	});
	return mode;
}

function normalizeStartupOutput(container: Container, width = 220): string {
	return container
		.render(width)
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "")
		.replace(/\\/g, "/")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

async function renderStartupWithEarlyNotify(
	startupPath: "eager" | "deferred",
	notifyType: "info" | "warning" | "error",
): Promise<string> {
	const mode = createOrderingMode();
	mode.attachStartupNoticesContainer();
	const emitNotify = () => mode.showExtensionNotify(`extension ${notifyType}`, notifyType);
	const renderDisclosure = (options: { targetContainer?: Container }) => {
		options.targetContainer?.addChild(new Text("RESOURCES", 0, 0));
	};
	Object.assign(mode, {
		showLoadedResources: renderDisclosure,
		showStartupNoticesIfNeeded() {},
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
	});
	if (startupPath === "eager") {
		Object.assign(mode, { rebindCurrentSession: async () => emitNotify() });
		await bindInitialEagerSession(mode);
	} else {
		Object.defineProperties(mode, {
			session: {
				value: {
					reload: async () => {},
					resourceLoader: { getThemes: () => ({ themes: [] }) },
					extensionRunner: {},
					modelRuntime: { getError: () => undefined },
				},
			},
			options: { value: {} },
		});
		Object.assign(mode, {
			bindCurrentSessionExtensions: async () => emitNotify(),
			promptTurnWorkingLoaderActive: false,
			stopWorkingLoader() {},
			themeController: { applyFromSettings: async () => {} },
			setupAutocompleteProvider() {},
			setupExtensionShortcuts() {},
			retryDeferredModelRestore: async () => {},
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor() {},
		});
		await InteractiveMode.prototype.completeDeferredStartup.call(mode);
	}
	return normalizeStartupOutput(mode.chatContainer);
}
type StartupNotice = {
	name: string;
	marker: string;
	emit(mode: InteractiveMode): void | Promise<void>;
};

const directStartupNotices: StartupNotice[] = [
	{
		name: "new-version notification",
		marker: "Update Available",
		emit: (mode) => mode.showNewVersionNotification("9.9.9", mode.startupNoticesContainer),
	},
	{
		name: "package-update notification",
		marker: "Package Updates Available",
		emit: (mode) => mode.showPackageUpdateNotification(["sample-extension"], mode.startupNoticesContainer),
	},
	{
		name: "tmux startup warning",
		marker: "tmux startup warning",
		emit: (mode) => mode.showWarning("tmux startup warning", mode.startupNoticesContainer),
	},
	{
		name: "model-fallback warning",
		marker: "model fallback warning",
		emit: (mode) => mode.showWarning("model fallback warning", mode.startupNoticesContainer),
	},
];

function configureDeferredMode(mode: InteractiveMode): void {
	Object.defineProperties(mode, {
		session: {
			configurable: true,
			value: {
				reload: async () => {},
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				extensionRunner: {},
				modelRuntime: { getError: () => undefined },
			},
		},
		options: { configurable: true, value: {} },
	});
	Object.assign(mode, {
		bindCurrentSessionExtensions: async () => {},
		promptTurnWorkingLoaderActive: false,
		stopWorkingLoader() {},
		themeController: { applyFromSettings: async () => {} },
		setupAutocompleteProvider() {},
		setupExtensionShortcuts() {},
		retryDeferredModelRestore: async () => {},
		updateAvailableProviderCount: async () => {},
		updateEditorBorderColor() {},
	});
}

async function renderNoticeBeforeDisclosure(startupPath: "eager" | "deferred", notice: StartupNotice): Promise<string> {
	const mode = createOrderingMode();
	mode.attachStartupNoticesContainer();
	Object.assign(mode, {
		showLoadedResources: (options: { targetContainer?: Container }) => {
			options.targetContainer?.addChild(new Text("RESOURCES", 0, 0));
		},
		showStartupNoticesIfNeeded() {},
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
	});
	if (startupPath === "eager") {
		mode.rebindCurrentSession = async () => notice.emit(mode);
		await bindInitialEagerSession(mode);
	} else {
		configureDeferredMode(mode);
		await notice.emit(mode);
		await InteractiveMode.prototype.completeDeferredStartup.call(mode);
	}
	return normalizeStartupOutput(mode.chatContainer);
}

function assertResourcesBefore(output: string, marker: string): void {
	assert.ok(output.includes("RESOURCES"), output);
	assert.ok(output.includes(marker), output);
	assert.ok(output.indexOf("RESOURCES") < output.indexOf(marker), output);
}

for (const startupPath of ["eager", "deferred"] as const) {
	for (const notice of directStartupNotices) {
		test(`${startupPath} startup keeps the ${notice.name} below RESOURCES`, async () => {
			assertResourcesBefore(await renderNoticeBeforeDisclosure(startupPath, notice), notice.marker);
		});
	}
}

const preparedChangelogNotice: StartupNotice = {
	name: "changelog notice",
	marker: "Updated to v1.2.3",
	emit(mode) {
		Object.assign(mode, {
			startupNoticesPrepared: true,
			startupNoticesShown: false,
			changelogMarkdown: "## [1.2.3]\n\n- ordering regression",
			firstRunNoticeVisible: false,
		});
		Object.defineProperties(mode, {
			settingsManager: { configurable: true, value: { getCollapseChangelog: () => true } },
			version: { configurable: true, value: "1.2.3" },
		});
		InteractiveMode.prototype.showStartupNoticesIfNeeded.call(mode, mode.startupNoticesContainer);
	},
};

const preparedFirstRunNotice: StartupNotice = {
	name: "first-run onboarding notice",
	marker: "Atomic is a verifiable coding agent runtime",
	emit(mode) {
		Object.assign(mode, {
			startupNoticesPrepared: true,
			startupNoticesShown: false,
			changelogMarkdown: undefined,
			firstRunNoticeVisible: true,
			firstRunOnboardingNoticeComponents: [],
		});
		Object.defineProperties(mode, {
			settingsManager: {
				configurable: true,
				value: { getCollapseChangelog: () => true, setOnboardedVersion() {} },
			},
			version: { configurable: true, value: "1.2.3" },
		});
		InteractiveMode.prototype.showStartupNoticesIfNeeded.call(mode, mode.startupNoticesContainer);
	},
};

const anthropicSubscriptionNotice: StartupNotice = {
	name: "Anthropic subscription extra-usage warning",
	marker: "extra usage and is billed per token",
	async emit(mode) {
		mode.anthropicSubscriptionWarningShown = false;
		Object.defineProperty(mode, "settingsManager", {
			configurable: true,
			value: { getWarnings: () => ({ anthropicExtraUsage: true }) },
		});
		Object.defineProperty(mode, "session", {
			configurable: true,
			value: {
				model: { provider: "anthropic" },
				modelRuntime: {
					getAuth: async () => ({
						auth: { apiKey: "sk-ant-oat01-test" },
						credential: { type: "oauth", access: "test", expires: Date.now() + 60_000 },
					}),
					isUsingOAuth: () => true,
					getError: () => undefined,
				},
				reload: async () => {},
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				extensionRunner: {},
			},
		});
		await InteractiveMode.prototype.maybeWarnAboutAnthropicSubscriptionAuth.call(
			mode,
			undefined,
			mode.startupNoticesContainer,
		);
	},
};

for (const startupPath of ["eager", "deferred"] as const) {
	for (const notice of [preparedChangelogNotice, preparedFirstRunNotice, anthropicSubscriptionNotice]) {
		test(`${startupPath} startup keeps the real ${notice.name} below RESOURCES`, async () => {
			assertResourcesBefore(await renderNoticeBeforeDisclosure(startupPath, notice), notice.marker);
		});
	}
}

test("isolated interactive-engine notify lands below RESOURCES", async () => {
	const mode = createOrderingMode();
	mode.attachStartupNoticesContainer();
	mode.resourceDisclosureContainer.addChild(new Text("RESOURCES", 0, 0));
	releaseStartupChatOutput(mode);
	const ui = InteractiveMode.prototype.createExtensionUIContext.call(mode) as ExtensionUIContext;
	let extensionUiHandler:
		| ((request: RpcExtensionUIRequest) => Promise<RpcExtensionUIResponse | undefined>)
		| undefined;
	const runtime = Object.create(IsolatedInteractiveRuntime.prototype) as IsolatedInteractiveRuntime;
	Object.assign(runtime, {
		onDiagnostic: () => () => {},
		onGenerationEnded: () => () => {},
		onEngineMessage: () => () => {},
		setExtensionUIHandler: (handler: typeof extensionUiHandler) => {
			extensionUiHandler = handler;
			return () => {};
		},
	});
	const dispose = attachInteractiveEngineHost(runtime, ui, () => {});
	assert.ok(extensionUiHandler);
	await extensionUiHandler({
		type: "extension_ui_request",
		id: "notify-ordering",
		method: "notify",
		message: "isolated engine warning",
		notifyType: "warning",
	});
	dispose();
	assertResourcesBefore(normalizeStartupOutput(mode.chatContainer), "isolated engine warning");
});

for (const startupPath of ["eager", "deferred"] as const) {
	for (const notifyType of ["info", "warning", "error"] as const) {
		test(`${startupPath} startup keeps an early extension ${notifyType} notification below RESOURCES`, async () => {
			const output = await renderStartupWithEarlyNotify(startupPath, notifyType);
			assert.ok(output.includes("RESOURCES"), output);
			assert.ok(output.indexOf("RESOURCES") < output.indexOf(`extension ${notifyType}`), output);
		});
	}
}

test("initial eager binding renders one disclosure in the reserved slot", async () => {
	const mode = createOrderingMode();
	let disclosureCount = 0;
	let disclosureTarget: Container | undefined;
	Object.assign(mode, {
		rebindCurrentSession: async () => {
			assert.equal(mode.initialStartupBinding, true);
		},
		showLoadedResources: (options: { targetContainer?: Container }) => {
			disclosureCount += 1;
			disclosureTarget = options.targetContainer;
		},
		showStartupNoticesIfNeeded() {},
	});

	await bindInitialEagerSession(mode);

	assert.equal(disclosureCount, 1);
	assert.equal(disclosureTarget, mode.resourceDisclosureContainer);
	assert.equal(mode.initialStartupBinding, false);
});

test("initial eager binding always clears its runtime suppression flag", async () => {
	const mode = createOrderingMode();
	Object.assign(mode, {
		rebindCurrentSession: async () => {
			throw new Error("binding failed");
		},
	});

	await assert.rejects(bindInitialEagerSession(mode), /binding failed/);
	assert.equal(mode.initialStartupBinding, false);
});

test("reattaching after a global clear restores disclosure, notices, then transcript order", () => {
	const mode = createOrderingMode();
	releaseStartupChatOutput(mode);
	mode.attachStartupNoticesContainer();
	mode.resourceDisclosureContainer.addChild(new Text("RESOURCES", 0, 0));
	mode.startupNoticesContainer.addChild(new Text("startup notice", 0, 0));
	mode.chatContainer.clear();

	mode.attachStartupNoticesContainer();
	const transcript = new Text("transcript", 0, 0);
	mode.chatContainer.addChild(transcript);

	assert.deepEqual(mode.chatContainer.children, [
		mode.resourceDisclosureContainer,
		mode.startupNoticesContainer,
		transcript,
	]);
	assert.equal(normalizeStartupOutput(mode.chatContainer), "RESOURCES\nstartup notice\ntranscript");
});

test("empty reserved startup slots render no blank line or spacer", () => {
	const mode = createOrderingMode();
	mode.attachStartupNoticesContainer();
	releaseStartupChatOutput(mode);
	mode.chatContainer.addChild(new Text("first visible message", 0, 0));

	assert.equal(normalizeStartupOutput(mode.chatContainer), "first visible message");
});

test("reload-style rebuild replaces the stale startup disclosure with one current-bottom block", () => {
	const mode = createOrderingMode();
	releaseStartupChatOutput(mode);
	mode.resourceDisclosureContainer.addChild(new Text("RESOURCES stale", 0, 0));
	Object.defineProperty(mode, "sessionManager", {
		configurable: true,
		value: { getEntries: () => [], getLeafId: () => null },
	});
	mode.renderSessionEntries = () => {
		mode.chatContainer.addChild(new Text("restored transcript", 0, 0));
	};

	InteractiveMode.prototype.rebuildChatFromMessages.call(mode, { resetStartupDisclosure: true });
	mode.chatContainer.addChild(new Text("RESOURCES current", 0, 0));

	const output = normalizeStartupOutput(mode.chatContainer);
	assert.equal(output.match(/RESOURCES/g)?.length, 1, output);
	assert.ok(output.indexOf("restored transcript") < output.indexOf("RESOURCES current"), output);
});

test("a post-startup runtime rebind appends RESOURCES at the current chat bottom", async () => {
	const mode = createShowLoadedResourcesThis({ quietStartup: false });
	mode.resourceDisclosureContainer = new Container();
	mode.startupNoticesContainer = new Container();
	mode.deferredStartupPending = false;
	mode.initialStartupBinding = false;
	mode.createExtensionUIContext = () => ({});
	mode.session.bindExtensions = async () => {};
	mode.session.agent = { waitForIdle: async () => {} };
	mode.setupAutocompleteProvider = () => {};
	mode.setupExtensionShortcuts = () => {};
	mode.showStartupNoticesIfNeeded = () => {};
	mode.showLoadedResources = (options: { force?: boolean; showDiagnosticsWhenQuiet?: boolean }) =>
		InteractiveMode.prototype.showLoadedResources.call(mode, options);
	InteractiveMode.prototype.attachStartupNoticesContainer.call(mode);
	mode.chatContainer.addChild(new Text("existing chat bottom", 0, 0));

	await InteractiveMode.prototype.bindCurrentSessionExtensions.call(mode);

	const output = normalizeStartupOutput(mode.chatContainer);
	assert.ok(output.indexOf("existing chat bottom") < output.lastIndexOf("RESOURCES"), output);
});

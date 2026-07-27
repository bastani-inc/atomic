import { test } from "bun:test";
import assert from "node:assert/strict";
import { Container, Text } from "@earendil-works/pi-tui";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { bindInitialEagerSession } from "../src/modes/interactive/interactive-initial-session-binding.ts";
import { normalizeRenderedOutput } from "./interactive-mode-status-helpers.ts";
import { createShowLoadedResourcesThis } from "./interactive-mode-status-resources-helpers.ts";

initTheme("dark");

function createOrderingMode(): InteractiveMode {
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, {
		chatContainer: new Container(),
		resourceDisclosureContainer: new Container(),
		startupNoticesContainer: new Container(),
		ui: { requestRender() {} },
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
	});
	return mode;
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
					modelRegistry: { getError: () => undefined },
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
			deferLoadedResourcesDisclosureUntilAgentEnd: false,
			updateAvailableProviderCount: async () => {},
			updateEditorBorderColor() {},
		});
		await InteractiveMode.prototype.completeDeferredStartup.call(mode);
	}
	return normalizeRenderedOutput(mode.chatContainer);
}

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
	assert.equal(normalizeRenderedOutput(mode.chatContainer), "RESOURCES\nstartup notice\ntranscript");
});

test("empty reserved startup slots render no blank line or spacer", () => {
	const mode = createOrderingMode();
	mode.attachStartupNoticesContainer();
	mode.chatContainer.addChild(new Text("first visible message", 0, 0));

	assert.equal(normalizeRenderedOutput(mode.chatContainer), "first visible message");
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

	const output = normalizeRenderedOutput(mode.chatContainer);
	assert.ok(output.indexOf("existing chat bottom") < output.lastIndexOf("RESOURCES"), output);
});

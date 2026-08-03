import assert from "node:assert/strict";
import { Container, Text } from "@earendil-works/pi-tui";
import { test } from "vitest";
import { bindInitialEagerSession } from "../src/modes/interactive/interactive-initial-session-binding.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	releaseStartupChatOutput,
	StartupChatContainer,
} from "../src/modes/interactive/interactive-startup-chat-container.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

initTheme("dark");
function createGateMode(): InteractiveMode {
	const mode = Object.create(InteractiveMode.prototype) as InteractiveMode;
	Object.assign(mode, {
		chatContainer: new StartupChatContainer(),
		resourceDisclosureContainer: new Container(),
		startupNoticesContainer: new Container(),
		ui: { requestRender() {} },
		lastStatusSpacer: undefined,
		lastStatusText: undefined,
	});
	mode.chatContainer.addChild(mode.resourceDisclosureContainer);
	mode.chatContainer.addChild(mode.startupNoticesContainer);
	return mode;
}

function normalizeGateOutput(container: Container, width = 220): string {
	return container
		.render(width)
		.join("\n")
		.replace(/\u001b\[[0-9;]*m/g, "")
		.split("\n")
		.map((line) => line.replace(/\s+$/g, ""))
		.join("\n")
		.trim();
}

function configureDeferredGateMode(mode: InteractiveMode): void {
	Object.defineProperties(mode, {
		session: {
			configurable: true,
			value: {
				reload: async () => {},
				subscribe: () => () => {},
				resourceLoader: { getThemes: () => ({ themes: [] }) },
				extensionRunner: {},
				modelRuntime: { getError: () => undefined },
			},
		},
		options: { configurable: true, value: {} },
	});
	Object.assign(mode, {
		bindCurrentSessionExtensions: async () => {},
		pendingUserInputs: [],
		promptTurnWorkingLoaderActive: false,
		stopWorkingLoader() {},
		themeController: { applyFromSettings: async () => {} },
		setupAutocompleteProvider() {},
		setupExtensionShortcuts() {},
		retryDeferredModelRestore: async () => {},
		updateAvailableProviderCount: async () => {},
		updateEditorBorderColor() {},
		showLoadedResources: (options: { targetContainer?: Container }) => {
			options.targetContainer?.addChild(new Text("RESOURCES", 0, 0));
		},
		showStartupNoticesIfNeeded() {},
		maybeWarnAboutAnthropicSubscriptionAuth: async () => {},
	});
}

function assertResourcesBefore(output: string, marker: string): void {
	assert.ok(output.includes("RESOURCES"), output);
	assert.ok(output.indexOf("RESOURCES") < output.indexOf(marker), output);
}

test("pre-init isolated notification stays below constructor-reserved RESOURCES slot", () => {
	const mode = createGateMode();
	mode.showExtensionNotify("pre-init isolated warning", "warning");
	mode.resourceDisclosureContainer.addChild(new Text("RESOURCES", 0, 0));
	releaseStartupChatOutput(mode);

	assertResourcesBefore(normalizeGateOutput(mode.chatContainer), "pre-init isolated warning");
});

test("startup chat output stays unpainted until disclosure and preserves notification order", () => {
	const mode = createGateMode();
	mode.attachStartupNoticesContainer();
	mode.showExtensionNotify("buffered info", "info");
	mode.showExtensionNotify("buffered warning", "warning");
	mode.showExtensionNotify("buffered error", "error");
	assert.deepEqual(mode.chatContainer.render(220), []);

	mode.resourceDisclosureContainer.addChild(new Text("RESOURCES", 0, 0));
	releaseStartupChatOutput(mode);
	const output = normalizeGateOutput(mode.chatContainer);
	assertResourcesBefore(output, "buffered info");
	assert.ok(output.indexOf("buffered info") < output.indexOf("buffered warning"), output);
	assert.ok(output.indexOf("buffered warning") < output.indexOf("buffered error"), output);
});

test("failed eager startup releases notifications when disclosure never renders", async () => {
	const mode = createGateMode();
	mode.attachStartupNoticesContainer();
	Object.assign(mode, {
		rebindCurrentSession: async () => {
			mode.showExtensionNotify("warning survives startup failure", "warning");
			throw new Error("startup failed");
		},
	});

	await assert.rejects(bindInitialEagerSession(mode), /startup failed/);
	const output = normalizeGateOutput(mode.chatContainer);
	assert.ok(output.includes("warning survives startup failure"), output);
	assert.ok(!output.includes("RESOURCES"), output);
});

test("failed deferred startup releases notifications when disclosure never renders", async () => {
	const mode = createGateMode();
	mode.attachStartupNoticesContainer();
	configureDeferredGateMode(mode);
	Object.assign(mode, {
		bindCurrentSessionExtensions: async () => {
			mode.showExtensionNotify("deferred warning survives startup failure", "warning");
			throw new Error("deferred startup failed");
		},
	});

	await InteractiveMode.prototype.completeDeferredStartup.call(mode);
	const output = normalizeGateOutput(mode.chatContainer);
	assert.ok(output.includes("deferred warning survives startup failure"), output);
	assert.ok(output.includes("Extension loading failed: deferred startup failed"), output);
	assert.ok(!output.includes("RESOURCES"), output);
});

test("real prompt turn paints RESOURCES before first-turn streaming output", async () => {
	const mode = createGateMode();
	mode.attachStartupNoticesContainer();
	configureDeferredGateMode(mode);
	mode.deferredStartupPending = true;
	let midTurnOutput = "";
	Object.assign(mode, {
		showWorkingLoaderNow() {},
		discardDeferredRenderedUserInput() {},
		ensureDeferredStartupComplete: async () => {
			await InteractiveMode.prototype.completeDeferredStartup.call(mode);
		},
	});
	Object.assign(mode.session, {
		resumeQueuedMessages: async () => {},
		prompt: async () => {
			mode.chatContainer.addChild(new Text("> user prompt echo", 0, 0));
			mode.chatContainer.addChild(new Text("assistant streaming token", 0, 0));
			midTurnOutput = normalizeGateOutput(mode.chatContainer);
		},
		isStreaming: false,
	});

	await InteractiveMode.prototype.runUserPromptTurn.call(mode, "hello agent");

	assert.equal(midTurnOutput, "RESOURCES\n> user prompt echo\nassistant streaming token");
});

test("prompt error paints below the disclosure rather than releasing an empty slot", async () => {
	const mode = createGateMode();
	mode.attachStartupNoticesContainer();
	configureDeferredGateMode(mode);
	mode.deferredStartupPending = true;
	Object.assign(mode, {
		showWorkingLoaderNow() {},
		discardDeferredRenderedUserInput() {},
		ensureDeferredStartupComplete: async () => {
			await InteractiveMode.prototype.completeDeferredStartup.call(mode);
		},
	});
	Object.assign(mode.session, {
		resumeQueuedMessages: async () => {},
		prompt: async () => {
			throw new Error("prompt rejected");
		},
		isStreaming: false,
	});

	await InteractiveMode.prototype.runUserPromptTurn.call(mode, "hello agent");

	assertResourcesBefore(normalizeGateOutput(mode.chatContainer), "prompt rejected");
});

test("restored transcript paints as soon as deferred disclosure ordering resolves", async () => {
	const mode = createGateMode();
	mode.attachStartupNoticesContainer();
	configureDeferredGateMode(mode);
	mode.chatContainer.addChild(new Text("user: earlier question", 0, 0));
	mode.chatContainer.addChild(new Text("assistant: earlier answer", 0, 0));
	assert.deepEqual(mode.chatContainer.render(220), []);

	await InteractiveMode.prototype.completeDeferredStartup.call(mode);

	assert.equal(
		normalizeGateOutput(mode.chatContainer),
		"RESOURCES\nuser: earlier question\nassistant: earlier answer",
	);
});

import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { Container, Text } from "@earendil-works/pi-tui";
import { test } from "vitest";
import type { MarkdownTransformer } from "../src/core/extensions/types.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { bindInitialEagerSession } from "../src/modes/interactive/interactive-initial-session-binding.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import {
	releaseStartupChatOutput,
	StartupChatContainer,
} from "../src/modes/interactive/interactive-startup-chat-container.ts";
import { getMarkdownTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

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
		rebuildChatFromMessages() {},
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

test("rebuilds restored transcript through deferred Markdown transformers", async () => {
	const mode = createGateMode();
	mode.attachStartupNoticesContainer();
	configureDeferredGateMode(mode);
	const messages = [
		{ role: "user", content: "earlier question", timestamp: 0 },
		{
			role: "assistant",
			content: [{ type: "text", text: "earlier answer" }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-4o-mini",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	] satisfies AgentMessage[];
	const entries: SessionEntry[] = messages.map((message, index) => ({
		type: "message",
		id: `message-${index}`,
		parentId: index === 0 ? null : `message-${index - 1}`,
		timestamp: new Date(index).toISOString(),
		message,
	}));
	const transformers: MarkdownTransformer[] = [];
	Object.assign(mode, {
		bindCurrentSessionExtensions: async () => {
			transformers.push((markdown, { messageType }) => `${messageType}: transformed ${markdown}`);
		},
		getMarkdownThemeWithSettings: () => getMarkdownTheme(),
		getRegisteredToolDefinition: () => undefined,
		pendingTools: new Map(),
		deferredRenderedUserInputs: [],
		deferredRenderedUserInputComponents: new Map(),
		toolOutputExpanded: false,
		hideThinkingBlock: false,
		hiddenThinkingLabel: "Thinking...",
		outputPad: 0,
		rebuildChatFromMessages: Reflect.get(InteractiveMode.prototype, "rebuildChatFromMessages"),
	});
	Object.assign(mode.session, {
		sessionManager: {
			getCwd: () => process.cwd(),
			getEntries: () => entries,
			getLeafId: () => entries.at(-1)?.id ?? null,
		},
		settingsManager: {
			getShowCacheMissNotices: () => false,
			getShowImages: () => false,
			getImageWidthCells: () => 80,
			getMermaidRenderingMode: () => "streaming",
			getLatexRenderingEnabled: () => true,
		},
		extensionRunner: {
			getMarkdownTransformers: () => transformers,
			getMessageRenderer: () => undefined,
		},
	});
	assert.deepEqual(mode.chatContainer.render(220), []);

	await InteractiveMode.prototype.completeDeferredStartup.call(mode);

	const output = normalizeGateOutput(mode.chatContainer);
	assertResourcesBefore(output, "user: transformed earlier question");
	assert.ok(output.includes("assistant: transformed earlier answer"), output);
	assert.ok(
		output.indexOf("user: transformed earlier question") < output.indexOf("assistant: transformed earlier answer"),
		output,
	);
});

import assert from "node:assert/strict";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, test } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import type { ToolRenderers } from "../src/core/extensions/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { attachInteractiveEngineResourceExtensionRefresh } from "../src/modes/interactive/interactive-startup.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";
import { EngineRenderService } from "../src/modes/interactive-engine/engine-render-service.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../src/modes/interactive-engine/protocol.js";
import type { RpcResourceExtension } from "../src/modes/rpc/rpc-types.js";
import { stripAnsi } from "../src/utils/ansi.js";

beforeAll(() => {
	initTheme("dark");
});

const extensionRenderers: ToolRenderers = {
	renderCall: () => new Text("extension card call", 0, 0),
	renderResult: (result) => new Text(`extension card result: ${JSON.stringify(result.details)}`, 0, 0),
};

function createEngineSession(): { session: AgentSession; loadExtensions(): void } {
	const runner = (renderers: ToolRenderers | undefined) => ({
		resolveToolRenderers: (toolName: string, base: () => ToolRenderers | undefined) =>
			toolName === "late_tool" ? renderers : base(),
	});
	const session = {
		extensionRunner: runner(undefined),
		getToolDefinition: () => undefined,
		sessionManager: { getCwd: () => "/" },
	};
	return {
		session: session as unknown as AgentSession,
		loadExtensions: () => {
			session.extensionRunner = runner(extensionRenderers);
		},
	};
}

async function renderedText(container: Container, expected: RegExp): Promise<string> {
	const deadline = Date.now() + 5000;
	let text = "";
	while (Date.now() < deadline) {
		text = container
			.render(80)
			.map((line) => stripAnsi(line))
			.join("\n");
		if (expected.test(text)) return text;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	return text;
}

test("atomic --session hydrates restored tool cards with extension renderers loaded after first paint (#3760)", async () => {
	const engine = createEngineSession();
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const resourceListeners: Array<(extensions: readonly RpcResourceExtension[]) => void> = [];
	const service = new EngineRenderService((line) => {
		const message = parseInteractiveEngineMessage(line.trim());
		if (message) for (const listener of [...listeners]) listener(message);
	});
	service.bindSession(engine.session);
	const runtime = Object.assign(Object.create(IsolatedInteractiveRuntime.prototype), {
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			listeners.push(listener);
			return () => listeners.splice(listeners.indexOf(listener), 1);
		},
		sendEngineCommand: (command: InteractiveEngineCommand) =>
			service.handleLine(serializeInteractiveEngineFrame(command).trim()),
		onResourceExtensionsChanged: (listener: (extensions: readonly RpcResourceExtension[]) => void) => {
			resourceListeners.push(listener);
			return () => {};
		},
	}) as IsolatedInteractiveRuntime;
	const chatContainer = new Container();
	const mode = {
		runtimeHost: runtime,
		ui: { requestRender: () => {} } as unknown as TUI,
		outputPad: 1,
		toolOutputExpanded: false,
		chatContainer,
		resourceDisclosureContainer: new Container(),
		sessionManager: { getCwd: () => "/" },
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getLatexRenderingEnabled: () => false,
		},
		getMarkdownThemeWithSettings: () => undefined,
		getMarkdownTransformers: () => [],
	} as unknown as InteractiveMode;
	try {
		attachInteractiveEngineResourceExtensionRefresh(mode);
		const options = InteractiveMode.prototype.chatMessageRenderOptions.call(mode);
		chatContainer.addChild(
			options.createToolComponent!({
				role: "tool",
				kind: "tool",
				toolName: "late_tool",
				toolCallId: "restored_call",
				args: { task: "persisted" },
				result: { content: [{ type: "text", text: "done" }], details: { state: "paused" }, isError: false },
				isPartial: false,
			}),
		);
		const firstPaint = await renderedText(chatContainer, /late_tool/);
		assert.match(firstPaint, /late_tool/);
		assert.doesNotMatch(firstPaint, /extension card/);

		engine.loadExtensions();
		for (const listener of resourceListeners) listener([]);

		const hydrated = await renderedText(chatContainer, /extension card result/);
		assert.match(hydrated, /extension card call/);
		assert.match(hydrated, /extension card result: \{"state":"paused"\}/);
	} finally {
		service.dispose();
	}
});

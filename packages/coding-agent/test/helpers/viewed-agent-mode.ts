import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@bastani/atomic-ai/compat";
import type { Component, Terminal } from "@bastani/atomic-tui";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.js";
import { createUnstartedAgentSessionFromServices } from "../../src/core/agent-session-services.js";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { InlineExtension } from "../../src/core/extensions/types.js";
import { ModelRuntime } from "../../src/core/model-runtime.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { InteractiveMode } from "../../src/index.js";
import { initTheme } from "../../src/modes/interactive/theme/theme.js";

const NO_BUILTINS = { subagents: false, mcp: false, "web-access": false, intercom: false } as const;

class FakeTerminal implements Terminal {
	columns = 160;
	rows = 40;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(): void {}
	moveBy(): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(): void {}
	setProgress(): void {}
	setProgramStatus(): void {}
}

export interface MainScreen {
	readonly mode: InteractiveMode;
	/** What the main transcript shows, without styling. */
	transcript(): string;
	/** The component that holds the prompt's place: the prompt, or a dialog or menu shown over it. */
	promptSlot(): Component | undefined;
	/** The text of the dialog or menu in the prompt's place. */
	promptSlotText(): string;
	cleanup(): Promise<void>;
}

/**
 * A real interactive host over a real in-process session on the faux provider, initialized as the CLI starts it, with
 * `extensions` loaded on the main session.
 */
export async function createMainScreen(extensions: InlineExtension[] = []): Promise<MainScreen> {
	initTheme("dark");
	const cwd = mkdtempSync(join(tmpdir(), "atomic-viewed-cwd-"));
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-viewed-agent-"));
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [
			{
				id: model.id,
				name: model.name,
				api: model.api,
				reasoning: true,
				input: model.input,
				cost: model.cost,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				baseUrl: model.baseUrl,
			},
		],
	});
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const services = await createAgentSessionServices({
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			modelRuntime,
			resourceLoaderOptions: {
				cwd: runtimeOptions.cwd,
				agentDir: runtimeOptions.agentDir,
				builtinPackagePaths: [],
				extensionFactories: extensions,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const created = await createUnstartedAgentSessionFromServices({
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			model: faux.getModel(),
			builtins: NO_BUILTINS,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	const mode = new InteractiveMode(runtime, { terminal: new FakeTerminal() });
	await mode.init();
	const promptSlot = () => mode.editorContainer.children.at(-1);
	return {
		mode,
		transcript: () => stripStyles(mode.chatContainer.render(160).join("\n")),
		promptSlot,
		promptSlotText: () => stripStyles(promptSlot()?.render(160).join("\n") ?? ""),
		async cleanup() {
			mode.stop();
			await runtime.dispose();
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		},
	};
}

function stripStyles(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal styling is stripped from rendered lines.
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]|\x1B_[^\x07\x1B]*(?:\x07|\x1B\\)|\x1B\][^\x07]*\x07/g, "");
}

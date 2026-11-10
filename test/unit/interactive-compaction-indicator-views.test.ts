import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { registerFauxProvider } from "@bastani/pi-ai/compat";
import { getKeybindings, setKeybindings, type Terminal } from "@earendil-works/pi-tui";
import { afterEach, test } from "vitest";
import { ENV_OFFLINE } from "../../packages/coding-agent/src/config.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import type { ExtensionFactory, ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { presentQuestionnaire } from "../../packages/coding-agent/src/core/tools/ask-user-question/ask-user-question.ts";
import { InteractiveMode } from "../../packages/coding-agent/src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.ts";
import { type InputsUiSurface, openInputsPicker } from "../../packages/workflows/src/tui/inputs-overlay.ts";

/**
 * Structural cost, not a slow test: each case constructs a real InteractiveMode
 * host with its session, resources and keybindings, which takes over 60% of the
 * default budget on Windows runners.
 */
const INTERACTIVE_MODE_HOST_TIMEOUT_MS = 90_000;

const ESCAPE = "\x1b";

class FakeTerminal implements Terminal {
	columns = 100;
	rows = 36;
	kittyProtocolActive = true;
	private onInput: ((data: string) => void) | undefined;
	start(onInput: (data: string) => void): void {
		this.onInput = onInput;
	}
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
	input(data: string): void {
		this.onInput?.(data);
	}
}

type CompactionReason = "manual" | "threshold" | "overflow";

interface CompactionGate {
	readonly factory: ExtensionFactory;
	arm(): { entered: Promise<void>; release(): void };
	releaseAll(): void;
}

function createCompactionGate(): CompactionGate {
	const releases: Array<() => void> = [];
	const newGate = () => {
		const gate = { entered: Promise.withResolvers<void>(), released: Promise.withResolvers<void>() };
		releases.push(() => gate.released.resolve());
		return gate;
	};
	let current = newGate();
	return {
		factory: (pi) => {
			pi.on("session_before_compact", async () => {
				const gate = current;
				gate.entered.resolve();
				await gate.released.promise;
				return { compactedText: "[User]: retained\n(filtered 3 lines)" };
			});
		},
		arm() {
			const gate = newGate();
			current = gate;
			return { entered: gate.entered.promise, release: () => gate.released.resolve() };
		},
		releaseAll() {
			for (const release of releases) release();
		},
	};
}

interface AutoCompactionRunner {
	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<unknown>;
}

interface CompactingMode {
	readonly mode: InteractiveMode;
	readonly terminal: FakeTerminal;
	readonly ui: ExtensionUIContext;
	status(): string;
	startCompaction(reason: CompactionReason): Promise<RunningCompaction>;
}

interface RunningCompaction {
	finish(): Promise<void>;
}

const originalKeybindings = getKeybindings();
const originalAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const originalOffline = process.env[ENV_OFFLINE];
const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
	while (cleanup.length > 0) await cleanup.pop()?.();
	if (originalAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = originalAgentDir;
	if (originalOffline === undefined) delete process.env[ENV_OFFLINE];
	else process.env[ENV_OFFLINE] = originalOffline;
	setKeybindings(originalKeybindings);
});

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function seedTranscript(mode: InteractiveMode): Promise<void> {
	const now = Date.now();
	for (let turn = 0; turn < 5; turn++) {
		await mode.session.sessionManager.appendMessage({
			role: "user",
			content: `task ${turn}\nline a\nline b`,
			timestamp: now + turn * 2,
		});
		await mode.session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: `answer ${turn}\nline c\nline d` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now + turn * 2 + 1,
		});
	}
	mode.session.agent.state.messages = mode.session.sessionManager.buildSessionContext().messages;
}

async function createCompactingMode(): Promise<CompactingMode> {
	process.env[ENV_OFFLINE] = "1";
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-compaction-views-agent-"));
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	setKeybindings(KeybindingsManager.create(agentDir));
	const cwd = mkdtempSync(join(tmpdir(), "atomic-compaction-views-cwd-"));
	const faux = registerFauxProvider();
	const authStorage = AuthStorage.inMemory({ [faux.getModel().provider]: { type: "api_key", key: "faux-key" } });
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	const gate = createCompactionGate();
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd: runtimeCwd,
		agentDir: runtimeAgentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({
			cwd: runtimeCwd,
			agentDir: runtimeAgentDir,
			modelRuntime,
			resourceLoaderOptions: {
				extensionFactories: [gate.factory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	initTheme("dark");
	const terminal = new FakeTerminal();
	const mode = new InteractiveMode(runtime, { terminal });
	cleanup.push(async () => {
		gate.releaseAll();
		mode.stop();
		await runtime.dispose();
		faux.unregister();
		rmSync(cwd, { recursive: true, force: true });
		rmSync(agentDir, { recursive: true, force: true });
	});
	await mode.init();
	await mode.bindCurrentSessionExtensions();
	await seedTranscript(mode);

	return {
		mode,
		terminal,
		ui: mode.createExtensionUIContext(),
		status: () => stripVTControlCharacters(mode.statusContainer.render(100).join("\n")),
		async startCompaction(reason) {
			await seedTranscript(mode);
			const compaction = gate.arm();
			const run =
				reason === "manual"
					? mode.session.compact({ preserve_recent: 2 })
					: (mode.session as unknown as AutoCompactionRunner)._runAutoCompaction(reason, false);
			await compaction.entered;
			assert.equal(mode.session.isCompacting, true, "the session is really compacting");
			return {
				async finish() {
					compaction.release();
					await run;
					await flush();
					assert.equal(mode.session.isCompacting, false, "the session finished compacting");
				},
			};
		},
	};
}

interface OpenView {
	readonly name: string;
	open(host: CompactingMode): Promise<void> | void;
}

function editorHolds(host: CompactingMode): boolean {
	return host.mode.editorContainer.children.includes(host.mode.editor);
}

const views: readonly OpenView[] = [
	{ name: "/settings selector", open: (host) => host.mode.showSettingsSelector() },
	{ name: "/tree selector", open: (host) => host.mode.showTreeSelector() },
	{ name: "/resume session selector", open: (host) => host.mode.showSessionSelector() },
	{ name: "/model selector", open: (host) => host.mode.showModelSelector() },
	{ name: "extension select dialog", open: (host) => void host.ui.select("Pick", ["a", "b"]) },
	{ name: "extension confirm dialog", open: (host) => void host.ui.confirm("Sure?", "Proceed") },
	{ name: "extension input dialog", open: (host) => void host.ui.input("Name", "placeholder") },
	{
		name: "inline custom view",
		open: (host) =>
			void host.ui.custom((_tui, _theme, _keybindings, done) => ({
				render: () => ["inline custom view"],
				invalidate() {},
				handleInput: (data: string) => {
					if (data === ESCAPE) done(undefined);
				},
			})),
	},
	{
		name: "overlay custom view",
		open: (host) =>
			void host.ui.custom(
				(_tui, _theme, _keybindings, done) => ({
					render: () => ["overlay custom view"],
					invalidate() {},
					handleInput: (data: string) => {
						if (data === ESCAPE) done(undefined);
					},
				}),
				{ overlay: true },
			),
	},
	{
		name: "ask_user_question questionnaire",
		open: (host) =>
			void presentQuestionnaire(host.ui, {
				questions: [
					{
						question: "Which one?",
						header: "Pick",
						options: [
							{ label: "A", description: "first" },
							{ label: "B", description: "second" },
						],
					},
				],
			}).catch(() => undefined),
	},
	{
		name: "host input form",
		open: (host) =>
			void host.ui.hostInputForm?.({
				title: "Inputs",
				fields: [{ name: "prompt", type: "string", required: true, initialValue: "" }],
			}),
	},
	{
		name: "workflow inputs picker",
		open: (host) =>
			void openInputsPicker(host.ui as unknown as InputsUiSurface, {
				workflowName: "tournament",
				fields: [{ name: "prompt", type: "string", required: true }],
				prefilled: {},
				theme: deriveGraphTheme({}),
			}),
	},
];

async function dismiss(host: CompactingMode): Promise<void> {
	for (let attempt = 0; attempt < 3 && !viewClosed(host); attempt++) {
		host.terminal.input(ESCAPE);
		await flush();
	}
}

function viewClosed(host: CompactingMode): boolean {
	return editorHolds(host) && !host.mode.ui.hasOverlay() && host.mode.extensionDialogs.length === 0;
}

const reasons = ["manual", "threshold", "overflow"] as const;

async function assertViewRoundTrips(host: CompactingMode, view: OpenView): Promise<void> {
	for (const reason of reasons) {
		const compaction = await host.startCompaction(reason);
		const label = host.status();
		assert.match(label, /\(esc Cancel\)/, `${reason}: indicator shown before ${view.name} opens`);

		await view.open(host);
		await flush();
		assert.equal(viewClosed(host), false, `${view.name} is open`);
		await dismiss(host);
		assert.equal(viewClosed(host), true, `${view.name} is closed again`);
		assert.equal(host.status(), label, `${view.name}: ${reason} indicator restored with reason and cancel hint`);

		await view.open(host);
		await flush();
		await compaction.finish();
		await dismiss(host);
		assert.equal(viewClosed(host), true, `${view.name} is closed again`);
		assert.doesNotMatch(host.status(), /ompacting|\(esc Cancel\)/, `${view.name}: ${reason} ended while open`);
		assert.equal(host.mode.autoCompactionLoader, undefined, `${view.name}: ${reason} loader released`);
	}

	await view.open(host);
	await flush();
	const startedWhileOpen = await host.startCompaction("threshold");
	await dismiss(host);
	assert.equal(viewClosed(host), true, `${view.name} is closed again`);
	assert.match(host.status(), /Auto-compacting\.\.\. \(esc Cancel\)/, `${view.name}: started while open`);
	await startedWhileOpen.finish();
	assert.doesNotMatch(host.status(), /ompacting/);
}

for (const view of views) {
	test.sequential(
		`#4625: ${view.name} shows the compaction indicator on return mid-compaction and leaves nothing stale once it ended`,
		async () => assertViewRoundTrips(await createCompactingMode(), view),
		INTERACTIVE_MODE_HOST_TIMEOUT_MS,
	);
}

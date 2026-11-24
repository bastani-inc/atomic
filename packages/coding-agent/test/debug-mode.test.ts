import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Container,
	getKeybindings,
	SelectList,
	setKeybindings,
	Text,
	TuiAltScreen,
	TuiMainScreen,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	VStack,
} from "@bastani/atomic-tui";
import { afterEach, describe, it, vi } from "vitest";
import { parseArgs, printHelp } from "../src/cli/args.js";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.js";
import { boundedInteractiveModelRefresh } from "../src/core/bounded-model-refresh.ts";
import { isDebugEnabled } from "../src/core/debug.js";
import { DebugConfigError, isDebugConfigError } from "../src/core/debug-errors.js";
import { setDebugSetting } from "../src/core/debug-setting.js";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { ModelRuntime } from "../src/core/model-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.js";
import { main } from "../src/main.js";
import { createSettingsChangeHandler } from "../src/modes/interactive/components/settings-selector-handlers.js";
import { buildSettingsItems } from "../src/modes/interactive/components/settings-selector-items.js";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector-types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { refreshModelCatalogs } from "../src/modes/interactive/model-catalog-refresh.ts";
import { getSelectListTheme, initTheme } from "../src/modes/interactive/theme/theme.js";
import { buildInteractiveEngineArgs } from "../src/modes/interactive-engine/engine-args.js";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { RpcClientApi } from "../src/modes/rpc/rpc-client-api.js";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.js";
import { createRpcInputLineHandler } from "../src/modes/rpc/rpc-input.js";
import { createRpcErrorResponse } from "../src/modes/rpc/rpc-responses.js";
import type { RpcCommandBody, RpcResponse } from "../src/modes/rpc/rpc-types.js";
import { stripAnsi } from "../src/utils/ansi.ts";
import { RecordingTerminal } from "./helpers/interactive-fullscreen-layout.ts";
import { createHarness } from "./suite/harness.js";

const unusedCreateRuntime = (async () => {
	throw new Error("unused runtime factory");
}) as CreateAgentSessionRuntimeFactory;

afterEach(() => {
	setDebugSetting(false);
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("debug setting (#4360)", () => {
	it("defaults to off, saves globally and ignores a project file", async () => {
		const storage = new InMemorySettingsStorage();
		storage.withLock("project", () => JSON.stringify({ debug: true }));
		const settings = SettingsManager.fromStorage(storage);
		assert.equal(settings.getDebug(), false, "a project cannot turn debug output on");
		settings.setDebug(true);
		await settings.flush();
		assert.equal(settings.getDebug(), true);
		assert.equal(settings.getGlobalSettings().debug, true);
		assert.equal(SettingsManager.fromStorage(storage).getDebug(), true, "persisted");
		settings.setDebug(false);
		assert.equal(settings.getDebug(), false);
		assert.equal(SettingsManager.inMemory({ debug: "yes" } as never).getDebug(), false, "only true turns it on");
	});

	it('appears as "Debug mode" in /settings and reports a toggle', () => {
		const onDebugChange = vi.fn();
		const callbacks = { onDebugChange } as unknown as SettingsCallbacks;
		for (const debug of [false, true]) {
			const item = buildSettingsItems({ debug, warnings: {} } as unknown as SettingsConfig, callbacks).find(
				({ id }) => id === "debug",
			);
			assert.deepEqual(
				item && {
					label: item.label,
					description: item.description,
					currentValue: item.currentValue,
					values: item.values,
				},
				{
					label: "Debug mode",
					description:
						"Turn on every debug output and write it to ~/.atomic/agent/atomic-debug.log (where /debug writes its render and message dump)",
					currentValue: String(debug),
					values: ["true", "false"],
				},
			);
		}
		const change = createSettingsChangeHandler(callbacks);
		change("debug", "true");
		change("debug", "false");
		assert.deepEqual(onDebugChange.mock.calls, [[true], [false]]);
	});
});

describe("--debug (#4360)", () => {
	it("parses, reaches the interactive engine, and is in the help", () => {
		assert.equal(parseArgs(["--debug"]).debug, true);
		assert.equal(parseArgs([]).debug, undefined);
		const engine = buildInteractiveEngineArgs(parseArgs(["--debug"]), SessionManager.inMemory(), {});
		assert.equal(engine.filter((arg) => arg === "--debug").length, 1);
		assert.equal(buildInteractiveEngineArgs(parseArgs([]), SessionManager.inMemory(), {}).includes("--debug"), false);
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		printHelp();
		const help = log.mock.calls.flat().join("\n");
		assert.match(help, /--debug\s+Turn on debug mode for this run \(same as ATOMIC_DEBUG=1\)/);
		assert.match(
			help,
			/ATOMIC_DEBUG\s+- Turn on debug mode when set to 1 \(writes debug output to ~\/\.atomic\/agent\/atomic-debug\.log, where \/debug writes its render and message dump\)/,
		);
	});
});

/** An RPC client whose engine answered `response`; nothing is started. */
class RefusingRpcClient extends RpcClient {
	constructor(private readonly response: RpcResponse) {
		super();
	}
	protected override async request(): Promise<RpcResponse> {
		return this.response;
	}
}

class RecordingRpcClient extends RpcClientApi {
	readonly commands: RpcCommandBody[] = [];
	protected async request(command: RpcCommandBody): Promise<RpcResponse> {
		this.commands.push(command);
		return { type: "response", command: "set_debug", success: true };
	}
	protected data<T>(): T {
		return undefined as T;
	}
}

describe("set_debug RPC (#4360)", () => {
	it("the client sends the setting", async () => {
		const client = new RecordingRpcClient();
		await client.setDebug(true);
		await client.setDebug(false);
		assert.deepEqual(client.commands, [
			{ type: "set_debug", enabled: true },
			{ type: "set_debug", enabled: false },
		]);
	});

	it("the engine applies it at once, even while its resources are still loading", async () => {
		const handler = createRpcCommandHandler({
			runtimeHost: {} as never,
			getSession: () => ({}) as never,
			rebindSession: async () => {},
			output: () => {},
			waitForResources: () => new Promise<void>(() => {}),
		});
		assert.deepEqual(await handler({ id: "on", type: "set_debug", enabled: true }), {
			id: "on",
			type: "response",
			command: "set_debug",
			success: true,
		});
		assert.equal(isDebugEnabled("engine", {}), true);
		await handler({ type: "set_debug", enabled: false });
		assert.equal(isDebugEnabled("engine", {}), false);
	});

	it("the engine refuses anything but true or false, changing nothing", async () => {
		const handler = createRpcCommandHandler({
			runtimeHost: {} as never,
			getSession: () => ({}) as never,
			rebindSession: async () => {},
			output: () => {},
		});
		for (const [enabled, received] of [
			["false", "string"],
			[1, "number"],
			[null, "null"],
			[undefined, "undefined"],
		] as const) {
			await assert.rejects(
				handler({ type: "set_debug", enabled } as never),
				(error: unknown) =>
					isDebugConfigError(error) &&
					error.code === "invalid-setting" &&
					error.source === "rpc" &&
					error.field === "enabled" &&
					error.received === received,
			);
			assert.equal(isDebugEnabled(undefined, {}), false);
		}
		const responses: unknown[] = [];
		const handleLine = createRpcInputLineHandler({
			output: (response) => responses.push(response),
			pendingExtensionRequests: new Map(),
			handleCommand: handler,
			checkShutdownRequested: async () => {},
		});
		await handleLine(JSON.stringify({ id: "text", type: "set_debug", enabled: "secret-looking value" }));
		assert.equal(responses.length, 1);
		assert.deepEqual(responses[0], {
			id: "text",
			type: "response",
			command: "set_debug",
			success: false,
			error: "Invalid debug setting: enabled is string, not a boolean (invalid-setting). Pass true or false.",
			errorCode: "debug_error",
			errorDetails: {
				name: "DebugConfigError",
				code: "invalid-setting",
				message: "Invalid debug setting: enabled is string, not a boolean (invalid-setting). Pass true or false.",
				hint: "Pass true or false.",
				retryable: false,
				fields: { source: "rpc", field: "enabled", received: "string" },
			},
		});
		assert.equal(JSON.stringify(responses).includes("secret-looking value"), false, "only the value's type is sent");
		assert.equal(isDebugEnabled(undefined, {}), false);
		const client = new RefusingRpcClient(responses[0] as RpcResponse);
		await assert.rejects(
			client.setDebug(true),
			(error: unknown) =>
				error instanceof DebugConfigError &&
				error.source === "rpc" &&
				error.field === "enabled" &&
				error.received === "string",
		);
	});

	it("an error that is not a debug error keeps the plain error response", () => {
		for (const cause of [new Error("boom"), "boom", undefined]) {
			assert.deepEqual(createRpcErrorResponse("id", "set_debug", "boom", cause), {
				id: "id",
				type: "response",
				command: "set_debug",
				success: false,
				error: "boom",
			});
		}
	});

	it("the interactive host sends each change to its engine until it is disposed", async () => {
		const harness = await createHarness();
		try {
			const local = new AgentSessionRuntime(
				harness.session,
				{ cwd: harness.tempDir, agentDir: harness.tempDir } as never,
				unusedCreateRuntime,
			);
			const setDebug = vi.fn(async (_enabled: boolean) => {});
			const client = {
				onEvent: () => () => {},
				onGenerationEnded: () => () => {},
				setDebug,
				stop: async () => {},
			} as never;
			const runtime = new IsolatedInteractiveRuntime(local, unusedCreateRuntime, client);
			const diagnostics: string[] = [];
			runtime.onDiagnostic((diagnostic) => diagnostics.push(diagnostic.message));
			setDebugSetting(true);
			setDebugSetting(false);
			assert.deepEqual(setDebug.mock.calls, [[true], [false]]);
			setDebug.mockRejectedValueOnce(new Error("engine gone"));
			setDebugSetting(true);
			await vi.waitFor(() => assert.deepEqual(diagnostics, ["Interactive engine set debug failed: engine gone"]));
			await runtime.dispose({ fromSignal: true }).catch(() => {});
			setDebugSetting(false);
			assert.equal(setDebug.mock.calls.length, 3, "a disposed host no longer follows the setting");
		} finally {
			harness.cleanup();
		}
	});
});

describe("startup (#4360)", () => {
	it("--debug turns debug mode on for the process and everything it starts, and the saved setting is applied", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-debug-startup-"));
		try {
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
			vi.stubEnv("ATOMIC_DEBUG", undefined);
			vi.stubEnv("PI_DEBUG", undefined);
			vi.stubEnv("ATOMIC_DEBUG_SETTING", undefined);
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				throw new Error(`process.exit(${code})`);
			}) as typeof process.exit);
			const version = (...flags: string[]) => main(["--no-extensions", ...flags, "--version"]);
			await assert.rejects(version(), /process\.exit\(0\)/);
			assert.equal(process.env.ATOMIC_DEBUG, undefined);
			assert.equal(isDebugEnabled(), false);
			for (const prompt of [
				["-p", "--", "--debug"],
				["--system-prompt", "--debug"],
				["--name", "--debug"],
			]) {
				await assert.rejects(main(["--no-extensions", "--version", ...prompt]), /process\.exit\(0\)/);
				assert.equal(process.env.ATOMIC_DEBUG, undefined, JSON.stringify(prompt));
				assert.equal(isDebugEnabled(), false, JSON.stringify(prompt));
			}
			await assert.rejects(version("--debug"), /process\.exit\(0\)/);
			assert.equal(process.env.ATOMIC_DEBUG, "1", "child processes inherit --debug");
			vi.stubEnv("ATOMIC_DEBUG", undefined);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ debug: true }));
			await assert.rejects(version(), /process\.exit\(0\)/);
			assert.equal(isDebugEnabled(undefined, {}), true, "the saved setting");
			assert.equal(process.env.ATOMIC_DEBUG, undefined);
			vi.stubEnv("ATOMIC_DEBUG_SETTING", "0");
			setDebugSetting(false);
			await assert.rejects(version(), /process\.exit\(0\)/);
			assert.equal(isDebugEnabled(undefined, {}), false, "an inherited off wins over a saved on");
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ debug: false }));
			vi.stubEnv("ATOMIC_DEBUG_SETTING", "1");
			setDebugSetting(true);
			await assert.rejects(version(), /process\.exit\(0\)/);
			assert.equal(isDebugEnabled(undefined, {}), true, "an inherited on wins over a saved off");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
	it("auth check only enables debug for a parsed flag, not an option value", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-debug-auth-"));
		const exitCode = process.exitCode;
		try {
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
			vi.stubEnv("ATOMIC_DEBUG", undefined);
			vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				throw new Error(`process.exit(${code})`);
			}) as typeof process.exit);
			await assert.rejects(main(["auth", "check", "--provider", "--debug", "--unknown"]), /process\.exit\(2\)/);
			assert.equal(process.env.ATOMIC_DEBUG, undefined);
			assert.equal(process.exitCode, 2);
			await assert.rejects(main(["auth", "check", "--debug", "--unknown"]), /process\.exit\(2\)/);
			assert.equal(process.env.ATOMIC_DEBUG, "1");
			assert.equal(process.exitCode, 2);
		} finally {
			process.exitCode = exitCode;
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("/debug (#4360)", () => {
	it("appends its snapshot to the debug log, keeping what debug mode wrote before it", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-debug-command-"));
		try {
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
			initTheme("dark");
			const path = join(agentDir, "atomic-debug.log");
			const earlier = `${JSON.stringify({ area: "workflow", event: "earlier" })}\n`;
			writeFileSync(path, earlier);
			const host = {
				ui: { terminal: { columns: 80, rows: 24 }, render: () => ["rendered line"], requestRender: () => {} },
				session: { messages: [] },
				chatContainer: { addChild: () => {} },
			};
			await Reflect.apply(InteractiveMode.prototype.handleDebugCommand, host, []);
			const written = readFileSync(path, "utf8");
			assert.equal(written.startsWith(`${earlier}Debug output at `), true, written.slice(0, 200));
			assert.match(written, /"rendered line"/);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("keeps painted-row selection targets aligned with the screen when Shift+Ctrl+D runs in the same frame as a catalog refresh", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "atomic-debug-paint-"));
		const previousKeys = getKeybindings();
		setKeybindings(KeybindingsManager.create());
		initTheme("dark");

		class PaintedRowCatalogPicker extends Container {
			private items: string[];
			private rowLines = new Map<number, string>();
			private rowLinesWidth = 0;
			private mousePressed: string | undefined;
			private readonly header = new Container();
			private readonly selectList: SelectList;
			private readonly onPick: (id: string) => void;

			constructor(initialItems: string[], onPick: (id: string) => void) {
				super();
				this.items = [...initialItems];
				this.onPick = onPick;
				this.header.addChild(new Text("Select model", 0, 0));
				this.selectList = new SelectList(
					initialItems.map((id) => ({ value: id, label: id })),
					5,
					getSelectListTheme(),
				);
				this.selectList.onSelect = (item) => this.onPick(`list:${item.value}`);
				this.addChild(this.header);
				this.addChild(this.selectList);
			}

			setCatalogItems(nextItems: string[], refreshNotice: string): void {
				this.items = [...nextItems];
				this.header.addChild(new Text(refreshNotice, 0, 0));
			}

			override render(width: number): string[] {
				const lines = super.render(width);
				this.rowLines = new Map();
				this.rowLinesWidth = width;
				for (const id of this.items) {
					this.rowLines.set(lines.length, id);
					lines.push(`  ${id}`);
				}
				return lines;
			}

			override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
				const id = this.rowLinesWidth === event.width ? this.rowLines.get(event.y) : undefined;
				if (id !== undefined) {
					if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
					if (!this.items.includes(id)) {
						this.mousePressed = undefined;
						return { handled: true };
					}
					if (event.type === "press") {
						this.mousePressed = id;
						return { handled: true, focus: true };
					}
					const pressed = this.mousePressed;
					this.mousePressed = undefined;
					if (pressed === id) this.onPick(id);
					return { handled: true };
				}
				return super.handleMouse(event);
			}
		}

		const terminal = new RecordingTerminal();
		terminal.columns = 100;
		terminal.rows = 30;
		const tui = new TuiAltScreen(terminal);
		const chosen: string[] = [];
		const picker = new PaintedRowCatalogPicker(["openai/gpt-4o", "anthropic/claude-sonnet-4-5"], (id) =>
			chosen.push(id),
		);
		const editorContainer = new Container();
		editorContainer.addChild(picker);
		const dock = new VStack([
			{ component: editorContainer, shrink: 1, minSize: 3 },
			{ component: new Text("footer", 0, 0), shrink: 1, minSize: 1 },
		]);
		const root = new VStack([
			{ component: new Text("transcript", 0, 0), basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);
		const host = {
			ui: tui,
			session: { messages: [] },
			chatContainer: new Container(),
		};
		let debugLogWrite: Promise<void> | undefined;
		tui.onDebug = () => {
			debugLogWrite = Reflect.apply(InteractiveMode.prototype.handleDebugCommand, host, []);
		};
		tui.setLayoutRoot(root);
		tui.setFocus(picker);
		tui.start();
		tui.renderNow();

		try {
			vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
			const painted = tui.getScreenLines().map(stripAnsi);
			const listRow = painted.findIndex((line) => line.includes("∀ openai/gpt-4o"));
			const customRow = painted.findIndex((line) => line.trim() === "openai/gpt-4o");
			assert.equal(listRow >= 0, true);
			assert.equal(customRow >= 0, true);

			let releaseRefresh!: () => void;
			const refreshGate = new Promise<void>((resolve) => {
				releaseRefresh = resolve;
			});
			const runtime = {
				refresh: async () => {
					await refreshGate;
					return { aborted: false, errors: new Map() };
				},
				isNetworkRefreshEnabled: () => true,
				readCatalogInputsKey: async () => "0",
			} as unknown as ModelRuntime;

			const refreshTask = boundedInteractiveModelRefresh((options) => refreshModelCatalogs(runtime, options)).then(
				() => {
					picker.setCatalogItems(
						["openai/gpt-4.1-mini", "openai/gpt-4o", "anthropic/claude-sonnet-4-5"],
						"Model catalogs refreshed.",
					);
					tui.requestRender();
				},
			);

			const writesBeforeRefresh = terminal.writes.length;
			releaseRefresh();
			await refreshTask;

			terminal.input("\x1b[100;6u");
			assert.equal(terminal.writes.length, writesBeforeRefresh);
			assert.equal(stripAnsi(tui.getScreenLines()[listRow] ?? "").includes("openai/gpt-4o"), true);
			assert.equal(stripAnsi(tui.getScreenLines()[customRow] ?? "").trim(), "openai/gpt-4o");

			terminal.input(`\x1b[<0;8;${customRow + 1}M`);
			terminal.input(`\x1b[<0;8;${customRow + 1}m`);
			assert.deepEqual(chosen, ["openai/gpt-4o"]);

			terminal.input(`\x1b[<0;8;${listRow + 2}M`);
			terminal.input(`\x1b[<0;8;${listRow + 2}m`);
			assert.deepEqual(chosen, ["openai/gpt-4o", "list:anthropic/claude-sonnet-4-5"]);

			await debugLogWrite;
			const written = readFileSync(join(agentDir, "atomic-debug.log"), "utf8");
			assert.equal(written.includes("Model catalogs refreshed."), false);

			const mainTerminal = new RecordingTerminal();
			const mainTui = new TuiMainScreen(mainTerminal);
			const mainLine = new Text("painted main line", 0, 0);
			mainTui.addChild(mainLine);
			mainTui.start();
			mainTui.renderNow();
			mainLine.setText("unpainted main line");
			mainTui.requestRender();
			const mainHost = {
				ui: mainTui,
				session: { messages: [] },
				chatContainer: new Container(),
			};
			mainTui.onDebug = () => {
				debugLogWrite = Reflect.apply(InteractiveMode.prototype.handleDebugCommand, mainHost, []);
			};
			mainTerminal.input("\x1b[100;6u");
			mainTui.stop();
			await debugLogWrite;

			const afterMain = readFileSync(join(agentDir, "atomic-debug.log"), "utf8");
			assert.match(afterMain, /"painted main line/);
			assert.equal(afterMain.includes("unpainted main line"), false);
		} finally {
			tui.stop();
			setKeybindings(previousKeys);
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

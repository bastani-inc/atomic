import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, vi } from "vitest";
import { parseArgs, printHelp } from "../src/cli/args.ts";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { isDebugEnabled } from "../src/core/debug.ts";
import { isDebugConfigError } from "../src/core/debug-errors.ts";
import { setDebugSetting } from "../src/core/debug-setting.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { main } from "../src/main.ts";
import { createSettingsChangeHandler } from "../src/modes/interactive/components/settings-selector-handlers.ts";
import { buildSettingsItems } from "../src/modes/interactive/components/settings-selector-items.ts";
import type { SettingsCallbacks, SettingsConfig } from "../src/modes/interactive/components/settings-selector-types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { buildInteractiveEngineArgs } from "../src/modes/interactive-engine/engine-args.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.ts";
import { RpcClientApi } from "../src/modes/rpc/rpc-client-api.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";
import { createRpcInputLineHandler } from "../src/modes/rpc/rpc-input.ts";
import type { RpcCommandBody, RpcResponse } from "../src/modes/rpc/rpc-types.ts";
import { createHarness } from "./suite/harness.ts";

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
					description: "Turn on every debug output and write it to the debug log that /debug shows",
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
			/ATOMIC_DEBUG\s+- Turn on debug mode when set to 1 \(writes debug output to the \/debug log\)/,
		);
	});
});

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
		assert.equal(isDebugEnabled("workflow", {}), true);
		await handler({ type: "set_debug", enabled: false });
		assert.equal(isDebugEnabled("workflow", {}), false);
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
		await handleLine(JSON.stringify({ id: "text", type: "set_debug", enabled: "false" }));
		assert.deepEqual(responses, [
			{
				id: "text",
				type: "response",
				command: "set_debug",
				success: false,
				error: "Invalid debug setting: enabled is string, not a boolean (invalid-setting). Pass true or false.",
			},
		]);
		assert.equal(isDebugEnabled(undefined, {}), false);
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
			vi.spyOn(console, "log").mockImplementation(() => {});
			vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
				throw new Error(`process.exit(${code})`);
			}) as typeof process.exit);
			const version = (...flags: string[]) => main(["--no-extensions", ...flags, "--version"]);
			await assert.rejects(version(), /process\.exit\(0\)/);
			assert.equal(process.env.ATOMIC_DEBUG, undefined);
			assert.equal(isDebugEnabled(), false);
			await assert.rejects(version("--debug"), /process\.exit\(0\)/);
			assert.equal(process.env.ATOMIC_DEBUG, "1", "child processes inherit --debug");
			vi.stubEnv("ATOMIC_DEBUG", undefined);
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ debug: true }));
			await assert.rejects(version(), /process\.exit\(0\)/);
			assert.equal(isDebugEnabled(undefined, {}), true, "the saved setting");
			assert.equal(process.env.ATOMIC_DEBUG, undefined);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("/debug (#4360)", () => {
	it("appends its snapshot to the debug log, keeping what debug mode wrote before it", () => {
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
			Reflect.apply(InteractiveMode.prototype.handleDebugCommand, host, []);
			const written = readFileSync(path, "utf8");
			assert.equal(written.startsWith(`${earlier}Debug output at `), true, written.slice(0, 200));
			assert.match(written, /"rendered line"/);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

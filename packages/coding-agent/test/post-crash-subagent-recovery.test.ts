import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { createUnstartedAgentSessionFromServices } from "../src/core/agent-session-services.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRuntime } from "../src/core/model-runtime.js";
import { SessionManager } from "../src/core/session-manager.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { IsolatedInteractiveRuntime } from "../src/modes/interactive-engine/isolated-runtime.js";
import { rpcTransportError } from "../src/modes/rpc/rpc-transport-error.ts";
import {
	readInteractiveEngineBootstrap,
	writeInteractiveEngineBootstrap,
} from "../src/utils/interactive-engine-bootstrap.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("post-crash subagent recovery (PR A)", () => {
	test("startPendingRecoveryRestore runs session_recovery_restore with engineRestart:true, skips replay/turns, and shares a single restore barrier with startPendingRecovery", async () => {
		const seen: Array<{ type: string; reason: string; engineRestart?: boolean }> = [];
		const h = await createHarness({
			extensionFactories: [
				(atomic) => {
					atomic.on("session_recovery_restore", (event) => {
						seen.push({
							type: event.type,
							reason: event.reason,
							...(event.engineRestart === true ? { engineRestart: true } : {}),
						});
						return { notices: ["Subagent worker could not be restored and is gone."] };
					});
					atomic.on("session_recovery_replay", (event) => {
						seen.push({ type: event.type, reason: event.reason });
						return undefined;
					});
				},
			],
		});
		harnesses.push(h);
		// Seed a pending protected streaming delivery so full recovery would emit session_recovery_replay.
		await h.sessionManager.appendCustomMessageEntry(
			"intercom_message",
			"interrupted message",
			true,
			{ from: { name: "peer" } },
			{ delivery: { kind: "streaming", stageAdmissionKey: "intercom:1" } } as never,
		);

		const restoreOnly = await h.session.startPendingRecoveryRestore("resume");

		assert.deepEqual(seen, [{ type: "session_recovery_restore", reason: "resume", engineRestart: true }]);
		assert.equal(restoreOnly.replayed, 0, "post-crash restore never replays interrupted deliveries");
		assert.deepEqual(restoreOnly.notices, ["Subagent worker could not be restored and is gone."]);
		assert.equal(h.faux.state.callCount, 0, "post-crash restore never starts a model turn");

		// A subsequent startPendingRecovery("startup") on the SAME session (crash during deferred startup)
		// must NOT run session_recovery_restore a second time or post duplicate restore notices.
		await h.session.startPendingRecovery("startup");
		assert.equal(
			seen.filter((event) => event.type === "session_recovery_restore").length,
			1,
			"restore phase ran once across both calls",
		);
		const noticeEntries = h.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "session-recovery-notice");
		assert.equal(noticeEntries.length, 1, "restore notice posted once, not duplicated");
	});

	test("InteractiveEngineBootstrap round-trips restarted:true for replacement engines and omits it on initial start", () => {
		const initial = writeInteractiveEngineBootstrap({ hostPid: process.pid, guardFile: "/tmp/guard" });
		cleanups.push(() => rmSync(initial.directory, { recursive: true, force: true }));
		const initialRead = readInteractiveEngineBootstrap(initial.path);
		assert.equal(initialRead?.restarted, undefined);

		const replaced = writeInteractiveEngineBootstrap({
			hostPid: process.pid,
			guardFile: "/tmp/guard",
			restarted: true,
		});
		cleanups.push(() => rmSync(replaced.directory, { recursive: true, force: true }));
		const replacedRead = readInteractiveEngineBootstrap(replaced.path);
		assert.equal(replacedRead?.restarted, true);
	});

	test("IsolatedInteractiveRuntime.startPendingRecoveryRestore degrades silently on older engines without the RPC and on transport loss", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "post-crash-runtime-"));
		const agentDir = mkdtempSync(join(tmpdir(), "post-crash-agent-"));
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		const createRuntime: CreateAgentSessionRuntimeFactory = async (opts) => {
			const services = await createAgentSessionServices({
				cwd: opts.cwd,
				agentDir: opts.agentDir,
				modelRuntime,
				resourceLoaderOptions: {
					cwd: opts.cwd,
					agentDir: opts.agentDir,
					builtinPackagePaths: [],
					extensionFactories: [],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const created = await createUnstartedAgentSessionFromServices({
				services,
				sessionManager: opts.sessionManager,
				model,
				builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
		const local = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const calls: string[] = [];
		let mode: "unknown" | "transport" = "unknown";
		const fakeClient = {
			onEvent: () => () => {},
			onQueuedDeliveryChange: () => () => {},
			onExtensionUIRequest: () => () => {},
			onGenerationEnded: () => () => {},
			onInteractiveEngineMessage: () => () => {},
			onInteractiveEngineKeybindingState: () => () => {},
			getGeneration: () => 2,
			getEnginePid: () => 12345,
			getReadyEngineChildPid: () => 12345,
			stop: async () => {},
			requestInternal: async (cmd: { type: string }) => {
				calls.push(cmd.type);
				if (mode === "unknown") throw new Error("Unknown command: start_pending_recovery_restore");
				throw rpcTransportError("Agent process stopped");
			},
		};
		const runtime = new IsolatedInteractiveRuntime(local, createRuntime, fakeClient as never);
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		});

		const oldEngineReport = await runtime.startPendingRecoveryRestore("resume");
		assert.deepEqual(calls, ["start_pending_recovery_restore"]);
		assert.deepEqual(oldEngineReport, { replayed: 0, dropped: 0, completions: 0, notices: [] });

		mode = "transport";
		const secondCrashReport = await runtime.startPendingRecoveryRestore("resume");
		assert.deepEqual(secondCrashReport, { replayed: 0, dropped: 0, completions: 0, notices: [] });
	});

	test("InteractiveMode runs restore-only recovery on onEngineRecovered(true), skips on replaced=false or shutdown, and does nothing on in-process host", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "post-crash-mode-"));
		const agentDir = mkdtempSync(join(tmpdir(), "post-crash-mode-agent-"));
		const faux = registerFauxProvider();
		const model = faux.getModel();
		const authStorage = AuthStorage.inMemory({ [model.provider]: { type: "api_key", key: "faux-key" } });
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		const createRuntime: CreateAgentSessionRuntimeFactory = async (opts) => {
			const services = await createAgentSessionServices({
				cwd: opts.cwd,
				agentDir: opts.agentDir,
				modelRuntime,
				resourceLoaderOptions: {
					cwd: opts.cwd,
					agentDir: opts.agentDir,
					builtinPackagePaths: [],
					extensionFactories: [],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			const created = await createUnstartedAgentSessionFromServices({
				services,
				sessionManager: opts.sessionManager,
				model,
				builtins: { subagents: false, mcp: false, "web-access": false, intercom: false },
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
		const local = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const calls: string[] = [];
		const fakeClient = {
			onEvent: () => () => {},
			onQueuedDeliveryChange: () => () => {},
			onExtensionUIRequest: () => () => {},
			onGenerationEnded: () => () => {},
			onInteractiveEngineMessage: () => () => {},
			onInteractiveEngineKeybindingState: () => () => {},
			getGeneration: () => 2,
			getEnginePid: () => 12345,
			getReadyEngineChildPid: () => 12345,
			stop: async () => {},
			requestInternal: async (cmd: { type: string }) => {
				calls.push(cmd.type);
				return { replayed: 0, dropped: 0, completions: 0, notices: [] };
			},
		};
		const runtime = new IsolatedInteractiveRuntime(local, createRuntime, fakeClient as never);
		const terminal = {
			columns: 80,
			rows: 24,
			kittyProtocolActive: true,
			start() {},
			stop() {},
			async drainInput() {},
			write() {},
			moveBy() {},
			hideCursor() {},
			showCursor() {},
			clearLine() {},
			clearFromCursor() {},
			clearScreen() {},
			setTitle() {},
			setProgress() {},
			setProgramStatus() {},
		};
		const interactiveMode = new InteractiveMode(runtime, { terminal });
		cleanups.push(async () => {
			interactiveMode.stop();
			await runtime.dispose();
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
			rmSync(agentDir, { recursive: true, force: true });
		});

		const publishRecovery = (runtime as unknown as { publishRecovery(replaced: boolean): void }).publishRecovery.bind(
			runtime,
		);
		publishRecovery(false);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, [], "replaced=false never triggers post-crash restore");

		publishRecovery(true);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, ["start_pending_recovery_restore"]);

		interactiveMode.isShuttingDown = true;
		publishRecovery(true);
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(calls, ["start_pending_recovery_restore"], "shutdown never triggers post-crash restore");
	});
});

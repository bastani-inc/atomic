import { basename } from "node:path";
import type { Args } from "../../cli/args.ts";
import { ENV_AGENT_DIR, getEnvValue } from "../../config.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../../core/agent-session-runtime.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { canIsolateSessionStore } from "../../core/session-storage.js";
import { startupBenchmarkEngineEnv } from "../../main-startup-benchmark.js";
import { RpcClient } from "../rpc/rpc-client.ts";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import { buildInteractiveEngineArgs, type InteractiveEngineResourcePaths } from "./engine-args.ts";
import { engineHeapRuntimeArgsForHost } from "./engine-heap.ts";
import { IsolatedInteractiveRuntime } from "./isolated-runtime.js";

export async function createIsolatedInteractiveRuntime(options: {
	localRuntime: AgentSessionRuntime;
	createRuntime: CreateAgentSessionRuntimeFactory;
	parsed: Args;
	sessionManager: SessionManager;
	resources: InteractiveEngineResourcePaths;
}): Promise<IsolatedInteractiveRuntime> {
	const executableName = basename(process.execPath).toLowerCase();
	const launchedByRuntime = ["bun", "bun.exe", "node", "node.exe"].includes(executableName);
	const cliPath = launchedByRuntime ? process.argv[1] : "";
	if (launchedByRuntime && !cliPath)
		throw new Error("Cannot start isolated interactive engine: Atomic entrypoint is unavailable");
	let isolatedRuntime: IsolatedInteractiveRuntime | undefined;
	const pendingDiagnostics: ActivityWatchdogDiagnostic[] = [];
	let callbackActive = false;
	const explicitAgentDir = getEnvValue(ENV_AGENT_DIR);
	const client = new RpcClient({
		cliPath,
		cwd: options.sessionManager.getCwd(),
		runtimeExecutable: process.execPath,
		runtimeArgs: engineHeapRuntimeArgsForHost(["node", "node.exe"].includes(executableName)),
		args: buildInteractiveEngineArgs(options.parsed, options.sessionManager, options.resources),
		env: {
			...(explicitAgentDir !== undefined ? { [ENV_AGENT_DIR]: explicitAgentDir } : {}),
			...startupBenchmarkEngineEnv(),
		},
		interactiveEngine: {
			onDiagnostic: (diagnostic) =>
				isolatedRuntime ? isolatedRuntime.emitDiagnostic(diagnostic) : pendingDiagnostics.push(diagnostic),
			onActivityChange: (active) => {
				callbackActive = active;
				isolatedRuntime?.setEngineCallbackActive(active);
			},
			onHeartbeat: () => isolatedRuntime?.noteEngineHeartbeat(),
			// Handed to the child through the protected bootstrap file so it never
			// enters an environment the child's own subprocesses can inherit.
			...(options.parsed.apiKey ? { apiKey: options.parsed.apiKey } : {}),
		},
	});
	// The host paints and takes input while the engine child loads: its readiness gates only what needs the engine.
	isolatedRuntime = new IsolatedInteractiveRuntime(
		options.localRuntime,
		options.createRuntime,
		client,
		client.start(),
	);
	isolatedRuntime.setEngineCallbackActive(callbackActive);
	for (const diagnostic of pendingDiagnostics) isolatedRuntime.emitDiagnostic(diagnostic);
	return isolatedRuntime;
}

export async function createRuntimeForMode(
	createRuntime: CreateAgentSessionRuntimeFactory,
	cwd: string,
	agentDir: string,
	sessionManager: SessionManager,
	isolateInteractiveHost: boolean,
	hasInlineExtensionFactories: boolean,
	parsed: Args,
	resources: InteractiveEngineResourcePaths,
	interactive: boolean,
): Promise<AgentSessionRuntime> {
	isolateInteractiveHost &&= canIsolateSessionStore(sessionManager.getSessionStore());
	if (isolateInteractiveHost && hasInlineExtensionFactories) {
		throw new Error(
			"Interactive engine isolation cannot serialize inline extension factories; load the extension from a module path instead.",
		);
	}
	const localRuntime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager, interactive });
	if (!isolateInteractiveHost) return localRuntime;
	return createIsolatedInteractiveRuntime({ localRuntime, createRuntime, parsed, sessionManager, resources });
}

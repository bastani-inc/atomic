import { basename } from "node:path";
import type { Args } from "../../cli/args.ts";
import {
	createAgentSessionRuntime,
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
} from "../../core/agent-session-runtime.ts";
import type { SessionManager } from "../../core/session-manager.ts";
import { RpcClient } from "../rpc/rpc-client.ts";
import { buildInteractiveEngineArgs, type InteractiveEngineResourcePaths } from "./engine-args.ts";
import type { ActivityWatchdogDiagnostic } from "./activity-watchdog.ts";
import { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";

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
	if (launchedByRuntime && !cliPath) throw new Error("Cannot start isolated interactive engine: Atomic entrypoint is unavailable");
	let isolatedRuntime: IsolatedInteractiveRuntime | undefined;
	const pendingDiagnostics: ActivityWatchdogDiagnostic[] = [];
	let callbackActive = false;
	const client = new RpcClient({
		cliPath,
		cwd: options.sessionManager.getCwd(),
		runtimeExecutable: process.execPath,
		args: buildInteractiveEngineArgs(options.parsed, options.sessionManager, options.resources),
		env: {
			ATOMIC_CODING_AGENT_DIR: options.localRuntime.services.agentDir,
			...(options.parsed.apiKey ? { ATOMIC_INTERACTIVE_ENGINE_API_KEY: options.parsed.apiKey } : {}),
		},
		interactiveEngine: {
			onDiagnostic: (diagnostic) => isolatedRuntime
				? isolatedRuntime.emitDiagnostic(diagnostic)
				: pendingDiagnostics.push(diagnostic),
			onActivityChange: (active) => {
				callbackActive = active;
				isolatedRuntime?.setEngineCallbackActive(active);
			},
		},
	});
	try {
		await client.start();
	} catch (error) {
		await client.stop();
		throw error;
	}
	isolatedRuntime = new IsolatedInteractiveRuntime(options.localRuntime, options.createRuntime, client);
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
): Promise<AgentSessionRuntime> {
	if (isolateInteractiveHost && hasInlineExtensionFactories) {
		throw new Error("Interactive engine isolation cannot serialize inline extension factories; load the extension from a module path instead.");
	}
	const localRuntime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager });
	if (!isolateInteractiveHost) return localRuntime;
	return createIsolatedInteractiveRuntime({ localRuntime, createRuntime, parsed, sessionManager, resources });
}

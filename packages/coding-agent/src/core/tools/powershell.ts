import { APP_NAME } from "../../config.js";
import { waitForChildProcess } from "../../utils/child-process.ts";
import {
	getPowerShellConfig,
	killProcessTree,
	trackDetachedChildPid,
	untrackDetachedChildPid,
} from "../../utils/shell.ts";
import {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashToolDefinition,
	type ShellToolPresentation,
} from "./bash.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const POWERSHELL_PRESENTATION: ShellToolPresentation = {
	prompt: "PS>",
	tempFilePrefix: `${APP_NAME}-powershell`,
};

const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
export const powershellToolSystemPromptContribution = Object.freeze({
	snippet: "Execute PowerShell commands.",
	guidelines: Object.freeze([
		"You can inspect ATOMIC_* or PI_* environment variables for current model and session details.",
	] as const),
} as const);
export type PowerShellOperations = BashOperations;
export type PowerShellToolDetails = BashToolDetails;
export type PowerShellToolInput = BashToolInput;
export interface PowerShellToolOptions extends Pick<BashToolOptions, "exposeSessionEnvironment" | "spawnHook"> {
	operations?: BashOperations;
}
export function createLocalPowerShellOperations(): PowerShellOperations {
	return {
		exec: async (command, cwd, options) => {
			const { shell, args } = getPowerShellConfig();
			const { spawn } = await import("node:child_process");
			if (options.signal?.aborted) throw new Error("aborted");
			const child = spawn(shell, [...args, `${UTF8_OUTPUT_PREFIX}${command}`], {
				cwd,
				env: options.env,
				windowsHide: true,
			});
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};
			try {
				if (options.timeout !== undefined && options.timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, options.timeout * 1000);
				}
				child.stdout?.on("data", (data: Buffer) => options.onData(data, "stdout"));
				child.stderr?.on("data", (data: Buffer) => options.onData(data, "stderr"));
				if (options.signal) {
					if (options.signal.aborted) onAbort();
					else options.signal.addEventListener("abort", onAbort, { once: true });
				}
				const exitCode = await waitForChildProcess(child);
				if (options.signal?.aborted) throw new Error("aborted");
				if (timedOut) throw new Error(`timeout:${options.timeout}`);
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				options.signal?.removeEventListener("abort", onAbort);
			}
		},
	};
}
export function createPowerShellToolDefinition(cwd: string, options: PowerShellToolOptions = {}) {
	const definition = createBashToolDefinition(
		cwd,
		{
			...options,
			operations: options.operations ?? createLocalPowerShellOperations(),
		},
		POWERSHELL_PRESENTATION,
	);
	return {
		...definition,
		name: "powershell",
		label: "powershell",
		description: "Execute a PowerShell command in the session workspace.",
		promptSnippet: powershellToolSystemPromptContribution.snippet,
		promptGuidelines:
			options.exposeSessionEnvironment === false
				? undefined
				: [...powershellToolSystemPromptContribution.guidelines],
	};
}
export function createPowerShellTool(cwd: string, options?: PowerShellToolOptions) {
	return wrapToolDefinition(createPowerShellToolDefinition(cwd, options));
}
export type PowerShellSpawnContext = BashSpawnContext;
export type PowerShellSpawnHook = BashSpawnHook;

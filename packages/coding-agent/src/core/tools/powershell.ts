import { APP_NAME } from "../../config.js";
import { createChildProcessEnvironment, waitForChildProcess } from "../../utils/child-process.ts";
import {
	getPowerShellConfig,
	getShellEnv,
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
	bashToolSystemPromptContribution,
	createBashToolDefinition,
	type ShellToolPresentation,
	validateExplicitTimeoutSeconds,
} from "./bash.js";
import {
	executeNativePty,
	executeSupervisedCommand,
	type SupervisedCommandOwner,
	validateBashWait,
} from "./bash-pty-native.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const POWERSHELL_PRESENTATION: ShellToolPresentation = {
	prompt: "PS>",
	tempFilePrefix: `${APP_NAME}-powershell`,
};

const UTF8_OUTPUT_PREFIX = "try { [Console]::OutputEncoding=[System.Text.Encoding]::UTF8 } catch {}\n";
export const powershellToolSystemPromptContribution = Object.freeze({
	snippet: "Execute PowerShell commands.",
	guidelines: bashToolSystemPromptContribution.guidelines,
} as const);
export type PowerShellOperations = BashOperations;
export type PowerShellToolDetails = BashToolDetails;
export type PowerShellToolInput = BashToolInput;
export interface PowerShellToolOptions
	extends Pick<BashToolOptions, "exposeSessionEnvironment" | "spawnHook" | "taskOwner"> {
	operations?: BashOperations;
}
export function createLocalPowerShellOperations(binding?: {
	taskOwner?: SupervisedCommandOwner;
}): PowerShellOperations {
	return {
		exec: async (command, cwd, options) => {
			validateBashWait(options.wait, !!binding?.taskOwner);
			if (options.timeout !== undefined) validateExplicitTimeoutSeconds(options.timeout);
			if (options.signal?.aborted) throw new Error("aborted");
			const { shell, args } = getPowerShellConfig();
			const pty = !!options.pty && process.env.PI_NO_PTY !== "1" && process.env.ATOMIC_NO_PTY !== "1";
			if (binding?.taskOwner || pty) {
				// EncodedCommand avoids native argument parsing differences between PowerShell 5 and 7.
				const encoded = Buffer.from(`${UTF8_OUTPUT_PREFIX}${command}`, "utf16le").toString("base64");
				const execution = {
					...options,
					shellConfig: { shell, args: [...args.slice(0, -1), "-EncodedCommand"] },
					commandDescription: command,
					taskOwner: binding?.taskOwner,
				};
				return binding?.taskOwner
					? executeSupervisedCommand(encoded, cwd, execution, pty)
					: executeNativePty(encoded, cwd, execution);
			}
			const { spawn } = await import("node:child_process");
			if (options.signal?.aborted) throw new Error("aborted");
			const child = spawn(shell, [...args, `${UTF8_OUTPUT_PREFIX}${command}`], {
				cwd,
				env: createChildProcessEnvironment(undefined, options.env ?? getShellEnv()),
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
			exposeSessionEnvironment: options.exposeSessionEnvironment,
			spawnHook: options.spawnHook,
			// Preserve lazy session ownership instead of reading an accessor at registration.
			get taskOwner() {
				return options.taskOwner;
			},
			shellDialect: "powershell",
			operations: options.operations ?? createLocalPowerShellOperations({ taskOwner: options.taskOwner }),
		},
		POWERSHELL_PRESENTATION,
	);
	return {
		...definition,
		name: "powershell",
		label: "powershell",
		async execute(...args: Parameters<typeof definition.execute>) {
			// The internal local adapter is not evidence of a supported owner.
			if (args[1].action === undefined) validateBashWait(args[1].wait, !!options.operations || !!options.taskOwner);
			return definition.execute(...args);
		},
		description:
			'Execute a PowerShell command or observe an existing task with action: "wait", id, and optional budgetMs. Owner-bound commands automatically yield after 10s by default without stopping execution. Unbound commands wait for completion; background and existing-task waits require a task owner.',
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

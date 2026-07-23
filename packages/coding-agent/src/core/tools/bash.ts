import { constants } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { access as fsAccess, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import { type Static, Type } from "typebox";
import { APP_NAME } from "../../config.ts";
import { parenthesizedKeyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { truncateToVisualLines } from "../../modes/interactive/components/visual-truncate.ts";
import { theme } from "../../modes/interactive/theme/theme.ts";
import { waitForChildProcess } from "../../utils/child-process.ts";
import { getShellConfig, getShellEnv, killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../../utils/shell.ts";
import type { AsyncJobManager } from "../async/job-manager.js";
import type { AsyncJobDeliveryMessage } from "../async/types.js";
import type { BashResult } from "../bash-executor.ts";
import type { ToolDefinition, ToolRenderResultOptions } from "../extensions/types.ts";
import { startAsyncBashCommand } from "./bash-async-execution.js";
import { abortManagedBashJob, getManagedBashJob } from "./bash-async-jobs.ts";
import { stripLeadingCdCommand } from "./bash-leading-cd.ts";
import { executeNativePty } from "./bash-pty-native.ts";
import { checkBashInterceptionCandidates, DEFAULT_BASH_INTERCEPTOR_RULES, type BashInterceptorRule } from "./bash-interceptor.ts";
import { OutputAccumulator } from "./output-accumulator.ts";
import { expandShellInternalUrls, type InternalResourceContext } from "./resource-selectors.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { invalidateNativeSearchCache } from "./search-native.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "./truncate.ts";
const envSchema = Type.Unsafe<Record<string, string>>({ type: "object", description: "Environment variables to add or override.", additionalProperties: { type: "string" }, propertyNames: { pattern: "^[A-Za-z_][A-Za-z0-9_]*$" } });
const bashBaseSchema = Type.Object({ command: Type.String({ description: "Shell command to execute." }), env: Type.Optional(envSchema), timeout: Type.Optional(Type.Number({ description: "Timeout in seconds." })), cwd: Type.Optional(Type.String({ description: "Working directory for the command." })), pty: Type.Optional(Type.Boolean({ description: "Run with PTY handling." })) }, { additionalProperties: false });
const bashSchema = Type.Object({ ...bashBaseSchema.properties, async: Type.Optional(Type.Boolean({ description: "Run as a background job." })) }, { additionalProperties: false });
export type BashToolInput = Static<typeof bashSchema>;
export interface BashToolDetails { truncation?: TruncationResult; fullOutputPath?: string; exitCode?: number | null; async?: { jobId: string; type: "bash"; state: "running" | "completed" | "failed"; command?: string; status?: "running" | "completed" | "failed" }; timeoutSeconds?: number; requestedTimeoutSeconds?: number; wallTimeMs?: number }
const DEFAULT_TIMEOUT_SECONDS = 300, MAX_TIMEOUT_SECONDS = 3600;
function validateExplicitTimeoutSeconds(timeout: number): void { if (!Number.isFinite(timeout) || timeout <= 0 || timeout > MAX_TIMEOUT_SECONDS) throw new Error(`Invalid timeout ${String(timeout)}: timeout must be a finite number greater than 0 and no more than ${MAX_TIMEOUT_SECONDS} seconds`); }
function normalizeTimeoutSeconds(timeout: number | undefined): number {
	if (timeout === undefined) return DEFAULT_TIMEOUT_SECONDS;
	validateExplicitTimeoutSeconds(timeout); return Math.max(1, Math.floor(timeout));
}

export interface BashOperations {
	exec: (
		command: string,
		cwd: string,
		options: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
			env?: NodeJS.ProcessEnv;
			pty?: boolean;
		},
	) => Promise<{ exitCode: number | null }>;
}
export function createLocalBashOperations(options?: { shellPath?: string }): BashOperations {
	return {
		exec: async (command, cwd, { onData, signal, timeout, env, pty }) => {
			if (timeout !== undefined) validateExplicitTimeoutSeconds(timeout);

			if (pty && process.env.PI_NO_PTY !== "1" && process.env.ATOMIC_NO_PTY !== "1") {
				try { return await executeNativePty(command, cwd, { onData, signal, timeout, env, shellPath: options?.shellPath }); }
				catch (error) { const message = String(error instanceof Error ? error.message : error); if (!message.includes("Native PTY") && !message.includes("PtySession")) throw error; }
			}
			const shellConfig = getShellConfig(options?.shellPath);
			try { const cwdStat = await fsStat(cwd); if (!cwdStat.isDirectory()) throw new Error(`Working directory is not a directory: ${cwd}`); await fsAccess(cwd, constants.F_OK); } catch (error) {
				if (error instanceof Error && error.message.startsWith("Working directory is not a directory")) throw error;
				throw new Error(`Working directory does not exist: ${cwd}\nCannot execute bash commands.`);
			}
			if (signal?.aborted) throw new Error("aborted");
			const commandFromStdin = shellConfig.commandTransport === "stdin";
			const child = spawn(shellConfig.shell, commandFromStdin ? shellConfig.args : [...shellConfig.args, command], {
				cwd,
				detached: process.platform !== "win32",
				env: env ?? getShellEnv(),
				stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
				windowsHide: true,
			});
			if (commandFromStdin) {
				child.stdin?.on("error", () => {});
				child.stdin?.end(command);
			}
			if (child.pid) trackDetachedChildPid(child.pid);
			let timedOut = false;
			let timeoutHandle: NodeJS.Timeout | undefined;
			const onAbort = () => {
				if (child.pid) killProcessTree(child.pid);
			};
			try {
				if (timeout !== undefined && timeout > 0) {
					timeoutHandle = setTimeout(() => {
						timedOut = true;
						if (child.pid) killProcessTree(child.pid);
					}, timeout * 1000);
				}
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				if (signal) {
					if (signal.aborted) onAbort();
					else signal.addEventListener("abort", onAbort, { once: true });
				}
				const exitCode = await waitForChildProcess(child);
				if (signal?.aborted) throw new Error("aborted");
				if (timedOut) {
					throw new Error(`timeout:${timeout}`);
				}
				return { exitCode };
			} finally {
				if (child.pid) untrackDetachedChildPid(child.pid);
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (signal) signal.removeEventListener("abort", onAbort);
			}
		},
	};
}
export interface BashSpawnContext {
	command: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
}
export type BashSpawnHook = (context: BashSpawnContext) => BashSpawnContext;
function resolveSpawnContext(command: string, cwd: string, spawnHook?: BashSpawnHook): BashSpawnContext {
	const baseContext: BashSpawnContext = { command, cwd, env: { ...getShellEnv() } };
	return spawnHook ? spawnHook(baseContext) : baseContext;
}
export interface BashInterceptorResult {
	operations?: BashOperations;
	result?: BashResult;
}
export type BashInterceptor = (context: BashSpawnContext) => Promise<BashInterceptorResult | undefined> | BashInterceptorResult | undefined;
export interface BashToolOptions {
	operations?: BashOperations;
	/** Prefix prepended to every shell command before execution. */
	commandPrefix?: string;
	/** Override shell executable resolution for local bash operations. */
	shellPath?: string;
	/** Last-mile hook for rewriting the command/cwd/env spawn context. */
	spawnHook?: BashSpawnHook;
	/** Optional command interceptor used by extensions and parity tests. */
	interceptor?: BashInterceptor;
	interceptorEnabled?: boolean | (() => boolean);
	availableTools?: string[];
	interceptorRules?: BashInterceptorRule[];
	/** Enable background bash jobs and session-managed async result delivery. */
	asyncEnabled?: boolean;
	asyncJobManager?: AsyncJobManager;
	asyncJobDeliveryHandler?: (message: AsyncJobDeliveryMessage) => void | Promise<void>;
	asyncJobSessionId?: symbol;
}
const BASH_PREVIEW_LINES = 5, BASH_UPDATE_THROTTLE_MS = 100;
function bashResultToToolResult(result: BashResult): { content: Array<{ type: "text"; text: string }>; details: BashToolDetails | undefined } {
	const details: BashToolDetails | undefined = result.truncated ? { fullOutputPath: result.fullOutputPath } : undefined;
	const status = result.cancelled ? "Command aborted" : result.exitCode && result.exitCode !== 0 ? `Command exited with code ${result.exitCode}` : undefined;
	const text = `${result.output || "(no output)"}${status ? `\n\n${status}` : ""}`;
	return { content: [{ type: "text", text }], details };
}
type BashRenderState = {
	startedAt: number | undefined;
	endedAt: number | undefined;
	interval: NodeJS.Timeout | undefined;
};
type BashResultRenderState = {
	cachedWidth: number | undefined;
	cachedLines: string[] | undefined;
	cachedSkipped: number | undefined;
};
class BashResultRenderComponent extends Container {
	state: BashResultRenderState = {
		cachedWidth: undefined,
		cachedLines: undefined,
		cachedSkipped: undefined,
	};
}
function formatDuration(ms: number): string {
	const totalSeconds = Math.floor(Math.max(0, ms) / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
	if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	return `${seconds}s`;
}
function formatBashCall(args: { command?: string; timeout?: number } | undefined): string {
	const command = str(args?.command);
	const timeout = args?.timeout as number | undefined;
	const timeoutSuffix = timeout ? theme.fg("muted", ` (timeout ${timeout}s)`) : "";
	const commandDisplay = command === null ? invalidArgText(theme) : command ? command : theme.fg("toolOutput", "...");
	return theme.fg("toolTitle", theme.bold(`$ ${commandDisplay}`)) + timeoutSuffix;
}
function rebuildBashResultRenderComponent(
	component: BashResultRenderComponent,
	result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: BashToolDetails;
	},
	options: ToolRenderResultOptions,
	showImages: boolean,
	startedAt: number | undefined,
	endedAt: number | undefined,
): void {
	const state = component.state;
	component.clear();
	let output = getTextOutput(result, showImages).trim();
	const truncation = result.details?.truncation;
	const fullOutputPath = result.details?.fullOutputPath;
	if (!options.isPartial && truncation?.truncated && fullOutputPath && output.endsWith("]")) {
		const footerStart = output.lastIndexOf("\n\n[");
		if (footerStart !== -1 && output.slice(footerStart).includes(fullOutputPath)) {
			output = output.slice(0, footerStart).trimEnd();
		}
	}
	if (output) {
		const styledOutput = output
			.split("\n")
			.map((line) => theme.fg("toolOutput", line))
			.join("\n");
		if (options.expanded) {
			component.addChild(new Text(`\n${styledOutput}`, 0, 0));
		} else {
			component.addChild({
				render: (width: number) => {
					if (state.cachedLines === undefined || state.cachedWidth !== width) {
						const preview = truncateToVisualLines(styledOutput, BASH_PREVIEW_LINES, width);
						state.cachedLines = preview.visualLines;
						state.cachedSkipped = preview.skippedCount;
						state.cachedWidth = width;
					}
					if (state.cachedSkipped && state.cachedSkipped > 0) {
						const hint = theme.fg("muted", "... ") + parenthesizedKeyHint("app.tools.expand", "Expand", `${state.cachedSkipped} earlier lines`);
						return ["", truncateToWidth(hint, width, "..."), ...(state.cachedLines ?? [])];
					}
					return ["", ...(state.cachedLines ?? [])];
				},
				invalidate: () => {
					state.cachedWidth = undefined;
					state.cachedLines = undefined;
					state.cachedSkipped = undefined;
				},
			});
		}
	}
	if (truncation?.truncated || fullOutputPath) {
		const warnings: string[] = [];
		if (fullOutputPath) {
			warnings.push(`Full output: ${fullOutputPath}`);
		}
		if (truncation?.truncated) {
			if (truncation.truncatedBy === "lines") {
				warnings.push(`Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines`);
			} else {
				warnings.push(
					`Truncated: ${truncation.outputLines} lines shown (${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit)`,
				);
			}
		}
		component.addChild(new Text(`\n${theme.fg("warning", `[${warnings.join(". ")}]`)}`, 0, 0));
	}
	if (startedAt !== undefined) {
		const label = options.isPartial ? "Elapsed" : "Took";
		const endTime = endedAt ?? Date.now();
		component.addChild(new Text(`\n${theme.fg("muted", `${label} ${formatDuration(endTime - startedAt)}`)}`, 0, 0));
	}
}
export function createBashToolDefinition(
	cwd: string,
	options?: BashToolOptions,
): ToolDefinition<typeof bashSchema, BashToolDetails | undefined, BashRenderState> {
	const defaultOps = options?.operations ?? createLocalBashOperations({ shellPath: options?.shellPath });
	const commandPrefix = options?.commandPrefix;
	const spawnHook = options?.spawnHook;
	const interceptor = options?.interceptor;
	const isInterceptorEnabled = (): boolean => typeof options?.interceptorEnabled === "function" ? options.interceptorEnabled() : options?.interceptorEnabled ?? !!interceptor;
	const availableTools = options?.availableTools ?? ["read", "search", "find", "edit", "write"];
	const interceptorRules = options?.interceptorRules ?? DEFAULT_BASH_INTERCEPTOR_RULES;
	const asyncEnabled = options?.asyncEnabled ?? false;
	const asyncJobManager = options?.asyncJobManager, asyncJobDeliveryHandler = options?.asyncJobDeliveryHandler, asyncJobSessionId = options?.asyncJobSessionId;
	return {
		name: "bash",
		label: "bash",
		description: "Execute a shell command in the session workspace, with optional PTY or background-job handling.",
		promptSnippet: "Execute a shell command.",
		parameters: asyncEnabled ? bashSchema : bashBaseSchema as typeof bashSchema,
		maxResultSizeChars: Infinity,
		async execute(
			_toolCallId,
			bashCommand: BashToolInput,
			signal?: AbortSignal,
			onUpdate?,
			_ctx?,
		) {
			const { command } = bashCommand;
			const jobStatusMatch = command.match(/^__atomic_bash_job\s+(\S+)$/);
			if (jobStatusMatch) {
				const job = getManagedBashJob(jobStatusMatch[1]!);
				if (!job) throw new Error(`Unknown bash async job: ${jobStatusMatch[1]}`);
				if (job.status !== "running") asyncJobManager?.acknowledgeDeliveries([job.jobId]);
				const text = [`Job ${job.jobId}: ${job.status}`, `Command: ${job.command}`, job.error ? `Error: ${job.error}` : undefined, job.output].filter(Boolean).join("\n");
				return { content: [{ type: "text", text }], details: { async: { jobId: job.jobId, type: "bash", state: job.status, command: job.command, status: job.status }, exitCode: job.exitCode, timeoutSeconds: job.timeoutSeconds, ...(job.requestedTimeoutSeconds !== undefined ? { requestedTimeoutSeconds: job.requestedTimeoutSeconds } : {}), ...(job.fullOutputPath ? { fullOutputPath: job.fullOutputPath } : {}), wallTimeMs: (job.endedAt ?? Date.now()) - job.startedAt } };
			}
			const jobCancelMatch = command.match(/^__atomic_bash_job_cancel\s+(\S+)$/);
			if (jobCancelMatch) {
				const job = abortManagedBashJob(jobCancelMatch[1]!);
				if (!job) throw new Error(`Unknown bash async job: ${jobCancelMatch[1]}`);
				asyncJobManager?.acknowledgeDeliveries([job.jobId]);
				return { content: [{ type: "text", text: `Cancellation requested for bash job ${job.jobId}` }], details: { async: { jobId: job.jobId, type: "bash", state: job.status, command: job.command, status: job.status } } };
			}
			const timeout = normalizeTimeoutSeconds(bashCommand.timeout);
			const resourceCtx = _ctx as InternalResourceContext | undefined;
			const hasExplicitCwd = typeof bashCommand.cwd === "string";
			const rawStrippedContext = hasExplicitCwd ? undefined : stripLeadingCdCommand(command, cwd);
			const interceptorEnabled = isInterceptorEnabled();
			if (interceptorEnabled) checkBashInterceptionCandidates([command, rawStrippedContext?.command], availableTools, interceptorRules);
			const cwdInput = hasExplicitCwd ? await expandShellInternalUrls(bashCommand.cwd!, cwd, resourceCtx) : cwd, requestedCwd = resolvePath(cwd, cwdInput);
			const expandedCommand = await expandShellInternalUrls(command, cwd, resourceCtx, true);
			const strippedExpandedContext = hasExplicitCwd ? undefined : stripLeadingCdCommand(expandedCommand, requestedCwd);
			const resolvedCommand = commandPrefix ? `${commandPrefix}\n${expandedCommand}` : expandedCommand;
			const spawnContext = resolveSpawnContext(resolvedCommand, requestedCwd, spawnHook);
			const strippedCdContext = strippedExpandedContext ? resolveSpawnContext(commandPrefix ? `${commandPrefix}\n${strippedExpandedContext.command}` : strippedExpandedContext.command, strippedExpandedContext.cwd, spawnHook) : undefined;
			if (interceptorEnabled) checkBashInterceptionCandidates([expandedCommand, strippedExpandedContext?.command, resolvedCommand, spawnContext.command, strippedCdContext?.command], availableTools, interceptorRules);
			let expandedEnv: NodeJS.ProcessEnv | undefined;
			if (bashCommand.env) {
				expandedEnv = {};
				for (const [key, value] of Object.entries(bashCommand.env)) {
					if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`Invalid bash env name: ${key}`);
					expandedEnv[key] = await expandShellInternalUrls(value, cwd, resourceCtx);
				}
				spawnContext.env = { ...spawnContext.env, ...expandedEnv };
			}
			if (strippedCdContext && expandedEnv) strippedCdContext.env = { ...strippedCdContext.env, ...expandedEnv };
			const primaryInterception = interceptorEnabled && interceptor ? await interceptor(spawnContext) : undefined;
			const fallbackInterception = !primaryInterception && strippedCdContext && interceptorEnabled && interceptor ? await interceptor(strippedCdContext) : undefined;
			const intercepted = primaryInterception ?? fallbackInterception;
			if (intercepted?.result) return bashResultToToolResult(intercepted.result);
			const ops = intercepted?.operations ?? defaultOps;
			const executionContext = primaryInterception ? spawnContext : (strippedCdContext ?? spawnContext);
			if (bashCommand.async) {
				if (!asyncEnabled) throw new Error("bash async execution is disabled");
				return startAsyncBashCommand({
					command: executionContext.command,
					cwd: executionContext.cwd,
					env: executionContext.env,
					pty: bashCommand.pty,
					timeoutSeconds: timeout,
					requestedTimeoutSeconds: bashCommand.timeout !== undefined && bashCommand.timeout !== timeout ? bashCommand.timeout : undefined,
					signal,
					operations: ops,
					manager: asyncJobManager,
					deliveryHandler: asyncJobDeliveryHandler,
					sessionId: asyncJobSessionId,
				});
			}
			const output = new OutputAccumulator({ tempFilePrefix: `${APP_NAME}-bash` });
			let acceptingOutput = true;
			let updateTimer: NodeJS.Timeout | undefined;
			let updateDirty = false;
			let lastUpdateAt = 0;
			const emitOutputUpdate = () => {
				if (!onUpdate || !updateDirty) return;
				updateDirty = false;
				lastUpdateAt = Date.now();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				onUpdate({
					content: [{ type: "text", text: snapshot.content || "" }],
					details: {
						truncation: snapshot.truncation.truncated ? snapshot.truncation : undefined,
						fullOutputPath: snapshot.fullOutputPath,
					},
				});
			};
			const clearUpdateTimer = () => {
				if (updateTimer) {
					clearTimeout(updateTimer);
					updateTimer = undefined;
				}
			};
			const scheduleOutputUpdate = () => {
				if (!onUpdate) return;
				updateDirty = true;
				const delay = BASH_UPDATE_THROTTLE_MS - (Date.now() - lastUpdateAt);
				if (delay <= 0) {
					clearUpdateTimer();
					emitOutputUpdate();
					return;
				}
				updateTimer ??= setTimeout(() => {
					updateTimer = undefined;
					emitOutputUpdate();
				}, delay);
			};
			if (onUpdate) {
				onUpdate({ content: [], details: undefined });
			}
			const handleData = (data: Buffer) => {
				if (!acceptingOutput) return;
				output.append(data);
				scheduleOutputUpdate();
			};
			const finishOutput = async () => {
				acceptingOutput = false;
				output.finish();
				clearUpdateTimer();
				emitOutputUpdate();
				const snapshot = output.snapshot({ persistIfTruncated: true });
				await output.closeTempFile();
				return snapshot;
			};
			const formatOutput = (snapshot: Awaited<ReturnType<typeof finishOutput>>, emptyText = "(no output)") => {
				const truncation = snapshot.truncation;
				let text = snapshot.content || emptyText;
				let details: BashToolDetails | undefined;
				if (truncation.truncated) {
					details = { truncation, fullOutputPath: snapshot.fullOutputPath };
					const startLine = truncation.totalLines - truncation.outputLines + 1;
					const endLine = truncation.totalLines;
					if (truncation.lastLinePartial) {
						const lastLineSize = formatSize(output.getLastLineBytes());
						text += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}). Full output: ${snapshot.fullOutputPath}]`;
					} else if (truncation.truncatedBy === "lines") {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}. Full output: ${snapshot.fullOutputPath}]`;
					} else {
						text += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Full output: ${snapshot.fullOutputPath}]`;
					}
				}
				return { text, details };
			};
			const startedAt = Date.now();
			const withTiming = (details: BashToolDetails | undefined): BashToolDetails => ({ ...details, timeoutSeconds: timeout, ...(bashCommand.timeout !== undefined && bashCommand.timeout !== timeout ? { requestedTimeoutSeconds: bashCommand.timeout } : {}), wallTimeMs: Date.now() - startedAt });
			const appendStatus = (text: string, status: string) => `${text ? `${text}\n\n` : ""}${status}`;
			try {
				let exitCode: number | null;
				try {
					const result = await ops.exec(executionContext.command, executionContext.cwd, {
						onData: handleData,
						signal,
						timeout,
						env: executionContext.env,
						pty: bashCommand.pty,
					});
					exitCode = result.exitCode;
				} catch (err) {
					const snapshot = await finishOutput();
					const { text } = formatOutput(snapshot, "");
					if (err instanceof Error && err.message === "aborted") {
						throw new Error(appendStatus(text, "Command aborted"));
					}
					if (err instanceof Error && err.message.startsWith("timeout:")) {
						const timeoutSecs = err.message.split(":")[1];
						throw new Error(appendStatus(text, `Command timed out after ${timeoutSecs} seconds`));
					}
					throw err;
				}
				const snapshot = await finishOutput();
				const { text: outputText, details } = formatOutput(snapshot);
				if (exitCode !== 0 && exitCode !== null) {
					return { content: [{ type: "text", text: appendStatus(outputText, `Command exited with code ${exitCode}`) }], details: { ...withTiming(details), exitCode }, isError: true };
				}
				return { content: [{ type: "text", text: outputText }], details: withTiming(details) };
			} finally { invalidateNativeSearchCache(); clearUpdateTimer(); }
		},
		renderCall(args, _theme, context) {
			const state = context.state;
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(formatBashCall(args));
			return text;
		},
		renderResult(result, options, _theme, context) {
			const state = context.state;
			if (state.startedAt !== undefined && options.isPartial && !state.interval) {
				state.interval = setInterval(() => context.invalidate(), 1000);
			}
			if (!options.isPartial || context.isError) {
				state.endedAt ??= Date.now();
				if (state.interval) {
					clearInterval(state.interval);
					state.interval = undefined;
				}
			}
			const component =
				(context.lastComponent as BashResultRenderComponent | undefined) ?? new BashResultRenderComponent();
			rebuildBashResultRenderComponent(
				component,
				result,
				options,
				context.showImages,
				state.startedAt,
				state.endedAt,
			);
			component.invalidate();
			return component;
		},
	};
}
export function createBashTool(cwd: string, options?: BashToolOptions): AgentTool<typeof bashSchema> {
	return wrapToolDefinition(createBashToolDefinition(cwd, options));
}

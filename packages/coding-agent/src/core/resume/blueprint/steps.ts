import { writeSync } from "node:fs";
import { join } from "node:path";
import { getPowerShellConfig, getShellConfig, type ShellConfig } from "../../../utils/shell.ts";
import { type ActionFetcher, runAction } from "./actions.ts";
import { bashPath, evaluateEnvrc, shellQuote } from "./envrc.ts";
import {
	BlueprintError,
	type BlueprintScope,
	type BlueprintSection,
	BlueprintStepFailedError,
	type BlueprintStepLocation,
	BlueprintStepTimedOutError,
} from "./errors.ts";
import {
	type LoggedProcess,
	logTail,
	openStepLog,
	type ProcessExit,
	runLoggedProcess,
	type StepLog,
} from "./process.ts";
import type { BlueprintPlatform, BlueprintShell, BlueprintStep, RunStep } from "./types.ts";

/** How long one step may run before it is stopped: 3 hours, as in Devin. */
export const BLUEPRINT_STEP_TIMEOUT_MS = 3 * 60 * 60_000;

/** What a run of steps needs besides the steps themselves. */
export interface StepContext {
	readonly blueprint: string;
	readonly scope: BlueprintScope;
	/** Home directory for the global blueprint; the repository root or workspace directory otherwise. */
	readonly cwd: string;
	readonly shell: BlueprintShell;
	readonly platform: BlueprintPlatform;
	/** The build's `$ENVRC` file. */
	readonly envrcPath: string;
	readonly logDirectory: string;
	/** Makes this layer's log file names unique within the host's logs. */
	readonly logPrefix: string;
	readonly timeoutMs: number;
	readonly environment: NodeJS.ProcessEnv;
	readonly actionsCacheDir: string;
	readonly fetchAction?: ActionFetcher;
	readonly signal?: AbortSignal;
}

/** The first step of a section that did not succeed. */
export interface StepFailure {
	readonly error: BlueprintError;
	/** Null when the step's log could not be created. */
	readonly logPath: string | null;
	/** The end of the step's output. */
	readonly outputTail: string;
}

export interface SectionResult {
	/** How many steps ran to completion. */
	readonly completed: number;
	/** Set when a step failed; the steps after it did not run. */
	readonly failure?: StepFailure;
}

function stepLabel(step: BlueprintStep, section: BlueprintSection, index: number): string {
	return step.name ?? `${section} step ${index + 1}`;
}

function describeCommand(step: BlueprintStep): string {
	return step.kind === "run" ? step.run : `uses ${step.uses}`;
}

/** The bash script of a `run` step: the build's `$ENVRC` is sourced and the step's own variables win over it. */
function bashScript(step: RunStep): string {
	const own = Object.entries(step.env).map(([name, value]) => `export ${name}=${shellQuote(value)}`);
	return ["set -a", '[ -f "$ENVRC" ] && . "$ENVRC"', "set +a", ...own, "set -e", step.run, ""].join("\n");
}

/** Whether a `run` step goes to PowerShell: only on Windows, and only when its blueprint asks for it. */
export function runsInPowerShell(shell: BlueprintShell, platform: BlueprintPlatform): boolean {
	return shell === "powershell" && platform === "windows";
}

/** The PowerShell process of a `run` step. `evaluated` is the environment the build's `$ENVRC` gives the build's own. */
export function powerShellProcess(
	step: RunStep,
	context: StepContext,
	powerShell: ShellConfig,
	evaluated: NodeJS.ProcessEnv,
): LoggedProcess {
	return {
		command: powerShell.shell,
		args: [...powerShell.args, `$ErrorActionPreference = 'Stop'; ${step.run}`],
		cwd: context.cwd,
		env: { ...evaluated, ...step.env, ENVRC: context.envrcPath },
	};
}

/** The bash process of a `run` step: its script is the last argument, or on stdin for a bash that cannot take it there. */
export function bashProcess(step: RunStep, context: StepContext, bash: ShellConfig): LoggedProcess {
	const script = bashScript(step);
	const byStdin = bash.commandTransport === "stdin";
	return {
		command: bash.shell,
		args: byStdin ? bash.args : [...bash.args, script],
		cwd: context.cwd,
		env: { ...context.environment, ...step.env, ENVRC: bashPath(context.envrcPath) },
		...(byStdin ? { stdin: script } : {}),
	};
}

function append(log: StepLog, text: string): void {
	writeSync(log.fd, text);
}

async function startStep(
	step: BlueprintStep,
	location: BlueprintStepLocation,
	total: number,
	context: StepContext,
	log: StepLog,
): Promise<ProcessExit> {
	append(
		log,
		[
			`# blueprint: ${context.blueprint}`,
			`# scope: ${context.scope}`,
			`# section: ${location.section}`,
			`# step: ${location.step} (${location.index + 1}/${total})`,
			`# cwd: ${context.cwd}`,
			"# command:",
			describeCommand(step),
			"# --- output ---",
			"",
		].join("\n"),
	);
	if (step.kind === "uses") {
		const environment = { ...(await evaluateEnvrc(context.envrcPath, context.environment)), ...step.env };
		return runAction({
			step: { uses: step.uses, inputs: step.with },
			location: { ...location },
			cwd: context.cwd,
			env: environment,
			envrcPath: context.envrcPath,
			cacheDir: context.actionsCacheDir,
			log,
			timeoutMs: context.timeoutMs,
			signal: context.signal,
			fetchAction: context.fetchAction,
		});
	}
	const options = { timeoutMs: context.timeoutMs, signal: context.signal };
	if (runsInPowerShell(context.shell, context.platform)) {
		const evaluated = await evaluateEnvrc(context.envrcPath, context.environment);
		return runLoggedProcess(powerShellProcess(step, context, getPowerShellConfig(), evaluated), log, options);
	}
	return runLoggedProcess(bashProcess(step, context, getShellConfig()), log, options);
}

function describeExit(exit: ProcessExit, timeoutMs: number): string {
	if (exit.timedOut) return `# timed out after ${timeoutMs} ms and was stopped`;
	if (exit.spawnError) return `# could not be started: ${exit.spawnError.message}`;
	if (exit.signal !== null) return `# stopped by signal ${exit.signal}`;
	return `# exit status ${exit.exitStatus}`;
}

function failureOf(
	exit: ProcessExit,
	location: BlueprintStepLocation,
	logPath: string,
	timeoutMs: number,
): BlueprintError | undefined {
	if (exit.timedOut) {
		return new BlueprintStepTimedOutError({
			...location,
			logPath,
			timeoutMs,
			elapsedMs: exit.elapsedMs,
			phase: location.section,
		});
	}
	if (exit.exitStatus === 0 && exit.signal === null && exit.spawnError === undefined) return undefined;
	return new BlueprintStepFailedError(
		{ ...location, exitStatus: exit.exitStatus, signal: exit.signal, logPath },
		exit.spawnError,
	);
}

/**
 * Runs the steps of one section in order, each with its own log file, and stops at the first that fails: the steps
 * after it do not run. A step fails when it exits non-zero, is stopped by a signal, cannot be started, times out, or
 * is a `uses` step that cannot run. Nothing a step does throws, apart from `context.signal` aborting, which rejects
 * with its reason: cancelling is not a failure.
 */
export async function runSection(
	section: BlueprintSection,
	steps: readonly BlueprintStep[],
	context: StepContext,
): Promise<SectionResult> {
	for (const [index, step] of steps.entries()) {
		context.signal?.throwIfAborted();
		const location: BlueprintStepLocation = {
			blueprint: context.blueprint,
			scope: context.scope,
			section,
			index,
			step: stepLabel(step, section, index),
		};
		const logPath = join(context.logDirectory, `${context.logPrefix}-${section}-${index + 1}.log`);
		let log: Awaited<ReturnType<typeof openStepLog>> | undefined;
		let error: BlueprintError | undefined;
		try {
			log = await openStepLog(logPath);
			const exit = await startStep(step, location, steps.length, context, log);
			append(log, `\n${describeExit(exit, context.timeoutMs)}\n`);
			error = failureOf(exit, location, logPath, context.timeoutMs);
		} catch (thrown) {
			if (context.signal?.aborted) throw thrown;
			const cause = thrown instanceof Error ? thrown : new Error(String(thrown));
			if (log !== undefined) append(log, `\n# failed: ${cause.message}\n`);
			error =
				thrown instanceof BlueprintError
					? thrown
					: new BlueprintStepFailedError(
							{ ...location, exitStatus: null, signal: null, logPath: log === undefined ? null : logPath },
							cause,
						);
		} finally {
			await log?.close();
		}
		if (error !== undefined) {
			const written = log === undefined ? null : logPath;
			return {
				completed: index,
				failure: { error, logPath: written, outputTail: written === null ? "" : await logTail(written) },
			};
		}
	}
	return { completed: steps.length };
}

import { spawnSync } from "node:child_process";
import { hostPlatform } from "../../src/core/resume/blueprint/schema.ts";
import { BLUEPRINT_STEP_TIMEOUT_MS } from "../../src/core/resume/blueprint/steps.ts";
import { getShellConfig } from "../../src/utils/shell.ts";

export function forThisHost(blueprint: string): string {
	return `runs-on: ${hostPlatform()}\n${blueprint}`;
}

export const WORKING_DIRECTORY_COMMAND = process.platform === "win32" ? "pwd -W" : "pwd -P";

/**
 * `$PWD` of a step that runs in `directory` with `environment`. Git Bash spells a directory below its `/tmp` mount as
 * `/tmp/...` when it starts there, unlike `cd`, so the shell is started there as a step is.
 */
export function shellSpelling(directory: string, environment: NodeJS.ProcessEnv): string {
	if (process.platform !== "win32") return directory;
	const asked = spawnSync(getShellConfig().shell, ["-c", 'printf %s "$PWD"'], {
		cwd: directory,
		env: environment,
		encoding: "utf8",
	});
	if (asked.status !== 0) throw new Error(`The shell cannot enter ${directory}: ${asked.stderr}`);
	return asked.stdout.trim();
}

/**
 * Makes the step budget timer armed for {@link BLUEPRINT_STEP_TIMEOUT_MS} expire once `started()` is true, rather than
 * after three hours or before a slow shell on a loaded machine writes its start marker. Records every intercepted delay
 * so callers still verify that the step budget was forwarded to the process timer.
 *
 * The poll is always scheduled on a later timer turn (never synchronously inside `setTimeout`) so the process runner
 * finishes wiring its timer handle and exit listeners before the callback runs. Callers that use this helper keep
 * real wall-clock timeout and `elapsedMs` coverage in a separate sleep-only timeout test.
 */
export function expireStepBudgetOnceStarted(started: () => boolean): {
	readonly armedDelays: number[];
	restore(): void;
} {
	const realSetTimeout = globalThis.setTimeout;
	const realClearTimeout = globalThis.clearTimeout;
	const armedDelays: number[] = [];
	const budgets: { readonly standIn: NodeJS.Timeout; cleared: boolean; watch?: NodeJS.Timeout }[] = [];
	globalThis.setTimeout = ((handler: (...args: unknown[]) => void, timeout?: number, ...args: unknown[]) => {
		if (
			typeof timeout !== "number" ||
			!Number.isFinite(timeout) ||
			timeout <= BLUEPRINT_STEP_TIMEOUT_MS / 2 ||
			timeout > BLUEPRINT_STEP_TIMEOUT_MS
		) {
			return realSetTimeout(handler, timeout, ...args);
		}
		armedDelays.push(timeout);
		const budget: (typeof budgets)[number] = {
			standIn: realSetTimeout(() => undefined, 2 ** 31 - 1),
			cleared: false,
		};
		budget.standIn.unref();
		budgets.push(budget);
		const look = () => {
			if (budget.cleared) return;
			if (started()) handler(...args);
			else budget.watch = realSetTimeout(look, 20);
		};
		budget.watch = realSetTimeout(look, 20);
		return budget.standIn;
	}) as typeof setTimeout;
	globalThis.clearTimeout = ((timer?: NodeJS.Timeout | string | number) => {
		const budget = budgets.find((entry) => entry.standIn === timer);
		if (budget !== undefined) {
			budget.cleared = true;
			realClearTimeout(budget.watch);
		}
		realClearTimeout(timer);
	}) as typeof clearTimeout;
	return {
		armedDelays,
		restore() {
			globalThis.setTimeout = realSetTimeout;
			globalThis.clearTimeout = realClearTimeout;
			for (const budget of budgets) {
				budget.cleared = true;
				realClearTimeout(budget.watch);
				realClearTimeout(budget.standIn);
			}
		},
	};
}

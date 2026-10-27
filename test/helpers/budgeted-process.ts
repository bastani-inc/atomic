import { readStreamText, type SpawnedProcess, spawnProcess } from "./runtime.js";

/** A child process that is killed once the deadline it was given passes, and knows whether that killed it. */
export interface BudgetedProcess {
	readonly process: SpawnedProcess;
	/** Its stderr, read from the start. */
	readonly stderr: Promise<string>;
	/** What it had left of its budget when it started. */
	readonly budgetMs: number;
	/** Whether its budget ran out and killed it. */
	readonly budgetExpired: boolean;
}

/**
 * Spawns `command` with its stderr piped, killing it with SIGKILL at `deadline` (a `Date.now()` time). A test that
 * runs several processes passes them one deadline, so a slow one leaves less for the next rather than each getting
 * its own fixed bound.
 */
export function spawnWithinBudget(
	command: readonly string[],
	options: Omit<NonNullable<Parameters<typeof spawnProcess>[1]>, "stderr" | "timeout">,
	deadline: number,
): BudgetedProcess {
	const budgetMs = Math.max(0, deadline - Date.now());
	const child = spawnProcess(command, { ...options, stderr: "pipe" });
	let budgetExpired = false;
	const timer = setTimeout(() => {
		if (child.exitCode !== null) return;
		budgetExpired = true;
		child.kill("SIGKILL");
	}, budgetMs);
	void child.exited.finally(() => clearTimeout(timer)).catch(() => {});
	return {
		process: child,
		stderr: readStreamText(child.stderr),
		budgetMs,
		get budgetExpired() {
			return budgetExpired;
		},
	};
}

/** Waits for the process to exit 0 and returns its stderr; otherwise fails saying why it ended, with its stderr. */
export async function expectExitedCleanly(child: BudgetedProcess): Promise<string> {
	const code = await child.process.exited;
	const stderr = await child.stderr;
	if (code === 0) return stderr;
	const signal = child.process.signalCode;
	const reason = child.budgetExpired
		? `killed after its ${child.budgetMs} ms budget`
		: signal !== null
			? `killed by signal ${signal}`
			: `exited with code ${code}`;
	throw new Error(`process ${child.process.pid} ${reason}:\n${stderr}`);
}

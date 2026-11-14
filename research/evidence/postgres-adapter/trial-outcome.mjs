// How run-hotpath.mjs decides that hosts became ready and that a trial succeeded (#4793). Kept free of I/O beyond
// `existsSync` so trial-outcome.test.mjs can check it without Postgres or sqld.
import { existsSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Tracks each spawned host's exit from the moment it is spawned, so an exit before readiness, or before the run
 * loop starts watching, is never missed. `exits[i]` resolves with `{ code, signal }`.
 */
export function watchExits(processes) {
	const states = processes.map(() => undefined);
	const exits = processes.map(
		(child, index) =>
			new Promise((resolve) => {
				const settle = (code, signal) => {
					states[index] ??= { code, signal };
					resolve(states[index]);
				};
				if (child.exitCode !== null || child.signalCode !== null) settle(child.exitCode, child.signalCode);
				child.once("exit", settle);
				child.once("error", (error) => settle(null, String(error?.code ?? error)));
			}),
	);
	return { exits, states };
}

/**
 * Waits for every ready file. Resolves undefined when all appeared; resolves with a failure reason when a host exited
 * before its file appeared or `deadlineMs` passed first.
 */
export async function waitForReady(readyFiles, states, deadlineMs, pollMs = 50) {
	for (;;) {
		const missing = readyFiles.map((file, index) => (existsSync(file) ? -1 : index)).filter((index) => index >= 0);
		if (missing.length === 0) return undefined;
		for (const index of missing)
			if (states[index] !== undefined)
				return `host h${index} exited before it was ready (code ${states[index].code}, signal ${states[index].signal})`;
		if (Date.now() >= deadlineMs) return `hosts ${missing.map((index) => `h${index}`).join(", ")} not ready in time`;
		await sleep(pollMs);
	}
}

/**
 * A trial's final status: the run loop's own status unless it was "completed", in which case every host must have
 * exited 0 and written its result file. Returns `{ status, failure? }`.
 */
export function trialOutcome(runStatus, states, resultFiles) {
	if (runStatus !== "completed") return { status: runStatus };
	const problems = [];
	states.forEach((state, index) => {
		if (state === undefined) problems.push(`host h${index} did not exit`);
		else if (state.code !== 0) problems.push(`host h${index} exited with code ${state.code}, signal ${state.signal}`);
		if (!existsSync(resultFiles[index])) problems.push(`host h${index} wrote no result file`);
	});
	return problems.length === 0 ? { status: "completed" } : { status: "failed", failure: problems.join("; ") };
}

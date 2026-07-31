/**
 * Project workflow fixture for the issue #2078 end-to-end scenario.
 *
 * Both drivers — `test/integration/workflow-tool-node-quit-cli.test.ts` and
 * `scripts/e2e/issue-2078-evidence.sh` — copy this file into a scratch
 * project's `.atomic/workflows/` and let the real Atomic CLI discover it, so it
 * has to stay self-contained: no relative imports survive the copy.
 *
 * The run is tool-only on purpose. That is the exact shape issue #2078 reported
 * as uncontrollable: no stage is ever registered, so before the fix `quitRun`
 * saw nothing controllable and answered `no_active_stages` while the callback
 * kept running.
 *
 *   sibling-tool  completes immediately and is therefore checkpointed, which is
 *                 what makes the run resumable and what proves a settled
 *                 sibling replays from cache instead of running twice.
 *   hang-tool     never settles on its own. Its only exit is the `AbortSignal`
 *                 that `ctx.tool` now hands the callback, so every observation
 *                 below is real behavior rather than a timer.
 *
 * Execution counts and the observed abort are recorded in one JSON file under
 * `ISSUE_2078_STATE_DIR` so a driver outside this process can read them.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflow } from "@bastani/workflows";
import { Type } from "typebox";

/** Shape of the JSON state file both drivers read. */
interface Issue2078FixtureState {
	/** How many times `sibling-tool`'s callback actually executed. */
	siblingExecutions: number;
	/** How many times `hang-tool`'s callback actually executed. */
	hangExecutions: number;
	/** True while the first `hang-tool` execution is parked on its signal. */
	hangRunning: boolean;
	/** True once the callback's own `AbortSignal` fired. */
	hangObservedAbort: boolean;
}

const ISSUE_2078_STATE_FILE = "issue-2078-state.json";

const EMPTY_STATE: Issue2078FixtureState = {
	siblingExecutions: 0,
	hangExecutions: 0,
	hangRunning: false,
	hangObservedAbort: false,
};

function statePath(): string {
	const directory = process.env.ISSUE_2078_STATE_DIR;
	if (directory === undefined || directory.trim() === "") {
		throw new Error("issue-2078 fixture: ISSUE_2078_STATE_DIR must name a writable scratch directory");
	}
	mkdirSync(directory, { recursive: true });
	return join(directory, ISSUE_2078_STATE_FILE);
}

function readState(): Issue2078FixtureState {
	const path = statePath();
	if (!existsSync(path)) return { ...EMPTY_STATE };
	return { ...EMPTY_STATE, ...(JSON.parse(readFileSync(path, "utf8")) as Issue2078FixtureState) };
}

/** Apply one change and publish it; the workflow body is strictly sequential. */
function update(change: (state: Issue2078FixtureState) => void): Issue2078FixtureState {
	const state = readState();
	change(state);
	writeFileSync(statePath(), JSON.stringify(state), "utf8");
	return state;
}

export default workflow({
	name: "issue-2078-tool-quit",
	description: "Tool-only run whose second ctx.tool call settles only through its abort signal (issue #2078).",
	inputs: {},
	// Two fields, because the rendered `result` row is the evidence a reviewer
	// reads: one reports what the aborted call saw and did, the other reports
	// how many times the settled sibling actually executed.
	outputs: { hang: Type.String(), sibling: Type.String() },
	run: async (ctx) => {
		const sibling = await ctx.tool("sibling-tool", {}, async () => {
			const state = update((current) => {
				current.siblingExecutions += 1;
			});
			return `sibling-ran-${state.siblingExecutions}`;
		});

		const hung = await ctx.tool("hang-tool", {}, async (toolContext) => {
			const state = update((current) => {
				current.hangExecutions += 1;
				current.hangRunning = true;
			});
			// The re-execution after a quit reports what the first execution saw,
			// so one rendered artifact carries both halves of the contract: the
			// aborted call really observed cancellation, and it really ran again.
			if (state.hangExecutions > 1) {
				update((current) => {
					current.hangRunning = false;
				});
				const observed = state.hangObservedAbort ? "aborted-then-reran" : "reran-without-abort";
				return `${observed}-${state.hangExecutions}`;
			}
			// `toolContext` is the cancellation handle #2078 added. Before the fix
			// `ctx.tool` invoked `fn()` with no argument, which is the reported
			// defect: the callback has no way to observe cancellation and parks
			// with no exit. Reading it defensively reproduces that older contract
			// exactly, so this scenario reaches the quit step on both sides of the
			// fix instead of dying here on a missing property.
			const signal: AbortSignal | undefined = toolContext?.signal;
			return await new Promise<string>((_resolve, reject) => {
				const cancel = (): void => {
					update((current) => {
						current.hangObservedAbort = true;
						current.hangRunning = false;
					});
					reject(new Error("hang-tool observed its abort signal"));
				};
				// Pre-fix contract: nothing to listen to, so this parks forever and
				// pins the run — which is what the scenario then tries to quit.
				if (signal === undefined) return;
				if (signal.aborted) {
					cancel();
					return;
				}
				signal.addEventListener("abort", cancel, { once: true });
			});
		});

		return { hang: hung, sibling };
	},
});

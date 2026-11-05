// @ts-check
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { shellQuote } from "./commands.mjs";
import { readJsonInput } from "./config.mjs";
import { DistributedConfigError } from "./errors.mjs";

/**
 * @typedef {{ plan: import("./config.mjs").RunPlan, options: import("./config.mjs").RunOptions, subscription: string, controlVnetId: string,
 *   vms: import("./azure.mjs").PlacedVm[], networks: import("./azure.mjs").RegionNetwork[], sha: string,
 *   artifact: { path: string, digest: string }, runtime: { path: string, digest: string }, sqld: { path: string, digest: string, version: string },
 *   deployed: boolean, sqldReady: boolean }} RunState
 */

/**
 * @param {string} runId
 * @param {string} stateRoot
 * @param {string | undefined} outDir
 * @returns {RunState}
 */
export function loadState(runId, stateRoot, outDir) {
	const state = readJsonInput((path) => readFileSync(path, "utf8"), {
		source: "cli",
		field: "--reuse",
		path: join(outDir ?? join(stateRoot, runId), "state.json"),
		expected: "the id of a run kept with --keep whose topology was provisioned",
	});
	if (
		typeof state !== "object" ||
		state === null ||
		!("plan" in state) ||
		typeof state.plan !== "object" ||
		state.plan === null ||
		!("runId" in state.plan) ||
		state.plan.runId !== runId
	) {
		throw new DistributedConfigError({
			source: "cli",
			field: "--reuse",
			reason: "invalid-value",
			expected: "state.json for the requested run ID",
		});
	}
	return /** @type {RunState} */ (state);
}

/** @param {string} runId @param {string | undefined} outDir */
export function reuseCommand(runId, outDir) {
	return `node test/distributed/run.mjs --reuse ${runId}${outDir === undefined ? "" : ` --out ${shellQuote(outDir)}`}`;
}

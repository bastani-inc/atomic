#!/usr/bin/env node
// @ts-check
/**
 * TTL sweeper for distributed-test resources, independent of any run's controller:
 *
 *   node test/distributed/sweep.mjs [--dry-run] [--run-id <id> [--force]] [--now <iso>]
 *
 * The control network comes from ATOMIC_DISTRIBUTED_CONTROL_RESOURCE_GROUP, ATOMIC_DISTRIBUTED_CONTROL_VNET and
 * ATOMIC_DISTRIBUTED_CONTROL_SSH_PREFIX, as for run.mjs.
 *
 * It lists resource groups and resources tagged `atomic-distributed-test`, re-reads each candidate's tags (tag-filtered
 * listings may omit them), deletes those past `atomic-distributed-test-expiry`, deletes control-VNet peerings named
 * for runs whose group is gone or being deleted, and proves absence for every run it deleted. `--run-id` limits the
 * sweep to one run; with `--force` it ignores that run's TTL. Schedule it (cron or a CI timer) to collect runs whose
 * controller died.
 */
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { azJson } from "./harness/commands.mjs";
import { parseControlEnv, RUN_ID_PATTERN } from "./harness/config.mjs";
import { DistributedConfigError, isCancellation, serializeDistributedError } from "./harness/errors.mjs";
import { planSweep, RUN_TAG } from "./harness/ownership.mjs";
import { teardownRun } from "./harness/teardown.mjs";

/**
 * @param {readonly string[]} argv
 */
export function parseSweepArgs(argv) {
	/** @type {{ dryRun: boolean, force: boolean, runId?: string, now?: Date }} */
	const args = { dryRun: false, force: false };
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--dry-run") args.dryRun = true;
		else if (flag === "--force") args.force = true;
		else if (flag === "--run-id" || flag === "--now") {
			const value = argv[++index];
			if (value === undefined || value.startsWith("--"))
				throw new DistributedConfigError({
					source: "cli",
					field: flag,
					reason: "missing-value",
					expected: "a value after the flag",
				});
			if (flag === "--run-id") {
				if (!RUN_ID_PATTERN.test(value))
					throw new DistributedConfigError({
						source: "cli",
						field: flag,
						reason: "invalid-value",
						expected: "a run id like adt2611050230-beef",
						actual: value,
					});
				args.runId = value;
			} else {
				const instant = new Date(value);
				if (Number.isNaN(instant.getTime()))
					throw new DistributedConfigError({
						source: "cli",
						field: flag,
						reason: "invalid-value",
						expected: "an ISO-8601 instant",
						actual: value,
					});
				args.now = instant;
			}
		} else
			throw new DistributedConfigError({
				source: "cli",
				field: flag,
				reason: "unknown-flag",
				expected: "--dry-run, --run-id, --force or --now",
				actual: flag,
			});
	}
	if (args.force && args.runId === undefined)
		throw new DistributedConfigError({
			source: "cli",
			field: "--force",
			reason: "invalid-value",
			expected: "--force only together with --run-id",
			actual: "--force",
		});
	return args;
}

/**
 * @param {{ az: import("./harness/teardown.mjs").AzJson, control: { resourceGroup: string, vnet: string }, now: Date, runId?: string, force: boolean, dryRun: boolean,
 *   sleep: (ms: number) => Promise<void>, clock: () => number, log: (line: string) => void }} input
 */
export async function sweep({ az, control, now, runId, force, dryRun, sleep, clock, log }) {
	/** @type {{ id: string, name: string }[]} */
	const listedGroups =
		/** @type {any} */ (
			await az(["group", "list", "--query", `[?tags."${RUN_TAG}" != null].{id:id,name:name}`], "list tagged groups")
		) ?? [];
	const groups = [];
	for (const group of listedGroups) {
		/** @type {{ id: string, name: string, tags: Record<string, string> | null }} */
		const shown = /** @type {any} */ (
			await az(
				["group", "show", "--name", group.name, "--query", "{id:id,name:name,tags:tags}"],
				`read tags of ${group.name}`,
			)
		);
		groups.push(shown);
	}
	/** @type {{ id: string, name: string, resourceGroup: string }[]} */
	const listedResources =
		/** @type {any} */ (
			await az(
				["resource", "list", "--tag", RUN_TAG, "--query", "[].{id:id,name:name,resourceGroup:resourceGroup}"],
				"list tagged resources",
			)
		) ?? [];
	const groupNames = new Set(groups.map((group) => group.name.toLowerCase()));
	const resources = [];
	for (const resource of listedResources) {
		if (groupNames.has(resource.resourceGroup.toLowerCase())) continue;
		/** @type {Record<string, string> | null} */
		const tags = /** @type {any} */ (
			await az(["resource", "show", "--ids", resource.id, "--query", "tags"], `read tags of ${resource.name}`)
		);
		resources.push({ ...resource, tags });
	}
	/** @type {{ name: string }[]} */
	const controlPeerings =
		/** @type {any} */ (
			await az(
				[
					"network",
					"vnet",
					"peering",
					"list",
					"--resource-group",
					control.resourceGroup,
					"--vnet-name",
					control.vnet,
					"--query",
					"[].{name:name}",
				],
				"list control peerings",
			)
		) ?? [];
	/** @type {string[]} */
	const existingGroups =
		/** @type {any} */ (await az(["group", "list", "--query", "[].name"], "list resource groups")) ?? [];
	const plan = planSweep({
		groups,
		resources,
		controlPeerings,
		existingGroups,
		now,
		onlyRunId: runId,
		force,
	});
	log(
		`sweep plan: ${plan.groups.length} group(s), ${plan.resources.length} resource(s), ${plan.controlPeerings.length} control peering(s); kept ${plan.kept.length}`,
	);
	/** @type {{ runId: string, ok: boolean, remaining: string[], queries: import("./harness/teardown.mjs").QueryRecord[], error?: import("./harness/errors.mjs").SerializedError }[]} */
	const runs = [];
	/** @type {{ id: string, runId: string, error: import("./harness/errors.mjs").SerializedError }[]} */
	const deleteFailures = [];
	if (dryRun) return { plan, runs, deleteFailures };
	for (const resource of plan.resources) {
		try {
			await az(["resource", "delete", "--ids", resource.id], `delete ${resource.id}`);
		} catch (error) {
			if (isCancellation(error)) throw error;
			deleteFailures.push({ id: resource.id, runId: resource.runId, error: serializeDistributedError(error) });
		}
	}
	const observedGroups = new Set(
		[...existingGroups, ...groups.map((group) => group.name)].map((name) => name.toLowerCase()),
	);
	const groupIsGone = (/** @type {string} */ id) => !observedGroups.has(`${id}-rg`.toLowerCase());
	const runIds = [
		...new Set([
			...plan.groups.map((group) => group.runId),
			...plan.controlPeerings.map((peering) => peering.runId),
			...plan.resources.map((resource) => resource.runId).filter(groupIsGone),
		]),
	];
	for (const id of runIds) {
		log(`tearing down ${id}`);
		const result = await teardownRun({
			az,
			runId: id,
			resourceGroup: `${id}-rg`,
			control,
			knownPeerings: plan.controlPeerings.filter((peering) => peering.runId === id).map((peering) => peering.name),
			sleep,
			now: clock,
			deadlineMs: 10 * 60_000,
			pollMs: 20_000,
		});
		runs.push({
			runId: id,
			ok: result.ok,
			remaining: result.remaining,
			queries: result.queries,
			...(result.error === undefined ? {} : { error: serializeDistributedError(result.error) }),
		});
	}
	return { plan, runs, deleteFailures };
}

/** @param {{ runs: readonly { ok: boolean }[], deleteFailures: readonly { id: string }[] }} result */
export function sweepExitCode(result) {
	return result.runs.every((run) => run.ok) && result.deleteFailures.length === 0 ? 0 : 1;
}

async function main() {
	let args;
	let control;
	try {
		args = parseSweepArgs(process.argv.slice(2));
		control = parseControlEnv(process.env);
	} catch (error) {
		process.stderr.write(`Sweep rejected: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
	/** @type {import("./harness/commands.mjs").CommandContext} */
	const context = { secrets: new Set() };
	try {
		const result = await sweep({
			az: (azArgs, operation) => azJson(context, azArgs, { operation, timeoutMs: 45 * 60_000 }),
			control,
			now: args.now ?? new Date(),
			...(args.runId === undefined ? {} : { runId: args.runId }),
			force: args.force,
			dryRun: args.dryRun,
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			clock: () => performance.now(),
			log: (line) => process.stderr.write(`${line}\n`),
		});
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return sweepExitCode(result);
	} catch (error) {
		process.stderr.write(`Sweep failed: ${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exitCode = await main();
}

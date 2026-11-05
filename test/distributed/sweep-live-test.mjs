#!/usr/bin/env node
// @ts-check
/**
 * Live test of the TTL sweeper against real Azure resources:
 *
 *   node test/distributed/sweep-live-test.mjs
 *
 * It creates two harness-shaped runs: one already expired (a tagged group with a tagged VNet, peered both ways with
 * the control VNet) and one unexpired (a tagged group with a tagged NSG). It runs a sweep limited to those two runs,
 * asserts that the expired run, including the control VNet's side of its peering, is gone while the unexpired run is
 * untouched, then removes the unexpired run with `--force` semantics and proves it is gone too. Prints a JSON record
 * of every query and result.
 */
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { azJson } from "./harness/commands.mjs";
import { newRunId, parseControlEnv, parseTopology } from "./harness/config.mjs";
import { networkNames, runTags, tagArguments } from "./harness/ownership.mjs";
import { sweep } from "./sweep.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const topology = parseTopology(JSON.parse(readFileSync(join(HERE, "topology.json"), "utf8")));
const control = parseControlEnv(process.env);
/** @type {import("./harness/commands.mjs").CommandContext} */
const context = { secrets: new Set() };
/** @type {import("./harness/teardown.mjs").AzJson} */
const az = (args, operation) => azJson(context, args, { operation, timeoutMs: 45 * 60_000 });
const log = (/** @type {string} */ line) => process.stderr.write(`${line}\n`);
const now = new Date();
const expired = newRunId(now, randomInt(65536));
const unexpired = newRunId(now, randomInt(65536));
const region = topology.regions[0];

/**
 * @param {boolean} condition
 * @param {string} message
 */
function check(condition, message) {
	if (!condition) throw new Error(`sweep live test failed: ${message}`);
	log(`ok: ${message}`);
}

const evidence = { expired, unexpired, steps: /** @type {unknown[]} */ ([]) };
try {
	log(`creating expired run ${expired} and unexpired run ${unexpired}`);
	const past = new Date(now.getTime() - 3_600_000).toISOString();
	const future = new Date(now.getTime() + 3 * 3_600_000).toISOString();
	const names = networkNames(expired, region);
	await az(
		[
			"group",
			"create",
			"--name",
			`${expired}-rg`,
			"--location",
			region,
			"--tags",
			...tagArguments(runTags(expired, past)),
		],
		"create expired group",
	);
	const vnet = /** @type {{ newVNet: { id: string } }} */ (
		await az(
			[
				"network",
				"vnet",
				"create",
				"--resource-group",
				`${expired}-rg`,
				"--name",
				names.vnet,
				"--location",
				region,
				"--address-prefixes",
				"10.250.0.0/16",
				"--tags",
				...tagArguments(runTags(expired, past)),
			],
			"create expired VNet",
		)
	);
	const controlId = /** @type {string} */ (
		await az(
			[
				"network",
				"vnet",
				"show",
				"--resource-group",
				control.resourceGroup,
				"--name",
				control.vnet,
				"--query",
				"id",
			],
			"control VNet id",
		)
	);
	await az(
		[
			"network",
			"vnet",
			"peering",
			"create",
			"--resource-group",
			control.resourceGroup,
			"--vnet-name",
			control.vnet,
			"--name",
			names.fromControl,
			"--remote-vnet",
			vnet.newVNet.id,
			"--allow-vnet-access",
			"true",
		],
		"create control-side peering",
	);
	await az(
		[
			"network",
			"vnet",
			"peering",
			"create",
			"--resource-group",
			`${expired}-rg`,
			"--vnet-name",
			names.vnet,
			"--name",
			names.toControl,
			"--remote-vnet",
			controlId,
			"--allow-vnet-access",
			"true",
		],
		"create test-side peering",
	);
	await az(
		[
			"group",
			"create",
			"--name",
			`${unexpired}-rg`,
			"--location",
			region,
			"--tags",
			...tagArguments(runTags(unexpired, future)),
		],
		"create unexpired group",
	);
	await az(
		[
			"network",
			"nsg",
			"create",
			"--resource-group",
			`${unexpired}-rg`,
			"--name",
			`${unexpired}-${region}-nsg`,
			"--location",
			region,
			"--tags",
			...tagArguments(runTags(unexpired, future)),
		],
		"create unexpired NSG",
	);

	const sweepOnce = async (/** @type {string} */ runId, /** @type {boolean} */ force) =>
		sweep({
			az,
			control,
			now: new Date(),
			runId,
			force,
			dryRun: false,
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			clock: () => performance.now(),
			log,
		});
	const first = await sweepOnce(expired, false);
	evidence.steps.push({ sweep: "expired run, no force", plan: first.plan, runs: first.runs });
	check(
		first.plan.groups.length === 1 && first.plan.groups[0].name === `${expired}-rg`,
		"the expired group is planned for deletion",
	);
	check(
		first.plan.controlPeerings.some((peering) => peering.name === names.fromControl),
		"the control VNet's peering of the expired run is planned for deletion",
	);
	check(first.runs.length === 1 && first.runs[0].ok, "the expired run's teardown proved absence");
	const second = await sweepOnce(unexpired, false);
	evidence.steps.push({ sweep: "unexpired run, no force", plan: second.plan, runs: second.runs });
	check(
		second.plan.groups.length === 0 &&
			second.plan.kept.some((item) => item.subject === `${unexpired}-rg` && item.reason === "unexpired"),
		"the unexpired run is kept",
	);
	const stillThere = await az(
		["resource", "list", "--tag", `atomic-distributed-test=${unexpired}`, "--query", "[].id"],
		"unexpired resources",
	);
	check(Array.isArray(stillThere) && stillThere.length === 1, "the unexpired run's NSG is untouched");
	const forced = await sweepOnce(unexpired, true);
	evidence.steps.push({ sweep: "unexpired run, force", plan: forced.plan, runs: forced.runs });
	check(forced.runs.length === 1 && forced.runs[0].ok, "a forced sweep removes the unexpired run and proves absence");
	process.stdout.write(`${JSON.stringify({ passed: true, ...evidence }, null, 2)}\n`);
} catch (error) {
	process.stdout.write(
		`${JSON.stringify({ passed: false, error: error instanceof Error ? error.message : String(error), ...evidence }, null, 2)}\n`,
	);
	log("cleaning up after a failed live test");
	for (const runId of [expired, unexpired])
		await sweep({
			az,
			control,
			now: new Date(),
			runId,
			force: true,
			dryRun: false,
			sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
			clock: () => performance.now(),
			log,
		});
	process.exitCode = 1;
}

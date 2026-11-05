// @ts-check
/**
 * Teardown of one run: the control VNet's peerings named for the run, then the run's resource group, then absence
 * queries that must all succeed and return nothing. It continues past individual failures, never treats a failed
 * query as absence, and reports success only with that proof.
 */
import { DistributedTeardownError, isCancellation } from "./errors.mjs";
import { RUN_TAG, remainingFromQueries } from "./ownership.mjs";

/**
 * @typedef {(args: readonly string[], operation: string) => Promise<unknown>} AzJson
 * @typedef {{ label: string, args: string[] }} QuerySpec
 * @typedef {{ label: string, command: string, ok: boolean, result: unknown[] }} QueryRecord
 * @typedef {{ operation: string, ok: boolean, error?: unknown }} StepRecord
 * @typedef {{ ok: boolean, steps: StepRecord[], queries: QueryRecord[], remaining: string[], error?: DistributedTeardownError }} TeardownResult
 */

/**
 * The queries that prove a run left nothing behind.
 * @param {{ runId: string, resourceGroup: string, control: { resourceGroup: string, vnet: string } }} input
 * @returns {QuerySpec[]}
 */
export function absenceQueries({ runId, resourceGroup, control }) {
	return [
		{ label: "tagged resources", args: ["resource", "list", "--tag", `${RUN_TAG}=${runId}`, "--query", "[].id"] },
		{ label: "tagged resource groups", args: ["group", "list", "--tag", `${RUN_TAG}=${runId}`, "--query", "[].id"] },
		{
			label: "control VNet peerings",
			args: [
				"network",
				"vnet",
				"peering",
				"list",
				"--resource-group",
				control.resourceGroup,
				"--vnet-name",
				control.vnet,
				"--query",
				`[?contains(name, '${runId}')].name`,
			],
		},
		{
			label: "test VNets (both peering sides)",
			args: ["network", "vnet", "list", "--query", `[?contains(name, '${runId}')].id`],
		},
		{ label: "run resource group", args: ["group", "list", "--query", `[?name=='${resourceGroup}'].id`] },
	];
}

/**
 * @param {{ az: AzJson, runId: string, resourceGroup: string, control: { resourceGroup: string, vnet: string },
 *   knownPeerings: readonly string[], sleep: (ms: number) => Promise<void>, now: () => number, deadlineMs: number, pollMs: number }} input
 * @returns {Promise<TeardownResult>}
 */
export async function teardownRun({
	az,
	runId,
	resourceGroup,
	control,
	knownPeerings,
	sleep,
	now,
	deadlineMs,
	pollMs,
}) {
	/** @type {StepRecord[]} */
	const steps = [];
	/** @type {unknown[]} */
	const errors = [];
	/**
	 * @param {string} operation
	 * @param {() => Promise<unknown>} action
	 */
	const step = async (operation, action) => {
		try {
			const value = await action();
			steps.push({ operation, ok: true });
			return value;
		} catch (error) {
			if (isCancellation(error)) throw error;
			steps.push({ operation, ok: false, error });
			errors.push(error);
			return undefined;
		}
	};
	const peeringNames = new Set(knownPeerings);
	const listed = await step("list control peerings", () =>
		az(
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
				"[].name",
			],
			"list control peerings",
		),
	);
	if (Array.isArray(listed))
		for (const name of listed) if (typeof name === "string" && name.startsWith(`${runId}-`)) peeringNames.add(name);
	for (const name of peeringNames) {
		await step(`delete control peering ${name}`, () =>
			az(
				[
					"network",
					"vnet",
					"peering",
					"delete",
					"--resource-group",
					control.resourceGroup,
					"--vnet-name",
					control.vnet,
					"--name",
					name,
				],
				`delete control peering ${name}`,
			),
		);
	}
	const exists = await step("check resource group", () =>
		az(["group", "exists", "--name", resourceGroup], "check resource group"),
	);
	if (exists === true) {
		await step(`delete resource group ${resourceGroup}`, () =>
			az(
				[
					"group",
					"delete",
					"--name",
					resourceGroup,
					"--yes",
					"--force-deletion-types",
					"Microsoft.Compute/virtualMachines",
				],
				`delete resource group ${resourceGroup}`,
			),
		);
	}
	const started = now();
	const probe = async () => {
		/** @type {QueryRecord[]} */
		const queries = [];
		/** @type {unknown[]} */
		const queryErrors = [];
		for (const query of absenceQueries({ runId, resourceGroup, control })) {
			const command = `az ${query.args.map((arg) => (/[\s[\]?'=]/.test(arg) ? `"${arg}"` : arg)).join(" ")}`;
			try {
				const result = await az(query.args, `absence query: ${query.label}`);
				queries.push({
					label: query.label,
					command,
					ok: Array.isArray(result),
					result: Array.isArray(result) ? result : [result],
				});
			} catch (error) {
				if (isCancellation(error)) throw error;
				queries.push({ label: query.label, command, ok: false, result: [] });
				queryErrors.push(error);
			}
		}
		return { queries, queryErrors };
	};
	let { queries, queryErrors } = await probe();
	while (!queries.every((query) => query.ok && query.result.length === 0) && now() - started < deadlineMs) {
		await sleep(pollMs);
		({ queries, queryErrors } = await probe());
	}
	errors.push(...queryErrors);
	const remaining = remainingFromQueries(queries);
	const failedQueries = queries.filter((query) => !query.ok).map((query) => `query failed: ${query.label}`);
	const ok = remaining.length === 0 && errors.length === 0;
	return {
		ok,
		steps,
		queries,
		remaining,
		...(ok
			? {}
			: { error: new DistributedTeardownError({ runId, remaining: [...remaining, ...failedQueries], errors }) }),
	};
}

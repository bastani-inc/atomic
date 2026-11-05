// @ts-check
/**
 * Ownership of Azure resources by a run, as pure functions: the tags a run writes, the deterministic names of its
 * untaggable children, and the TTL decisions the sweeper makes from Azure listings.
 */
import { RUN_ID_PATTERN } from "./config.mjs";

export const RUN_TAG = "atomic-distributed-test";
export const EXPIRY_TAG = "atomic-distributed-test-expiry";

/**
 * @param {string} runId
 * @param {string} expiresAt
 * @returns {Record<string, string>}
 */
export function runTags(runId, expiresAt) {
	return { [RUN_TAG]: runId, [EXPIRY_TAG]: expiresAt };
}

/**
 * `key=value` arguments for `az ... --tags`.
 * @param {Record<string, string>} tags
 */
export function tagArguments(tags) {
	return Object.entries(tags).map(([key, value]) => `${key}=${value}`);
}

/**
 * Names of a run's per-region network resources. Peerings carry the run id, so the control VNet's side, which
 * cannot be tagged, is still attributable to its run.
 * @param {string} runId
 * @param {string} region
 */
export function networkNames(runId, region) {
	return {
		vnet: `${runId}-${region}-vnet`,
		subnet: `${runId}-${region}-snet`,
		nsg: `${runId}-${region}-nsg`,
		toControl: `${runId}-${region}-to-control`,
		fromControl: `${runId}-${region}-from-control`,
		/** @param {string} other */
		toRegion: (other) => `${runId}-${region}-to-${other}`,
	};
}

/**
 * The run id a peering or resource name belongs to, if it follows the harness's naming.
 * @param {string} name
 */
export function runIdOfName(name) {
	const candidate = name.slice(0, 18);
	return RUN_ID_PATTERN.test(candidate) && (name.length === 18 || name[18] === "-") ? candidate : undefined;
}

/**
 * @typedef {{ id: string, name: string, tags?: Record<string, string> | null }} TaggedItem
 * @typedef {{ kind: "expired" | "unexpired" | "malformed-expiry" | "missing-expiry" | "foreign", runId?: string, expiresAt?: string }} Expiry
 */

/**
 * Classifies one tagged item's TTL at `now`. An item expires strictly after its expiry instant; an item without a
 * parseable expiry is never deleted by TTL.
 * @param {TaggedItem} item
 * @param {Date} now
 * @returns {Expiry}
 */
export function classifyExpiry(item, now) {
	const runId = item.tags?.[RUN_TAG];
	if (runId === undefined || !RUN_ID_PATTERN.test(runId)) return { kind: "foreign" };
	const expiresAt = item.tags?.[EXPIRY_TAG];
	if (expiresAt === undefined) return { kind: "missing-expiry", runId };
	const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(expiresAt)
		? Date.parse(expiresAt)
		: Number.NaN;
	if (Number.isNaN(instant)) return { kind: "malformed-expiry", runId, expiresAt };
	return { kind: now.getTime() > instant ? "expired" : "unexpired", runId, expiresAt };
}

/**
 * @typedef {{ id: string, name: string, resourceGroup: string, tags?: Record<string, string> | null }} TaggedResource
 * @typedef {{ name: string, remoteVnetId?: string }} ControlPeering
 * @typedef {{ groups: { name: string, runId: string }[], resources: { id: string, runId: string }[],
 *   controlPeerings: { name: string, runId: string }[], kept: { subject: string, reason: Expiry["kind"] | "group-unexpired" | "group-unknown", runId?: string }[] }} SweepPlan
 */

/**
 * What a sweep deletes. Expired run groups go whole; expired tagged resources outside those groups go one by one;
 * control-VNet peerings named for a run go when that run's group is gone or being deleted, and stay while it is
 * unexpired or its state is unknown. `onlyRunId` restricts the sweep to one run and `force` ignores its TTL.
 * @param {{ groups: readonly TaggedItem[], resources: readonly TaggedResource[], controlPeerings: readonly ControlPeering[],
 *   existingGroups: readonly string[], now: Date, onlyRunId?: string, force?: boolean }} input
 * @returns {SweepPlan}
 */
export function planSweep({ groups, resources, controlPeerings, existingGroups, now, onlyRunId, force = false }) {
	/** @type {SweepPlan} */
	const plan = { groups: [], resources: [], controlPeerings: [], kept: [] };
	const selected = (/** @type {string | undefined} */ runId) => onlyRunId === undefined || runId === onlyRunId;
	/** @type {Map<string, "deleting" | "kept">} */
	const runGroups = new Map();
	for (const group of groups) {
		const expiry = classifyExpiry(group, now);
		if (expiry.kind === "foreign" || !selected(expiry.runId)) continue;
		const runId = /** @type {string} */ (expiry.runId);
		if (expiry.kind === "expired" || (force && onlyRunId !== undefined)) {
			plan.groups.push({ name: group.name, runId });
			runGroups.set(runId, "deleting");
		} else {
			plan.kept.push({ subject: group.name, reason: expiry.kind, runId });
			runGroups.set(runId, "kept");
		}
	}
	const deletedGroups = new Set(plan.groups.map((group) => group.name.toLowerCase()));
	for (const resource of resources) {
		if (deletedGroups.has(resource.resourceGroup.toLowerCase())) continue;
		const expiry = classifyExpiry(resource, now);
		if (expiry.kind === "foreign" || !selected(expiry.runId)) continue;
		if (expiry.kind === "expired" || (force && onlyRunId !== undefined))
			plan.resources.push({ id: resource.id, runId: /** @type {string} */ (expiry.runId) });
		else plan.kept.push({ subject: resource.id, reason: expiry.kind, runId: expiry.runId });
	}
	const present = new Set(existingGroups.map((name) => name.toLowerCase()));
	for (const peering of controlPeerings) {
		const runId = runIdOfName(peering.name);
		if (runId === undefined || !selected(runId)) continue;
		const state = runGroups.get(runId);
		if (state === "deleting" || (state === undefined && !present.has(`${runId}-rg`)))
			plan.controlPeerings.push({ name: peering.name, runId });
		else
			plan.kept.push({
				subject: peering.name,
				reason: state === "kept" ? "group-unexpired" : "group-unknown",
				runId,
			});
	}
	return plan;
}

/**
 * @typedef {{ result: readonly unknown[] }} AbsenceQuery
 */

/**
 * The leftovers named by teardown's absence queries. Every query must have succeeded and returned an empty list.
 * @param {readonly AbsenceQuery[]} queries
 */
export function remainingFromQueries(queries) {
	return queries.flatMap((query) =>
		query.result.map((item) => {
			if (typeof item === "string") return item;
			if (typeof item === "object" && item !== null) {
				const id = Reflect.get(item, "id");
				const name = Reflect.get(item, "name");
				if (typeof id === "string") return id;
				if (typeof name === "string") return name;
			}
			return JSON.stringify(item);
		}),
	);
}

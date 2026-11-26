// @ts-check
/**
 * Which runs the sweeper removes. Pure, so test/unit/distributed-expiry.test.ts covers it whole.
 */
import { PROJECT_PREFIX } from "./stack.mjs";

/** A run is removed once it is older than this, unless --ttl-hours says otherwise. */
export const DEFAULT_TTL_HOURS = 6;

/**
 * @typedef {object} ProjectResources
 * @property {string} project the Compose project name
 * @property {number | undefined} createdAt when its oldest container was created (ms since the epoch), or undefined
 *   when only volumes or networks are left
 */

/**
 * The projects to remove: the harness's own (named `adt-...`), older than `ttlHours` or with no container left; or,
 * with `runId` and `force`, that run's project whatever its age.
 * @param {readonly ProjectResources[]} projects
 * @param {{ now: number, ttlHours: number, runId?: string, force?: boolean }} options
 * @returns {{ project: string, reason: string }[]}
 */
export function expiredProjects(projects, options) {
	const chosen = [];
	for (const { project, createdAt } of projects) {
		if (!project.startsWith(PROJECT_PREFIX)) continue;
		if (options.runId !== undefined) {
			if (project !== `${PROJECT_PREFIX}${options.runId}`) continue;
			if (options.force === true) {
				chosen.push({ project, reason: "named with --run-id and --force" });
				continue;
			}
		}
		if (createdAt === undefined) chosen.push({ project, reason: "no container is left, only volumes or networks" });
		else {
			const ageHours = (options.now - createdAt) / 3_600_000;
			if (ageHours > options.ttlHours)
				chosen.push({
					project,
					reason: `started ${ageHours.toFixed(1)} h ago, past the ${options.ttlHours} h limit`,
				});
		}
	}
	return chosen;
}

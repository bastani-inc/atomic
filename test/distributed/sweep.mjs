#!/usr/bin/env node
// @ts-check
/**
 * Removes what distributed-test runs left in Docker (docs/distributed-tests.md): the containers, volumes and networks
 * of every Compose project named `adt-...` that is older than the limit, or that has only volumes or networks left.
 *
 *   node test/distributed/sweep.mjs [--dry-run] [--ttl-hours <n>]
 *   node test/distributed/sweep.mjs --run-id <id> --force
 */
import { execFileSync } from "node:child_process";
import { DEFAULT_TTL_HOURS, expiredProjects } from "./harness/expiry.mjs";
import { leftovers } from "./harness/stack.mjs";

const LABEL = "com.docker.compose.project";

/** @param {string[]} args */
function docker(...args) {
	return execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** @param {string} format @param {string[]} command */
function listed(command, format) {
	return docker(...command, "--filter", `label=${LABEL}`, "--format", format)
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function projects() {
	/** @type {Map<string, number | undefined>} */
	const created = new Map();
	for (const line of listed(["ps", "--all"], `{{.Label "${LABEL}"}}\t{{.ID}}`)) {
		const [project, id] = line.split("\t");
		const at = Date.parse(docker("inspect", "--format", "{{.Created}}", id).trim());
		const previous = created.get(project);
		created.set(project, previous === undefined ? at : Math.min(previous, at));
	}
	for (const project of [
		...listed(["volume", "ls"], `{{.Label "${LABEL}"}}`),
		...listed(["network", "ls"], `{{.Label "${LABEL}"}}`),
	])
		if (!created.has(project)) created.set(project, undefined);
	return [...created].map(([project, createdAt]) => ({ project, createdAt }));
}

/** @param {string} project */
function remove(project) {
	const filter = `label=${LABEL}=${project}`;
	const ids = (/** @type {string[]} */ ...command) =>
		docker(...command, "--filter", filter, "--format", "{{.ID}}")
			.split("\n")
			.map((id) => id.trim())
			.filter(Boolean);
	const containers = ids("ps", "--all");
	if (containers.length > 0) docker("rm", "--force", "--volumes", ...containers);
	const volumes = ids("volume", "ls");
	if (volumes.length > 0) docker("volume", "rm", "--force", ...volumes);
	const networks = ids("network", "ls");
	if (networks.length > 0) docker("network", "rm", ...networks);
	return leftovers(project);
}

function main() {
	const argv = process.argv.slice(2);
	let dryRun = false;
	let force = false;
	let ttlHours = DEFAULT_TTL_HOURS;
	/** @type {string | undefined} */
	let runId;
	for (let index = 0; index < argv.length; index++) {
		const flag = argv[index];
		if (flag === "--dry-run") dryRun = true;
		else if (flag === "--force") force = true;
		else if (flag === "--ttl-hours") ttlHours = Number(argv[++index]);
		else if (flag === "--run-id") runId = argv[++index];
		else throw new Error(`unknown option ${flag}`);
	}
	if (!Number.isFinite(ttlHours) || ttlHours < 0) throw new Error("--ttl-hours needs a non-negative number");
	if (force && runId === undefined) throw new Error("--force needs --run-id");
	const chosen = expiredProjects(projects(), { now: Date.now(), ttlHours, runId, force });
	if (chosen.length === 0) process.stdout.write("Nothing to remove.\n");
	let failed = false;
	for (const { project, reason } of chosen) {
		if (dryRun) {
			process.stdout.write(`would remove ${project}: ${reason}\n`);
			continue;
		}
		const left = remove(project);
		if (left.length === 0) process.stdout.write(`removed ${project}: ${reason}\n`);
		else {
			failed = true;
			process.stdout.write(`could not remove all of ${project}: ${left.join(", ")}\n`);
		}
	}
	return failed ? 1 : 0;
}

try {
	process.exit(main());
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(2);
}

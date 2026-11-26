import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { minVersion } from "semver";
import { expect, test } from "vitest";
import { parse } from "yaml";

/**
 * The root package.json `engines.node` is the one source of the Node.js version: CI's setup-node steps and the
 * repository blueprint read it with `node-version-file`, and every published package declares the same floor.
 * A hard-coded `node-version` once let CI pick a cached Node 22.23.3, which rejects valid IPv6 proxy certificates.
 * That resolves to the newest Node.js release, so one unit-tests shard and one agent-suite shard also run on exactly the
 * floor, the oldest Node.js an npm install accepts.
 */

const root = fileURLToPath(new URL("../..", import.meta.url));

interface PackageManifest {
	readonly name: string;
	readonly private?: boolean;
	readonly engines?: { readonly node?: string };
}

interface WorkflowStep {
	readonly name?: string;
	readonly if?: string;
	readonly uses?: string;
	readonly with?: Record<string, string | number | boolean>;
}

interface MatrixEntry {
	readonly binary_platform?: string;
	readonly shard?: number;
	readonly shards?: number;
	readonly node?: string;
}

interface Workflow {
	readonly jobs: Record<
		string,
		{
			readonly steps?: readonly WorkflowStep[];
			readonly strategy?: {
				readonly matrix?: { readonly node?: readonly string[]; readonly include?: readonly MatrixEntry[] };
			};
		}
	>;
}

/** setup-node steps allowed an explicit version, each with the reason in the workflow beside it. */
const EXPLICIT_VERSION_STEPS = new Set([
	// Mintlify refuses Node 25 and later, so docs validation switches to the newest Node 24 release.
	"test.yml static-checks Node.js 24 for Mintlify",
]);

/** The jobs with one shard on exactly the engines.node floor, and the step that installs it. */
const FLOOR_JOBS = ["unit-tests", "agent-suite"];
const FLOOR_STEP = "Node.js at the engines.node floor";

function readJson<T>(path: string): T {
	return JSON.parse(readFileSync(join(root, path), "utf8")) as T;
}

const rootNodeEngine = readJson<PackageManifest>("package.json").engines?.node;
const nodeFloor = minVersion(String(rootNodeEngine))?.version;

test("the root package.json declares the Node.js floor", () => {
	assert.equal(typeof rootNodeEngine, "string");
});

test("every published package and its lockfile entry declare the root package.json's engines.node", () => {
	const lock = readJson<{ packages: Record<string, PackageManifest> }>("package-lock.json");
	assert.equal(lock.packages[""]?.engines?.node, rootNodeEngine, "package-lock.json root entry");
	const published = readdirSync(join(root, "packages"))
		.map((dir) => ({ dir, manifest: readJson<PackageManifest>(`packages/${dir}/package.json`) }))
		// The natives package declares the N-API support range that napi-rs generates for its native binding.
		.filter(({ manifest }) => manifest.private !== true && manifest.name !== "@bastani/atomic-natives");
	expect(published.length).toBeGreaterThan(0);
	for (const { dir, manifest } of published) {
		assert.equal(manifest.engines?.node, rootNodeEngine, `${manifest.name} engines.node`);
		assert.equal(lock.packages[`packages/${dir}`]?.engines?.node, rootNodeEngine, `package-lock.json ${dir}`);
	}
});

test("every setup-node step reads engines.node from a checked-out root package.json", () => {
	const workflowsDir = join(root, ".github/workflows");
	let checked = 0;
	for (const file of readdirSync(workflowsDir).filter((name) => name.endsWith(".yml"))) {
		const workflow = parse(readFileSync(join(workflowsDir, file), "utf8")) as Workflow;
		for (const [jobName, job] of Object.entries(workflow.jobs)) {
			const checkouts: string[] = [];
			for (const step of job.steps ?? []) {
				if (step.uses?.startsWith("actions/checkout@")) checkouts.push(String(step.with?.path ?? ""));
				if (!step.uses?.startsWith("actions/setup-node@")) continue;
				checked++;
				const where = `${file} ${jobName} ${step.name ?? step.uses}`;
				if (file === "test.yml" && FLOOR_JOBS.includes(jobName) && step.name === FLOOR_STEP) {
					assert.equal(step.with?.["node-version-file"], undefined, where);
					assert.equal(
						step.with?.["node-version"],
						nodeFloor,
						`${where} installs exactly the floor of engines.node`,
					);
					assert.equal(step.if, `matrix.node == '${nodeFloor}'`, `${where} runs only for the floor shard`);
					continue;
				}
				if (EXPLICIT_VERSION_STEPS.has(where)) {
					assert.equal(step.with?.["node-version-file"], undefined, where);
					assert.equal(
						minVersion(String(step.with?.["node-version"]))?.version,
						minVersion(String(rootNodeEngine))?.version,
						`${where} keeps the floor of engines.node`,
					);
					continue;
				}
				assert.equal(step.with?.["node-version"], undefined, `${where} must not hard-code node-version`);
				const versionFiles = checkouts.map((path) => (path === "" ? "package.json" : `${path}/package.json`));
				assert.ok(
					versionFiles.includes(String(step.with?.["node-version-file"])),
					`${where} must set node-version-file to the package.json of an earlier checkout (${versionFiles.join(", ") || "no checkout"})`,
				);
			}
		}
	}
	expect(checked).toBeGreaterThan(0);
});

test("unit-tests and agent-suite each run one Linux shard on exactly the engines.node floor", () => {
	const workflow = parse(readFileSync(join(root, ".github/workflows/test.yml"), "utf8")) as Workflow;
	for (const jobName of FLOOR_JOBS) {
		const job = workflow.jobs[jobName];
		assert.deepEqual(
			job?.strategy?.matrix?.node,
			["newest"],
			`${jobName} runs every other shard on the newest Node.js`,
		);
		const floorShards = (job?.strategy?.matrix?.include ?? []).filter((entry) => entry.node !== undefined);
		assert.equal(floorShards.length, 1, `${jobName} has one shard on another Node.js`);
		const [floorShard] = floorShards;
		assert.equal(floorShard?.node, nodeFloor, `${jobName}'s extra shard runs on the floor of engines.node`);
		assert.equal(floorShard?.binary_platform, "linux-x64", jobName);
		assert.ok(
			floorShard?.shard !== undefined && floorShard.shards !== undefined && floorShard.shard <= floorShard.shards,
			`${jobName}'s floor shard ${floorShard?.shard}/${floorShard?.shards} is one of the suite's shards`,
		);
		const setupNode = (job?.steps ?? []).filter((step) => step.uses?.startsWith("actions/setup-node@"));
		assert.deepEqual(
			setupNode.map((step) => step.if),
			["matrix.node == 'newest'", `matrix.node == '${nodeFloor}'`],
			`${jobName} installs the newest Node.js or the floor, never both`,
		);
		assert.equal(setupNode[1]?.name, FLOOR_STEP, jobName);
	}
});

test("the repository blueprint installs Node.js from package.json", () => {
	const blueprint = parse(readFileSync(join(root, ".atomic/blueprint.yaml"), "utf8")) as {
		readonly initialize: readonly WorkflowStep[];
	};
	const setupNode = blueprint.initialize.filter((step) => step.uses?.includes("/actions/setup-node@"));
	assert.equal(setupNode.length, 1);
	assert.equal(setupNode[0]?.with?.["node-version-file"], "package.json");
	assert.equal(setupNode[0]?.with?.["node-version"], undefined);
});

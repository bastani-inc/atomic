import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, test } from "vitest";
import { parse } from "yaml";
import { parseReleasePayloadPackages } from "../../scripts/release-npm-preflight.js";
import { spawnSyncCollect } from "../helpers/runtime.js";

/**
 * Executes publish.yml's own publication steps (their `run:` blocks and the
 * scripts under scripts/release they call) against fake `npm`, `gh` and `sleep`
 * executables from test/fixtures/release-cli-fakes. The fakes keep one npm
 * registry and one GitHub Release in a state directory and play scripted
 * failures, so each test reads as "this is what the registry or the API did".
 */

const root = fileURLToPath(new URL("../..", import.meta.url));
const workflowSource = readFileSync(join(root, ".github/workflows/publish.yml"), "utf8").replaceAll("\r\n", "\n");
const workflow = parse(workflowSource) as {
	jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }>;
};
const fakes = join(root, "test/fixtures/release-cli-fakes");
const payload = parseReleasePayloadPackages(workflowSource);
const nativeLeaves = payload.filter((name) => name.startsWith("@bastani/atomic-natives-"));
const ADAPTER = "@bastani/atomic-storage-libsql";
const VERSION = "1.2.3";

let workspaces: string[] = [];
afterEach(() => {
	for (const dir of workspaces) rmSync(dir, { recursive: true, force: true });
	workspaces = [];
});

interface StepRun {
	readonly exitCode: number;
	readonly output: string;
	readonly calls: readonly string[];
	readonly sleeps: readonly number[];
}

interface Release {
	readonly cwd: string;
	readonly state: string;
}

/** A job checkout: `release-tooling` is this repository, as the job's sparse checkout provides it. */
function release(): Release {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-release-recovery-"));
	workspaces.push(cwd);
	const state = join(cwd, "fake-state");
	mkdirSync(state);
	symlinkSync(root, join(cwd, "release-tooling"));
	for (const fake of ["npm", "gh", "sleep"]) chmodSync(join(fakes, fake), 0o755);
	return { cwd, state };
}

function stateKey(name: string): string {
	return name.replaceAll("/", "+");
}

/** Script what the fake registry or API does on successive calls; the last outcome repeats. */
function script(rel: Release, stem: string, outcomes: readonly string[]): void {
	writeFileSync(join(rel.state, `${stem}.outcomes`), `${outcomes.join("\n")}\n`);
}

function isPublished(rel: Release, name: string): boolean {
	return existsSync(join(rel.state, `published-${stateKey(name)}`));
}

/** The tarball file name `npm pack` gives a package of this release. */
function tarballFile(name: string): string {
	return `${name.replace(/^@/, "").replace("/", "-")}-${VERSION}.tgz`;
}

/** The twelve release tarballs, as the build job uploads them. */
function writeNpmPayload(rel: Release): void {
	const dir = join(rel.cwd, "payload/npm-packages");
	mkdirSync(dir, { recursive: true });
	for (const name of payload) {
		const stage = join(rel.cwd, "pack", stateKey(name), "package");
		mkdirSync(stage, { recursive: true });
		writeFileSync(join(stage, "package.json"), JSON.stringify({ name, version: VERSION }));
		const packed = spawnSyncCollect([
			"tar",
			"-czf",
			join(dir, tarballFile(name)),
			"-C",
			join(stage, ".."),
			"package",
		]);
		assert.equal(packed.exitCode, 0, packed.stderr.toString());
	}
}

/** Run one publish.yml step's `run:` block the way GitHub's default bash shell does. */
function runStep(rel: Release, job: string, stepName: string, env: Record<string, string>): StepRun {
	const step = workflow.jobs[job]?.steps.find((candidate) => candidate.name === stepName);
	assert.ok(step?.run, `publish.yml ${job} has no run step named ${stepName}`);
	const scriptPath = join(rel.cwd, `${job}.sh`);
	writeFileSync(scriptPath, step.run);
	const result = spawnSyncCollect(["bash", "--noprofile", "--norc", "-eo", "pipefail", scriptPath], {
		cwd: rel.cwd,
		env: {
			...process.env,
			PATH: `${fakes}${delimiter}${process.env.PATH ?? ""}`,
			RELEASE_FAKE_STATE: rel.state,
			...env,
		},
	});
	const lines = (file: string) =>
		existsSync(join(rel.state, file)) ? readFileSync(join(rel.state, file), "utf8").split("\n").filter(Boolean) : [];
	return {
		exitCode: result.exitCode,
		output: `${result.stdout.toString()}${result.stderr.toString()}`,
		calls: lines("calls.log"),
		sleeps: lines("sleep.log").map(Number),
	};
}

function publishNpm(rel: Release, npmTag = "latest"): StepRun {
	return runStep(rel, "publish-npm", "Publish native packages then coding agent", { VERSION, NPM_TAG: npmTag });
}

describe("publish-npm", () => {
	test("publishes the eight native leaves, then the native root, pi-ai, the libSQL adapter and atomic", () => {
		const rel = release();
		writeNpmPayload(rel);
		const run = publishNpm(rel);
		assert.equal(run.exitCode, 0, run.output);
		for (const name of payload) assert.ok(isPublished(rel, name), `${name} was not published`);
		const order = run.calls
			.filter((call) => call.startsWith("npm publish "))
			.map((call) => payload.find((name) => call.includes(`/${tarballFile(name)} `)));
		assert.deepEqual(order.slice(nativeLeaves.length), payload.slice(nativeLeaves.length));
		assert.deepEqual([...order.slice(0, nativeLeaves.length)].sort(), [...nativeLeaves].sort());
		assert.ok(
			run.calls.every((call) => !call.startsWith("npm ") || call.includes("--registry https://registry.npmjs.org")),
		);
	});

	test("refuses indeterminate package registration instead of silently skipping the adapter (#3857)", () => {
		for (const outcome of ["ETIMEDOUT", "E429", "E500", "killed-e404"]) {
			const rel = release();
			writeNpmPayload(rel);
			script(rel, `registration-${stateKey(ADAPTER)}`, [outcome]);
			const run = publishNpm(rel);
			assert.notEqual(run.exitCode, 0, `${outcome} must fail publication`);
			assert.equal(isPublished(rel, ADAPTER), false, outcome);
			assert.equal(isPublished(rel, "@bastani/atomic"), false, `${outcome}: atomic must not outrun the adapter`);
		}
	});

	test("skips only a confirmed-missing deferred name and publishes the rest (#3857)", () => {
		const rel = release();
		writeNpmPayload(rel);
		script(rel, `registration-${stateKey(ADAPTER)}`, ["e404"]);
		const run = publishNpm(rel);
		assert.equal(run.exitCode, 0, run.output);
		assert.match(run.output, /::warning::@bastani\/atomic-storage-libsql is not registered on npm yet; skipping it/);
		assert.equal(isPublished(rel, ADAPTER), false);
		assert.ok(isPublished(rel, "@bastani/atomic"));
	});
});

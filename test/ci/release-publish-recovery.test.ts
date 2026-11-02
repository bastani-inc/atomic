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

function registryVersions(rel: Release, name: string): string[] {
	const path = join(rel.state, `registry-${stateKey(name)}`);
	return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

function isPublished(rel: Release, name: string): boolean {
	return registryVersions(rel, name).includes(VERSION);
}

/** A version the fake registry already has; `unservable` means it was unpublished and can never be served again. */
function seedRegistry(rel: Release, name: string, version: string, options: { unservable?: boolean } = {}): void {
	writeFileSync(join(rel.state, `registry-${stateKey(name)}`), `${version}\n`, { flag: "a" });
	if (options.unservable) writeFileSync(join(rel.state, `hidden-${stateKey(name)}@${version}`), "forever\n");
}

function scriptPublish(rel: Release, name: string, outcomes: readonly string[]): void {
	script(rel, `publish-${stateKey(name)}`, outcomes);
}

/** The tarball file name `npm pack` gives a package of this release. */
function tarballFile(name: string): string {
	return `${name.replace(/^@/, "").replace("/", "-")}-${VERSION}.tgz`;
}

function publishAttempts(run: StepRun, name: string): number {
	return run.calls.filter((call) => call.startsWith("npm publish ") && call.includes(`/${tarballFile(name)} `)).length;
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

const RELEASE_ASSETS = [
	"atomic-darwin-arm64.tar.gz",
	"atomic-darwin-x64.tar.gz",
	"atomic-linux-x64.tar.gz",
	"atomic-linux-arm64.tar.gz",
	"atomic-linux-x64-musl.tar.gz",
	"atomic-linux-arm64-musl.tar.gz",
	"atomic-windows-x64.zip",
	"atomic-windows-arm64.zip",
	"SHA256SUMS",
];

function setRelease(rel: Release, state: "draft" | "published", assets: readonly string[] = RELEASE_ASSETS): void {
	writeFileSync(join(rel.state, "release.state"), `${state}\n`);
	writeFileSync(join(rel.state, "release.assets"), `${assets.join("\n")}\n`);
}

function releaseState(rel: Release): { state: string; assets: string[]; prerelease?: string; latest?: string } {
	const read = (file: string) => {
		const path = join(rel.state, file);
		return existsSync(path) ? readFileSync(path, "utf8").trim() : undefined;
	};
	return {
		state: read("release.state") ?? "missing",
		assets: (read("release.assets") ?? "").split("\n").filter(Boolean).sort(),
		prerelease: read("release.prerelease"),
		latest: read("release.latest"),
	};
}

function ghCalls(run: StepRun, command: string): number {
	return run.calls.filter((call) => call.startsWith(`gh release ${command} `)).length;
}

function assertCompleteDraft(rel: Release): void {
	const { state, assets } = releaseState(rel);
	assert.equal(state, "draft");
	assert.deepEqual(assets, [...RELEASE_ASSETS].sort());
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
	test("a native leaf whose provenance upload hits a transparency-log 409 is retried, and the release completes (#4217)", () => {
		// 0.9.66-alpha.1: seven leaves published, win32-x64-msvc failed with TLOG_CREATE_ENTRY_ERROR (409),
		// and the native root, pi-ai, the adapter and atomic were never published.
		const rel = release();
		writeNpmPayload(rel);
		const leaf = "@bastani/atomic-natives-win32-x64-msvc";
		scriptPublish(rel, leaf, ["tlog-409", "ok"]);
		const run = publishNpm(rel);
		assert.equal(run.exitCode, 0, run.output);
		for (const name of payload) assert.ok(isPublished(rel, name), `${name} was not published`);
		assert.equal(publishAttempts(run, leaf), 2);
		assert.equal(run.sleeps.length, 1);
	});
	test("a publish the registry stored but never confirmed counts as published when npm refuses to publish over it (#4217)", () => {
		// The retry's `npm view` can still miss a version the registry just stored, so the retried publish is refused.
		const rel = release();
		writeNpmPayload(rel);
		scriptPublish(rel, "@bastani/atomic", ["timeout-after-publish"]);
		const run = publishNpm(rel);
		assert.equal(run.exitCode, 0, run.output);
		assert.equal(publishAttempts(run, "@bastani/atomic"), 2);
		assert.match(run.output, /You cannot publish over the previously published versions/);
		assert.match(run.output, /@bastani\/atomic@1\.2\.3 is already on npm/);
	});
	test("a version npm refuses to publish over but never serves, such as an unpublished one, fails before any dependent (#4217)", () => {
		const rel = release();
		writeNpmPayload(rel);
		const leaf = "@bastani/atomic-natives-darwin-x64";
		seedRegistry(rel, leaf, VERSION, { unservable: true });
		const run = publishNpm(rel);
		assert.notEqual(run.exitCode, 0);
		assert.match(run.output, /does not serve it/);
		assert.match(run.output, /dependents were not published/);
		for (const name of payload.slice(nativeLeaves.length)) assert.equal(isPublished(rel, name), false, name);
	});

	test("another version of a package already on npm does not count as this release's", () => {
		const rel = release();
		writeNpmPayload(rel);
		seedRegistry(rel, "@bastani/atomic", "1.2.2");
		const run = publishNpm(rel);
		assert.equal(run.exitCode, 0, run.output);
		assert.deepEqual(registryVersions(rel, "@bastani/atomic"), ["1.2.2", VERSION]);
		assert.equal(publishAttempts(run, "@bastani/atomic"), 1);
	});

	test("transient npm failures are retried a bounded number of times with growing waits, then fail before any dependent (#4217)", () => {
		const rel = release();
		writeNpmPayload(rel);
		const leaf = "@bastani/atomic-natives-linux-x64-gnu";
		scriptPublish(rel, leaf, ["e500"]);
		const run = publishNpm(rel);
		assert.notEqual(run.exitCode, 0);
		assert.equal(publishAttempts(run, leaf), 4);
		assert.deepEqual(run.sleeps, [10, 20, 40]);
		assert.match(run.output, /dependents were not published/);
		for (const name of payload.slice(nativeLeaves.length)) assert.equal(isPublished(rel, name), false, name);
	});

	test("a permission error is not retried (#4217)", () => {
		const rel = release();
		writeNpmPayload(rel);
		scriptPublish(rel, "@bastani/pi-ai", ["e403"]);
		const run = publishNpm(rel);
		assert.notEqual(run.exitCode, 0);
		assert.equal(publishAttempts(run, "@bastani/pi-ai"), 1);
		assert.deepEqual(run.sleeps, []);
		assert.equal(isPublished(rel, "@bastani/atomic"), false);
	});
	test("publishes at most four native leaves at once (#4217)", () => {
		// Eight provenance uploads at once from one runner preceded both observed transparency-log 409s.
		const rel = release();
		writeNpmPayload(rel);
		for (const leaf of nativeLeaves) scriptPublish(rel, leaf, ["slow-ok"]);
		const run = publishNpm(rel);
		assert.equal(run.exitCode, 0, run.output);
		const inFlight = readFileSync(join(rel.state, "inflight.log"), "utf8").split("\n").filter(Boolean).map(Number);
		assert.equal(inFlight.length, nativeLeaves.length);
		assert.ok(Math.max(...inFlight) <= 4, `up to ${Math.max(...inFlight)} leaves published at once`);
		assert.ok(Math.max(...inFlight) >= 2, "leaves no longer publish in parallel");
	});
});

function publishGitHubRelease(rel: Release, tag: string): StepRun {
	return runStep(rel, "publish-github-release", "Publish staged GitHub Release", { RELEASE_TAG: tag });
}

describe("publish-github-release", () => {
	test("a transient GitHub API failure while undrafting is retried (#4217)", () => {
		// 0.9.66: npm had fully published when `gh release edit` got HTTP 500, and the release stayed a draft.
		for (const outcome of ["http-500", "http-502", "applied-http-500", "secondary-rate-limit"]) {
			const rel = release();
			setRelease(rel, "draft");
			script(rel, "gh-edit", [outcome, "ok"]);
			const run = publishGitHubRelease(rel, "1.2.3");
			assert.equal(run.exitCode, 0, `${outcome}: ${run.output}`);
			assert.deepEqual(releaseState(rel), {
				state: "published",
				assets: [...RELEASE_ASSETS].sort(),
				prerelease: "false",
				latest: "true",
			});
			assert.equal(run.sleeps.length, 1, outcome);
		}
	});
	test("re-running after an earlier attempt published the release succeeds without editing it again (#4217)", () => {
		const rel = release();
		setRelease(rel, "published");
		const run = publishGitHubRelease(rel, "1.2.3");
		assert.equal(run.exitCode, 0, run.output);
		assert.equal(ghCalls(run, "edit"), 0);
		assert.match(run.output, /already published/);
	});

	test("an alpha tag becomes a prerelease that is not marked latest", () => {
		const rel = release();
		setRelease(rel, "draft");
		const run = publishGitHubRelease(rel, "1.2.3-alpha.4");
		assert.equal(run.exitCode, 0, run.output);
		assert.deepEqual(releaseState(rel), {
			state: "published",
			assets: [...RELEASE_ASSETS].sort(),
			prerelease: "true",
			latest: "false",
		});
	});

	test("GitHub API failures that are not transient, or that persist, stop without publishing (#4217)", () => {
		const forbidden = release();
		setRelease(forbidden, "draft");
		script(forbidden, "gh-edit", ["http-403"]);
		const refused = publishGitHubRelease(forbidden, "1.2.3");
		assert.notEqual(refused.exitCode, 0);
		assert.equal(ghCalls(refused, "edit"), 1);
		assert.deepEqual(refused.sleeps, []);
		assert.equal(releaseState(forbidden).state, "draft");

		const down = release();
		setRelease(down, "draft");
		script(down, "gh-edit", ["http-500"]);
		const exhausted = publishGitHubRelease(down, "1.2.3");
		assert.notEqual(exhausted.exitCode, 0);
		assert.equal(ghCalls(exhausted, "edit"), 4);
		assert.deepEqual(exhausted.sleeps, [15, 30, 60]);
		assert.equal(releaseState(down).state, "draft");
	});

	test("an API that stays down while reading the release fails as an outage, not as a missing draft (#4217)", () => {
		const rel = release();
		setRelease(rel, "draft");
		script(rel, "gh-view", ["http-502"]);
		const run = publishGitHubRelease(rel, "1.2.3");
		assert.notEqual(run.exitCode, 0);
		assert.equal(ghCalls(run, "view"), 4);
		assert.equal(ghCalls(run, "edit"), 0);
		assert.doesNotMatch(run.output, /does not exist/);
		assert.match(run.output, /HTTP 502/);
	});

	test("a missing draft fails and says how to recover", () => {
		const rel = release();
		const run = publishGitHubRelease(rel, "1.2.3");
		assert.notEqual(run.exitCode, 0);
		assert.match(run.output, /gh workflow run publish\.yml --ref 1\.2\.3 -f tag=1\.2\.3/);
	});
});

/** The archives and notes the build and Windows jobs hand to staging. */
function stageGitHubRelease(rel: Release, tag: string): StepRun {
	const assets = join(rel.cwd, "release-assets");
	mkdirSync(assets, { recursive: true });
	for (const name of RELEASE_ASSETS.filter((asset) => asset !== "SHA256SUMS")) writeFileSync(join(assets, name), name);
	writeFileSync(join(assets, "RELEASE_NOTES.md"), "notes\n");
	return runStep(rel, "stage-github-release", "Validate and stage draft release", { RELEASE_TAG: tag });
}

describe("stage-github-release", () => {
	test("a transient failure reading the release is retried, not taken to mean there is none (#4217)", () => {
		// A re-run finds the draft its earlier attempt staged; a 500 on that lookup must not skip replacing it.
		const rel = release();
		setRelease(rel, "draft", ["atomic-linux-x64.tar.gz"]);
		script(rel, "gh-view", ["http-500", "ok"]);
		const run = stageGitHubRelease(rel, "1.2.3");
		assert.equal(run.exitCode, 0, run.output);
		assertCompleteDraft(rel);
		assert.equal(ghCalls(run, "delete"), 1);
	});

	test("a delete GitHub applied before answering 500 is not a failure (#4217)", () => {
		const rel = release();
		setRelease(rel, "draft", ["atomic-linux-x64.tar.gz"]);
		script(rel, "gh-delete", ["applied-http-500", "ok"]);
		const run = stageGitHubRelease(rel, "1.2.3");
		assert.equal(run.exitCode, 0, run.output);
		assertCompleteDraft(rel);
	});

	test("an upload that fails part-way is retried from a clean draft (#4217)", () => {
		const rel = release();
		script(rel, "gh-create", ["partial-upload", "ok"]);
		const run = stageGitHubRelease(rel, "1.2.3");
		assert.equal(run.exitCode, 0, run.output);
		assertCompleteDraft(rel);
		assert.equal(ghCalls(run, "create"), 2);
	});

	test("a failed upload is not retried while GitHub cannot say whether it left a draft, so no second draft appears", () => {
		const rel = release();
		script(rel, "gh-view", ["ok", "http-500"]);
		script(rel, "gh-create", ["partial-upload", "ok"]);
		const run = stageGitHubRelease(rel, "1.2.3");
		assert.notEqual(run.exitCode, 0);
		assert.equal(ghCalls(run, "create"), 1);
		assert.match(run.output, /not retrying/);
	});

	test("a delete whose outcome GitHub cannot report fails staging", () => {
		const rel = release();
		setRelease(rel, "draft", ["atomic-linux-x64.tar.gz"]);
		script(rel, "gh-view", ["ok", "http-500"]);
		script(rel, "gh-delete", ["applied-http-500", "http-500"]);
		const run = stageGitHubRelease(rel, "1.2.3");
		assert.notEqual(run.exitCode, 0);
		assert.equal(ghCalls(run, "create"), 0);
	});

	test("staging that keeps failing stops after bounded retries and leaves no partial draft", () => {
		const rel = release();
		script(rel, "gh-create", ["partial-upload"]);
		const run = stageGitHubRelease(rel, "1.2.3");
		assert.notEqual(run.exitCode, 0);
		assert.equal(ghCalls(run, "create"), 4);
		assert.deepEqual(run.sleeps, [15, 30, 60]);
		assert.equal(releaseState(rel).state, "missing");
	});

	test("refuses to touch a release that is already published", () => {
		const rel = release();
		setRelease(rel, "published");
		const run = stageGitHubRelease(rel, "1.2.3");
		assert.notEqual(run.exitCode, 0);
		assert.match(run.output, /already published\. Refusing to mutate a public release/);
		assert.equal(ghCalls(run, "delete") + ghCalls(run, "create"), 0);
	});
});

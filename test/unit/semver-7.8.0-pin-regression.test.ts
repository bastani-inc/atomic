import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compare, maxSatisfying, rcompare, satisfies, valid, validRange } from "semver";
import { afterEach, describe, test } from "vitest";
import {
	getLatestNpmVersion,
	installedNpmMatchesConfiguredVersion,
} from "../../packages/coding-agent/src/core/package-manager-npm.js";
import { parseSource } from "../../packages/coding-agent/src/core/package-manager-source.js";
import type {
	NpmSource,
	PackageManagerContext,
	PackageManagerDriver,
} from "../../packages/coding-agent/src/core/package-manager-types.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { moduleDir, readJson } from "../helpers/runtime.js";

/**
 * `semver` was downgraded 7.8.5 -> 7.8.0 so this repository carries upstream pi's
 * pin. Two of the fixes given up reach functions this repository actually calls:
 *
 *   7.8.1 - strip build metadata before comparator trimming (`satisfies`)
 *   7.8.4 - reject a numeric segment after an x-range (`validRange`)
 *
 * This file is the evidence that the downgrade changes nothing this repository
 * relies on. It does not rest on hand-written expectations alone: every case is
 * also run against a real 7.8.5 build and required to agree, so "unchanged" is
 * measured rather than recalled.
 *
 * The 7.8.5 build is the copy `@napi-rs/cli` pulls. That package declares
 * `semver@^7.8.2`, which 7.8.0 does not satisfy, so the lockfile keeps a nested
 * 7.8.5 beside the hoisted 7.8.0 - the differential baseline is a committed
 * lockfile fact, not a coincidence. If a future `@napi-rs/cli` moves off 7.8.5
 * this file fails loudly, and BASELINE_SEMVER_VERSION is what needs revisiting.
 */

const PINNED_SEMVER_VERSION = "7.8.0";
const BASELINE_SEMVER_VERSION = "7.8.5";

const root = join(moduleDir(import.meta.url), "../..");
const codingAgentDir = join(root, "packages/coding-agent");
const baselineSemverDir = join(root, "node_modules/@napi-rs/cli/node_modules/semver");
const requireFromTest = createRequire(import.meta.url);

/** The six functions this repository imports from `semver`, and nothing else. */
interface SemverApi {
	compare(a: string, b: string): number;
	maxSatisfying(versions: readonly string[], range: string): string | null;
	rcompare(a: string, b: string): number;
	satisfies(version: string, range: string): boolean;
	valid(version: string): string | null;
	validRange(range: string): string | null;
}

/** The instance the shipped code links against, imported the way the shipped code imports it. */
const pinned: SemverApi = { compare, maxSatisfying, rcompare, satisfies, valid, validRange };
const baseline: SemverApi = requireFromTest(baselineSemverDir) as SemverApi;

/** Versions in this project's own release shape, prereleases included. */
const PROJECT_SHAPED_VERSIONS = [
	"0.9.9",
	"0.9.10",
	"0.9.11-alpha.1",
	"0.9.11-alpha.8",
	"0.9.11",
	"0.10.0-alpha.1",
] as const;

/** Published versions carrying build metadata. */
const BUILD_METADATA_VERSIONS = ["1.2.3+build.1", "1.2.4+build.2", "1.3.0-rc.1+build.3", "2.0.0+build.4"] as const;

/**
 * Every range form this repository emits or consumes. Exact pins and carets are
 * what it writes itself (`docs/packages.md`, settings, self-update plans); the
 * rest are forms a user can type after `npm:<name>@`, which `parseSource` hands
 * straight to `validRange`. Dist-tags are included because they are the forms
 * that must keep resolving to "not a range".
 */
const REPOSITORY_RANGE_FORMS = [
	"1.2.3",
	"2.0.0",
	"v1.2.3",
	"=1.0.0",
	"^1.0.0",
	"^0.9.0",
	"~1.2.0",
	"1.x",
	"1.2.x",
	"0.9.x",
	"*",
	">=1.0.0 <2.0.0",
	"1.2.3 - 2.0.0",
	"1.0.0 || 2.0.0",
	"0.9.11-alpha.8",
	"^0.9.11-alpha.1",
	">=0.9.11-alpha.1 <0.10.0",
	"1.2.3+build.4",
	"latest",
	"beta",
	"next",
	"not-a-range",
] as const;

/** The normalized `validRange` output for each form above, at both builds. */
const REPOSITORY_RANGE_RESULTS = new Map<string, string | null>([
	["1.2.3", "1.2.3"],
	["2.0.0", "2.0.0"],
	["v1.2.3", "1.2.3"],
	["=1.0.0", "1.0.0"],
	["^1.0.0", ">=1.0.0 <2.0.0-0"],
	["^0.9.0", ">=0.9.0 <0.10.0-0"],
	["~1.2.0", ">=1.2.0 <1.3.0-0"],
	["1.x", ">=1.0.0 <2.0.0-0"],
	["1.2.x", ">=1.2.0 <1.3.0-0"],
	["0.9.x", ">=0.9.0 <0.10.0-0"],
	["*", "*"],
	[">=1.0.0 <2.0.0", ">=1.0.0 <2.0.0"],
	["1.2.3 - 2.0.0", ">=1.2.3 <=2.0.0"],
	["1.0.0 || 2.0.0", "1.0.0||2.0.0"],
	["0.9.11-alpha.8", "0.9.11-alpha.8"],
	["^0.9.11-alpha.1", ">=0.9.11-alpha.1 <0.10.0-0"],
	[">=0.9.11-alpha.1 <0.10.0", ">=0.9.11-alpha.1 <0.10.0"],
	["1.2.3+build.4", "1.2.3"],
	["latest", null],
	["beta", null],
	["next", null],
	["not-a-range", null],
]);

const tempDirs: string[] = [];
afterEach(async () => {
	for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "atomic-semver-pin-"));
	tempDirs.push(dir);
	return dir;
}

function driverMethodNotUsed(name: string): never {
	throw new Error(`package-manager driver.${name} must not be called by this test`);
}

/** A driver that answers `npm view <spec> version --json` and refuses everything else. */
function npmViewDriver(versions: readonly string[], calls: string[]): PackageManagerDriver {
	return {
		runCommand: () => driverMethodNotUsed("runCommand"),
		runCommandCapture: (command, args) => {
			calls.push([command, ...args].join(" "));
			return Promise.resolve(JSON.stringify(versions));
		},
		runCommandSync: () => driverMethodNotUsed("runCommandSync"),
		installParsedSource: () => driverMethodNotUsed("installParsedSource"),
		updateGit: () => driverMethodNotUsed("updateGit"),
		gitHasAvailableUpdate: () => driverMethodNotUsed("gitHasAvailableUpdate"),
		refreshTemporaryGitSource: () => driverMethodNotUsed("refreshTemporaryGitSource"),
		getLocalGitUpdateTarget: () => driverMethodNotUsed("getLocalGitUpdateTarget"),
		getGlobalNpmRoot: () => driverMethodNotUsed("getGlobalNpmRoot"),
		parseSource: () => driverMethodNotUsed("parseSource"),
		getPackageIdentity: () => driverMethodNotUsed("getPackageIdentity"),
		getGitInstallPath: () => driverMethodNotUsed("getGitInstallPath"),
		getLatestNpmVersion: () => driverMethodNotUsed("getLatestNpmVersion"),
	};
}

async function npmContext(versions: readonly string[], calls: string[]): Promise<PackageManagerContext> {
	const cwd = await tempDir();
	const agentDir = join(cwd, "agent");
	await mkdir(agentDir, { recursive: true });
	return {
		cwd,
		agentDir,
		settingsManager: SettingsManager.create(cwd, agentDir, { projectTrusted: true }),
		driver: npmViewDriver(versions, calls),
	};
}

function parseNpmSource(spec: string): NpmSource {
	const parsed = parseSource(spec);
	if (parsed.type !== "npm") throw new Error(`${spec} did not parse as an npm source`);
	return parsed;
}

/** An installed package directory whose manifest declares `version`. */
async function installedPackage(version: string): Promise<string> {
	const dir = await tempDir();
	await writeFile(join(dir, "package.json"), JSON.stringify({ name: "example", version }));
	return dir;
}

describe("semver pinned at 7.8.0", () => {
	test("the shipped code and this test link against the same 7.8.0 build, beside a real 7.8.5", async () => {
		assert.equal(
			requireFromTest.resolve("semver", { paths: [codingAgentDir] }),
			requireFromTest.resolve("semver"),
			"this test must exercise the same semver instance packages/coding-agent resolves",
		);

		const pinnedManifest = await readJson<{ version: string }>(join(root, "node_modules/semver/package.json"));
		assert.equal(pinnedManifest.version, PINNED_SEMVER_VERSION);

		const baselineManifest = await readJson<{ version: string }>(join(baselineSemverDir, "package.json"));
		assert.equal(
			baselineManifest.version,
			BASELINE_SEMVER_VERSION,
			"the differential baseline moved; re-derive this file's expectations against the new version",
		);
	});

	test("prerelease resolution over this project's own version shape is unchanged", async () => {
		const versions = [...PROJECT_SHAPED_VERSIONS];

		// No range: `getLatestNpmVersion` sorts with rcompare and takes the head.
		const calls: string[] = [];
		const context = await npmContext(versions, calls);
		assert.equal(await getLatestNpmVersion(context, "example"), "0.10.0-alpha.1");
		assert.deepEqual(calls, ["npm view example version --json"]);
		assert.equal([...versions].sort(pinned.rcompare)[0], [...versions].sort(baseline.rcompare)[0]);

		// With a range: maxSatisfying, never with includePrerelease, so a caret over
		// a stable release keeps ignoring 0.9.11-alpha.8 while an explicit prerelease
		// floor admits that line.
		const selections = new Map([
			["^0.9.0", "0.9.11"],
			["0.9.x", "0.9.11"],
			["*", "0.9.11"],
			["0.9.11-alpha.8", "0.9.11-alpha.8"],
			["^0.9.11-alpha.1", "0.9.11"],
			["~0.9.11-alpha.1", "0.9.11"],
			["^0.10.0-alpha.1", "0.10.0-alpha.1"],
			[">=0.9.11-alpha.1 <0.10.0", "0.9.11"],
		]);
		for (const [range, selected] of selections) {
			const rangeCalls: string[] = [];
			const rangeContext = await npmContext(versions, rangeCalls);
			assert.equal(await getLatestNpmVersion(rangeContext, "example", range), selected, range);
			assert.equal(pinned.maxSatisfying(versions, range), selected, range);
			assert.equal(baseline.maxSatisfying(versions, range), selected, `${range} at ${BASELINE_SEMVER_VERSION}`);
		}
	});

	test("build metadata in satisfies and maxSatisfying is unchanged", async () => {
		const versions = [...BUILD_METADATA_VERSIONS];
		const selections = new Map([
			["^1.2.0", "1.2.4+build.2"],
			["^1.2.3+build.1", "1.2.4+build.2"],
			["1.2.3+build.1", "1.2.3+build.1"],
			["~1.2.3", "1.2.4+build.2"],
			[">=1.2.3+build.1 <2.0.0", "1.2.4+build.2"],
			["*", "2.0.0+build.4"],
		]);
		for (const [range, selected] of selections) {
			assert.equal(pinned.maxSatisfying(versions, range), selected, range);
			assert.equal(baseline.maxSatisfying(versions, range), selected, `${range} at ${BASELINE_SEMVER_VERSION}`);
			for (const version of versions) {
				assert.equal(
					pinned.satisfies(version, range),
					baseline.satisfies(version, range),
					`satisfies(${version}, ${range})`,
				);
			}
		}

		// The door: an installed package whose manifest version carries build
		// metadata still matches the configured range.
		const installedPath = await installedPackage("1.2.3+build.1");
		const calls: string[] = [];
		const context = await npmContext(versions, calls);
		for (const [range, matches] of [
			["^1.2.0", true],
			["1.2.3+build.1", true],
			["^1.2.3+build.1", true],
			["^2.0.0", false],
		] as const) {
			const source = parseNpmSource(`npm:example@${range}`);
			assert.equal(await installedNpmMatchesConfiguredVersion(context, source, installedPath), matches, range);
		}
		assert.deepEqual(calls, [], "a configured range must be answered without reaching the registry");
	});

	test("validRange over every range form this repository emits and consumes is unchanged", () => {
		assert.equal(REPOSITORY_RANGE_RESULTS.size, REPOSITORY_RANGE_FORMS.length);

		for (const form of REPOSITORY_RANGE_FORMS) {
			const normalized = REPOSITORY_RANGE_RESULTS.get(form) ?? null;
			assert.equal(pinned.validRange(form), normalized, form);
			assert.equal(baseline.validRange(form), normalized, `${form} at ${BASELINE_SEMVER_VERSION}`);

			// The door: `parseSource` is what actually reaches validRange and valid.
			const source = parseNpmSource(`npm:example@${form}`);
			assert.equal(source.range, normalized ?? undefined, `parseSource range for ${form}`);
			assert.equal(source.pinned, pinned.valid(form) !== null, `parseSource pinned for ${form}`);
			assert.equal(
				source.pinned,
				baseline.valid(form) !== null,
				`parseSource pinned for ${form} at ${BASELINE_SEMVER_VERSION}`,
			);
		}

		// A bare name carries no version, so validRange is never reached with "".
		const bare = parseNpmSource("npm:example");
		assert.equal(bare.version, undefined);
		assert.equal(bare.range, undefined);
		assert.equal(bare.pinned, false);
	});

	test("the one behaviour 7.8.0 gives up is a form this repository never emits", () => {
		// 7.8.4 rejects a numeric segment after an x-range. At 7.8.0 it is still
		// accepted, read as the x-range with the trailing segment dropped. Across
		// every case in this file that is the entire measured difference.
		const acceptedOnlyAtPinnedVersion = new Map([
			["1.x.3", ">=1.0.0 <2.0.0-0"],
			["1.x.2", ">=1.0.0 <2.0.0-0"],
			["1.X.4", ">=1.0.0 <2.0.0-0"],
			["0.x.9", "<1.0.0-0"],
		]);
		for (const [form, normalized] of acceptedOnlyAtPinnedVersion) {
			assert.equal(pinned.validRange(form), normalized, form);
			assert.equal(baseline.validRange(form), null, `${form} at ${BASELINE_SEMVER_VERSION}`);
			assert.equal(REPOSITORY_RANGE_RESULTS.has(form), false, `${form} must not be a form this repository emits`);
		}

		// Reachable only if a user types it after `npm:<name>@`. Nothing this
		// repository writes has that shape, so no emitted form depends on the pin.
		for (const form of REPOSITORY_RANGE_FORMS) {
			assert.equal(pinned.validRange(form), baseline.validRange(form), `${form} must not depend on the semver pin`);
		}
	});
});

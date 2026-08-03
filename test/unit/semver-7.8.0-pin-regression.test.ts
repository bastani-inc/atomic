import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Comparator,
	compare,
	maxSatisfying,
	minVersion,
	Range,
	rcompare,
	satisfies,
	subset,
	valid,
	validRange,
} from "semver";
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
 * relies on. It does not rest on hand-written expectations: every `BASELINE_*`
 * table below was *measured* against a real semver 7.8.5 build, so "unchanged"
 * means the pinned build reproduces recorded 7.8.5 output, case for case.
 *
 * The baseline is recorded rather than linked because the shipped surface has
 * only one build to run against: the root `overrides` entry collapses every edge
 * that reaches shipped code onto 7.8.0, and `package-lock.json` resolves exactly
 * one `semver` node there, which the first test asserts. The single node beside
 * it is the build-only copy `@napi-rs/cli` keeps — nested beside
 * `packages/natives` since the 3.8.1 bump — so no edge in this tree resolves
 * below its declared range; that copy is 7.8.5, so the last test runs the CLI's
 * own semver surface against the real baseline rather than a recorded table. To
 * re-record the shipped-surface tables after a future pin move, unpack the
 * baseline outside this tree and replay the same calls against it:
 *
 *   npm pack semver@7.8.5 --pack-destination "$TMPDIR"
 *   tar -xzf "$TMPDIR/semver-7.8.5.tgz" -C "$TMPDIR"
 *   node -e "const baseline = require('$TMPDIR/package')"   # then replay each call below against it
 */

const PINNED_SEMVER_VERSION = "7.8.0";
const BASELINE_SEMVER_VERSION = "7.8.5";

const root = join(moduleDir(import.meta.url), "../..");
const codingAgentDir = join(root, "packages/coding-agent");
const requireFromTest = createRequire(import.meta.url);

/** The three manifest shapes this file reads. */
interface Manifest {
	version: string;
}

interface CliManifest {
	dependencies: Record<string, string>;
}

interface Lockfile {
	packages: Record<string, { version: string; dependencies?: Record<string, string> }>;
}

/** Every package in `lockfile` that declares a `semver` dependency, with the range it declares. */
function semverEdges(lockfile: Lockfile): [declarer: string, range: string][] {
	return Object.entries(lockfile.packages).flatMap(([path, node]) => {
		const range = node.dependencies?.semver;
		return range ? [[path, range] as [string, string]] : [];
	});
}

/** The `semver` node `declarer` resolves, walking outward the way node does. */
function resolvedSemverFor(lockfile: Lockfile, declarer: string): string | undefined {
	for (let prefix = declarer; ; ) {
		const candidate = prefix === "" ? "node_modules/semver" : `${prefix}/node_modules/semver`;
		const node = lockfile.packages[candidate];
		if (node) return node.version;
		if (prefix === "") return undefined;
		const cut = prefix.lastIndexOf("/node_modules/");
		prefix = cut === -1 ? "" : prefix.slice(0, cut);
	}
}

/**
 * The one edge the pin moves outside its declared range, and it moves it *up*.
 * `cross-spawn@6`, reached through `shx -> shelljs -> execa`, asks for `^5.5.0`;
 * its only semver call is `satisfies(process.version, "^4.8.0 || ^5.7.0 || >=
 * 6.0.0", true)`, which 7.8.0 answers identically — a boolean third argument
 * still parses as `loose` — and it is wrapped in `niceTry` regardless. Raising
 * an edge is a choice; holding one below its floor is the defect this table
 * exists to keep out.
 */
const RAISED_SEMVER_EDGES = new Map<string, string>([["node_modules/execa/node_modules/cross-spawn", "^5.5.0"]]);

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

/**
 * `@napi-rs/cli` 3.8.1 declares `semver@^7.8.2`, which the pin does not satisfy.
 * A flat `semver` override held it below that range and `npm ls` reported the
 * edge invalid, so the override is scoped instead: everything collapses onto
 * 7.8.0 except the CLI, which keeps 7.8.5. The CLI is a build-time
 * devDependency of `packages/natives`, reaches no shipped code and is absent
 * from the published shrinkwrap, so the second copy costs the pin nothing.
 * Since 3.8.1 npm nests the CLI and that copy under
 * `packages/natives/node_modules` rather than hoisting them to the root.
 *
 * That the two builds agree is measured rather than assumed. The CLI imports
 * exactly `Comparator`, `Range`, `minVersion` and `subset`, and reaches all four
 * from one function — `restrictWasiNodeEngine`, which narrows a package's
 * `engines.node` to the WASI-supported Node.js lines. At 3.8.1 that function
 * raised its floor from `>=14.0.0` to the supported-line union below,
 * intersects every comparator set of the declared range with every supported
 * set, stabilizes prerelease comparators first, and throws instead of silently
 * flooring when nothing intersects. `MINIMUM_WASI_NODE_VERSION` and the body
 * below are transcribed from
 * `packages/natives/node_modules/@napi-rs/cli/dist/index.js`, and the last
 * test drives it over both builds.
 *
 * Both of the 7.8.0 -> 7.8.2 changes land in code this function runs — `subset`
 * switched to `c.test(...)` from `satisfies(..., String(c))`, and `Range` gained
 * build-metadata stripping — so this is where a real difference would appear.
 */
const MINIMUM_WASI_NODE_VERSION = "^20.19.0 || ^22.13.0 || >=23.5.0";

/** The four `semver` entry points `@napi-rs/cli` imports, and nothing else. */
type NapiSemverApi = Pick<typeof import("semver"), "Comparator" | "Range" | "minVersion" | "subset">;

/** The pinned build, and the build `@napi-rs/cli` itself resolves. */
const pinnedNapiSurface: NapiSemverApi = { Comparator, Range, minVersion, subset };
const napiCliSemver = requireFromTest(
	requireFromTest.resolve("semver", { paths: [join(root, "packages/natives/node_modules/@napi-rs/cli")] }),
) as NapiSemverApi;

function restrictWasiNodeEngine(semverBuild: NapiSemverApi, nodeRange: string): string {
	const {
		Comparator: BuildComparator,
		Range: BuildRange,
		minVersion: buildMinVersion,
		subset: buildSubset,
	} = semverBuild;

	function stabilizePrereleaseComparator(comparator: Comparator): Comparator {
		if (comparator.semver.prerelease.length === 0) return comparator;
		const stableVersion = `${comparator.semver.major}.${comparator.semver.minor}.${comparator.semver.patch}`;
		if (comparator.operator === ">" || comparator.operator === ">=") return new BuildComparator(`>=${stableVersion}`);
		if (comparator.operator === "<" || comparator.operator === "<=")
			return new BuildComparator(`<${stableVersion}-0`);
		return comparator;
	}

	function normalizeComparatorSet(comparators: readonly Comparator[]): string | undefined {
		const exactMatch = comparators.find(({ operator }) => operator === "");
		if (exactMatch) {
			return comparators.every((comparator) => comparator.test(exactMatch.semver)) ? exactMatch.value : undefined;
		}
		let lowerBound: Comparator | undefined;
		let upperBound: Comparator | undefined;
		for (const rawComparator of comparators) {
			const comparator = stabilizePrereleaseComparator(rawComparator);
			if (comparator.operator === ">" || comparator.operator === ">=") {
				if (
					!lowerBound ||
					comparator.semver.compare(lowerBound.semver) > 0 ||
					(comparator.semver.compare(lowerBound.semver) === 0 && comparator.operator === ">")
				) {
					lowerBound = comparator;
				}
			} else if (comparator.operator === "<" || comparator.operator === "<=") {
				if (
					!upperBound ||
					comparator.semver.compare(upperBound.semver) < 0 ||
					(comparator.semver.compare(upperBound.semver) === 0 && comparator.operator === "<")
				) {
					upperBound = comparator;
				}
			}
		}
		return [lowerBound?.value, upperBound?.value].filter(Boolean).join(" ");
	}

	try {
		if (buildSubset(nodeRange, MINIMUM_WASI_NODE_VERSION)) return nodeRange;
		if (buildSubset(MINIMUM_WASI_NODE_VERSION, nodeRange)) return MINIMUM_WASI_NODE_VERSION;
		const supportedRangeSets = new BuildRange(MINIMUM_WASI_NODE_VERSION).set;
		const restrictedRangeSets = new BuildRange(nodeRange).set
			.flatMap((comparators) =>
				supportedRangeSets.map((supportedComparators) =>
					normalizeComparatorSet([...comparators, ...supportedComparators]),
				),
			)
			.filter((candidate) => candidate !== undefined && buildMinVersion(candidate) !== null);
		if (restrictedRangeSets.length > 0) return restrictedRangeSets.join(" || ");
	} catch {
		return MINIMUM_WASI_NODE_VERSION;
	}
	throw new Error(`Cannot restrict engines.node "${nodeRange}" to the Node.js versions supported by WASI packages`);
}

/**
 * `restrictWasiNodeEngine(range)` at 7.8.5, for every `engines.node` this
 * repository declares plus the WASI minimum itself. 7.8.0 was measured
 * alongside and agrees with every entry, so the pinned build and the build the
 * CLI resolves answer each of them the same way.
 */
const BASELINE_NAPI_WASI_ENGINE = new Map<string, string>([
	[">= 12.22.0 < 13 || >= 14.17.0 < 15 || >= 15.12.0 < 16 || >= 16.0.0", "^20.19.0 || ^22.13.0 || >=23.5.0"],
	["^20.19.0 || ^22.13.0 || >=23.5.0", "^20.19.0 || ^22.13.0 || >=23.5.0"],
	[">=22.19.0", ">=22.19.0 <23.0.0-0 || >=23.5.0"],
	[">=14.0.0", "^20.19.0 || ^22.13.0 || >=23.5.0"],
	[">=18", "^20.19.0 || ^22.13.0 || >=23.5.0"],
]);

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

/** `rcompare` head of PROJECT_SHAPED_VERSIONS at 7.8.5. */
const BASELINE_PROJECT_RCOMPARE_HEAD = "0.10.0-alpha.1";

/** `maxSatisfying(PROJECT_SHAPED_VERSIONS, range)` at 7.8.5. */
const BASELINE_PROJECT_MAX_SATISFYING = new Map<string, string | null>([
	["^0.9.0", "0.9.11"],
	["0.9.x", "0.9.11"],
	["*", "0.9.11"],
	["0.9.11-alpha.8", "0.9.11-alpha.8"],
	["^0.9.11-alpha.1", "0.9.11"],
	["~0.9.11-alpha.1", "0.9.11"],
	["^0.10.0-alpha.1", "0.10.0-alpha.1"],
	[">=0.9.11-alpha.1 <0.10.0", "0.9.11"],
]);

/** `maxSatisfying(BUILD_METADATA_VERSIONS, range)` at 7.8.5. */
const BASELINE_BUILD_METADATA_MAX_SATISFYING = new Map<string, string | null>([
	["^1.2.0", "1.2.4+build.2"],
	["^1.2.3+build.1", "1.2.4+build.2"],
	["1.2.3+build.1", "1.2.3+build.1"],
	["~1.2.3", "1.2.4+build.2"],
	[">=1.2.3+build.1 <2.0.0", "1.2.4+build.2"],
	["*", "2.0.0+build.4"],
]);

/** `satisfies(version, range)` at 7.8.5, one flag per BUILD_METADATA_VERSIONS entry, in order. */
const BASELINE_BUILD_METADATA_SATISFIES = new Map<string, readonly boolean[]>([
	["^1.2.0", [true, true, false, false]],
	["^1.2.3+build.1", [true, true, false, false]],
	["1.2.3+build.1", [true, false, false, false]],
	["~1.2.3", [true, true, false, false]],
	[">=1.2.3+build.1 <2.0.0", [true, true, false, false]],
	["*", [true, true, false, true]],
]);

/** `validRange(form)` at 7.8.5 for each form above. */
const BASELINE_RANGE_VALID_RANGE = new Map<string, string | null>([
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

/** `valid(form)` at 7.8.5 for each form above - what `parseSource` reads as "pinned". */
const BASELINE_RANGE_VALID = new Map<string, string | null>([
	["1.2.3", "1.2.3"],
	["2.0.0", "2.0.0"],
	["v1.2.3", "1.2.3"],
	["=1.0.0", null],
	["^1.0.0", null],
	["^0.9.0", null],
	["~1.2.0", null],
	["1.x", null],
	["1.2.x", null],
	["0.9.x", null],
	["*", null],
	[">=1.0.0 <2.0.0", null],
	["1.2.3 - 2.0.0", null],
	["1.0.0 || 2.0.0", null],
	["0.9.11-alpha.8", "0.9.11-alpha.8"],
	["^0.9.11-alpha.1", null],
	[">=0.9.11-alpha.1 <0.10.0", null],
	["1.2.3+build.4", "1.2.3"],
	["latest", null],
	["beta", null],
	["next", null],
	["not-a-range", null],
]);

/**
 * A numeric segment after an x-range: accepted at 7.8.0, rejected at 7.8.5 by the
 * 7.8.4 fix. Measured at both builds; the value here is the 7.8.0 reading, and
 * 7.8.5 returned `null` for every one.
 */
const XRANGE_NUMERIC_TAIL_AT_PINNED_VERSION = new Map<string, string | null>([
	["1.x.3", ">=1.0.0 <2.0.0-0"],
	["1.x.2", ">=1.0.0 <2.0.0-0"],
	["1.X.4", ">=1.0.0 <2.0.0-0"],
	["0.x.9", "<1.0.0-0"],
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

/** Recorded 7.8.5 output for `key`, or a failure naming the table that is missing it. */
function baselineFor<T>(table: Map<string, T>, key: string, tableName: string): T {
	const recorded = table.get(key);
	if (recorded === undefined) {
		throw new Error(`${tableName} has no recorded ${BASELINE_SEMVER_VERSION} value for ${key}`);
	}
	return recorded;
}

describe("semver pinned at 7.8.0", () => {
	test("one semver reaches shipped code, at 7.8.0, and the shipped code links against it", async () => {
		assert.equal(
			requireFromTest.resolve("semver", { paths: [codingAgentDir] }),
			requireFromTest.resolve("semver"),
			"this test must exercise the same semver instance packages/coding-agent resolves",
		);

		const pinnedManifest = await readJson<Manifest>(join(root, "node_modules/semver/package.json"));
		assert.equal(pinnedManifest.version, PINNED_SEMVER_VERSION);

		// The root `overrides` entry is what collapses the tree; without it a
		// transitive range nests a second build beside the pin and the downgrade
		// stops being a downgrade. The one node beside it is the build-only copy
		// `@napi-rs/cli` needs to stay inside its declared range — it sits beside
		// `packages/natives`, whose manifest declares no semver edge, and the
		// published shrinkwrap does not carry it.
		const lockfile = await readJson<Lockfile>(join(root, "package-lock.json"));
		const resolved = Object.entries(lockfile.packages)
			.filter(([path]) => path.split("node_modules/").pop() === "semver")
			.map(([path, node]) => `${path}@${node.version}`);
		assert.deepEqual(
			resolved,
			[
				`node_modules/semver@${PINNED_SEMVER_VERSION}`,
				`packages/natives/node_modules/semver@${BASELINE_SEMVER_VERSION}`,
			],
			"package-lock.json must resolve the pinned semver plus the build-only copy, and nothing else",
		);
	});

	test("prerelease resolution over this project's own version shape is unchanged", async () => {
		const versions = [...PROJECT_SHAPED_VERSIONS];

		// No range: `getLatestNpmVersion` sorts with rcompare and takes the head.
		const calls: string[] = [];
		const context = await npmContext(versions, calls);
		assert.equal(await getLatestNpmVersion(context, "example"), BASELINE_PROJECT_RCOMPARE_HEAD);
		assert.deepEqual(calls, ["npm view example version --json"]);
		assert.equal([...versions].sort(pinned.rcompare)[0], BASELINE_PROJECT_RCOMPARE_HEAD);

		// With a range: maxSatisfying, never with includePrerelease, so a caret over
		// a stable release keeps ignoring 0.9.11-alpha.8 while an explicit prerelease
		// floor admits that line.
		for (const [range, selected] of BASELINE_PROJECT_MAX_SATISFYING) {
			const rangeCalls: string[] = [];
			const rangeContext = await npmContext(versions, rangeCalls);
			assert.equal(await getLatestNpmVersion(rangeContext, "example", range), selected, range);
			assert.equal(pinned.maxSatisfying(versions, range), selected, range);
		}
	});

	test("build metadata in satisfies and maxSatisfying is unchanged", async () => {
		const versions = [...BUILD_METADATA_VERSIONS];
		for (const [range, selected] of BASELINE_BUILD_METADATA_MAX_SATISFYING) {
			assert.equal(pinned.maxSatisfying(versions, range), selected, range);
			const recorded = baselineFor(BASELINE_BUILD_METADATA_SATISFIES, range, "BASELINE_BUILD_METADATA_SATISFIES");
			assert.deepEqual(
				versions.map((version) => pinned.satisfies(version, range)),
				[...recorded],
				`satisfies over ${range}`,
			);
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
		assert.equal(BASELINE_RANGE_VALID_RANGE.size, REPOSITORY_RANGE_FORMS.length);
		assert.equal(BASELINE_RANGE_VALID.size, REPOSITORY_RANGE_FORMS.length);

		for (const form of REPOSITORY_RANGE_FORMS) {
			const normalized = baselineFor(BASELINE_RANGE_VALID_RANGE, form, "BASELINE_RANGE_VALID_RANGE");
			const exact = baselineFor(BASELINE_RANGE_VALID, form, "BASELINE_RANGE_VALID");
			assert.equal(pinned.validRange(form), normalized, form);
			assert.equal(pinned.valid(form), exact, form);

			// The door: `parseSource` is what actually reaches validRange and valid.
			const source = parseNpmSource(`npm:example@${form}`);
			assert.equal(source.range, normalized ?? undefined, `parseSource range for ${form}`);
			assert.equal(source.pinned, exact !== null, `parseSource pinned for ${form}`);
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
		for (const [form, normalized] of XRANGE_NUMERIC_TAIL_AT_PINNED_VERSION) {
			assert.equal(pinned.validRange(form), normalized, form);
			assert.equal(BASELINE_RANGE_VALID_RANGE.has(form), false, `${form} must not be a form this repository emits`);
		}
	});

	test("no semver edge resolves below its declared range, and both builds answer the CLI alike", async () => {
		// @napi-rs/cli asks for ^7.8.2 and the scoped override gives it 7.8.5.
		// Delete that scope and it drops to 7.8.0, `npm ls` reports the edge
		// invalid again, and this fails.
		const napiManifest = await readJson<CliManifest>(
			join(root, "packages/natives/node_modules/@napi-rs/cli/package.json"),
		);
		const napiSemverManifest = await readJson<Manifest>(
			join(root, "packages/natives/node_modules/semver/package.json"),
		);
		assert.equal(napiSemverManifest.version, BASELINE_SEMVER_VERSION);
		assert.ok(
			pinned.satisfies(napiSemverManifest.version, napiManifest.dependencies.semver),
			`@napi-rs/cli resolves semver ${napiSemverManifest.version}, below its declared ${napiManifest.dependencies.semver}`,
		);

		// Every semver edge in the tree, resolved the way npm resolves it. The
		// pin may raise an edge above its range; it may never hold one below.
		const lockfile = await readJson<Lockfile>(join(root, "package-lock.json"));
		for (const [declarer, range] of semverEdges(lockfile)) {
			const resolvedVersion = resolvedSemverFor(lockfile, declarer);
			assert.ok(resolvedVersion, `${declarer} declares semver ${range} but resolves no node`);
			if (pinned.satisfies(resolvedVersion, range)) continue;
			assert.equal(
				RAISED_SEMVER_EDGES.get(declarer),
				range,
				`${declarer} declares semver ${range} and resolves ${resolvedVersion}, which is not a recorded raise`,
			);
			const floor = minVersion(range);
			assert.ok(floor, `${range} has no floor to compare ${resolvedVersion} against`);
			assert.ok(
				pinned.compare(resolvedVersion, floor.version) > 0,
				`${declarer} is held below its declared ${range}, not above it`,
			);
		}

		// The CLI's own semver surface is restrictWasiNodeEngine. Both builds
		// reproduce the recorded 7.8.5 answer for every engines.node this
		// repository declares — including the four-clause range packages/natives
		// actually ships — so the scoped override is a contract repair rather
		// than a behaviour change.
		for (const [nodeRange, restricted] of BASELINE_NAPI_WASI_ENGINE) {
			assert.equal(restrictWasiNodeEngine(napiCliSemver, nodeRange), restricted, `${nodeRange} at the CLI's build`);
			assert.equal(restrictWasiNodeEngine(pinnedNapiSurface, nodeRange), restricted, `${nodeRange} at the pin`);
		}

		const natives = await readJson<{
			dependencies?: Record<string, string>;
			devDependencies: Record<string, string>;
			engines: { node: string };
			napi: { targets: string[] };
		}>(join(root, "packages/natives/package.json"));

		// The 7.8.5 copy now sits beside packages/natives, so the day that
		// package declares its own semver edge it starts resolving the CLI's
		// build instead of the pin. Keep that day loud.
		assert.equal(natives.dependencies?.semver, undefined, "packages/natives must not declare a semver dependency");
		assert.equal(natives.devDependencies.semver, undefined, "packages/natives must not declare a semver dependency");

		// The declared range this measurement is about. If @napi-rs/cli moves off
		// 3.8.1 its semver surface has to be re-measured, so pin the version the
		// table above was taken against.
		assert.equal(natives.devDependencies["@napi-rs/cli"], "3.8.1");
		assert.ok(
			BASELINE_NAPI_WASI_ENGINE.has(natives.engines.node),
			`packages/natives engines.node ${natives.engines.node} is not in BASELINE_NAPI_WASI_ENGINE`,
		);

		// And the belt to that braces: restrictWasiNodeEngine only runs for a WASI
		// target, which this repository does not build. Every target is a native
		// triple, so the measured-equal path is not even reached today.
		assert.deepEqual(
			natives.napi.targets.filter((target) => target.includes("wasi") || target.includes("wasm")),
			[],
			"a WASI target would make @napi-rs/cli's semver surface live; re-measure before adding one",
		);
	});
});

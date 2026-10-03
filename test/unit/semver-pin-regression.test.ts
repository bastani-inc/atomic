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
 * Contract for the semver 7.8.5 pin shared by shipped code and build tooling.
 * The BASELINE_* tables were measured against a real upstream 7.8.5 build;
 * they preserve prerelease, build-metadata and package-source range behavior.
 * Numeric tails after x-ranges must be rejected by the upstream 7.8.4 fix.
 *
 * Check every locked semver node and resolve the installed CLI from its owning
 * workspace: npm may hoist or nest it without changing this contract. The CLI
 * surface below was re-measured against @napi-rs/cli 3.10.5 and semver 7.8.5.
 * To re-record these tables after a future pin move, unpack upstream outside
 * this tree and replay the same calls against it:
 *
 *   npm pack semver@7.8.5 --pack-destination "$TMPDIR"
 *   tar -xzf "$TMPDIR/semver-7.8.5.tgz" -C "$TMPDIR"
 *   node -e "const baseline = require('$TMPDIR/package')"   # then replay each call below against it
 */

const PINNED_SEMVER_VERSION = "7.8.5";
const BASELINE_SEMVER_VERSION = "7.8.5";
const PINNED_NAPI_CLI_VERSION = "3.10.5";

const root = join(moduleDir(import.meta.url), "../..");
const codingAgentDir = join(root, "packages/coding-agent");
const requireFromTest = createRequire(import.meta.url);

/** The three manifest shapes this file reads. */
interface Manifest {
	version: string;
}

interface CliManifest extends Manifest {
	dependencies: Record<string, string>;
}

interface Lockfile {
	packages: Record<
		string,
		{
			version: string;
			dependencies?: Record<string, string>;
			devDependencies?: Record<string, string>;
			optionalDependencies?: Record<string, string>;
		}
	>;
}

/** Every package in `lockfile` that declares a `semver` dependency, with the range it declares. */
function semverEdges(lockfile: Lockfile): [declarer: string, range: string][] {
	return Object.entries(lockfile.packages).flatMap(([path, node]) =>
		[node.dependencies?.semver, node.devDependencies?.semver, node.optionalDependencies?.semver].flatMap((range) =>
			range ? [[path, range] as [string, string]] : [],
		),
	);
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

/** The semver operations exercised by the shipped-code contract below. */
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
 * @napi-rs/cli 3.10.5 declares semver@^7.8.2, satisfied by the shared 7.8.5 pin.
 * Its four semver imports feed restrictWasiNodeEngine and its helpers, which
 * intersect engines.node with the supported WASI Node.js lines.
 *
 * The floor and functions below are transcribed from the installed 3.10.5
 * dist/index.js: `restrictWasiNodeEngine`, `normalizeComparatorSet`, and
 * `stabilizePrereleaseComparator` are byte-for-byte unchanged from 3.9.0 (only
 * minified differently), and the declared semver range and WASI floor are
 * also unchanged, so the recorded baseline table below still applies.
 * This exercises the CLI's semver surface, not the
 * full native build command, against both actual module resolutions.
 */
const MINIMUM_WASI_NODE_VERSION = "^20.19.0 || ^22.13.0 || >=23.5.0";

/** The four `semver` entry points `@napi-rs/cli` imports, and nothing else. */
type NapiSemverApi = Pick<typeof import("semver"), "Comparator" | "Range" | "minVersion" | "subset">;

/** Resolve from the owning workspace, whether npm hoists or nests the CLI. */
const requireFromNatives = createRequire(join(root, "packages/natives/package.json"));
const napiCliManifestPath = requireFromNatives.resolve("@napi-rs/cli/package.json");
const requireFromNapiCli = createRequire(napiCliManifestPath);
const pinnedNapiSurface: NapiSemverApi = { Comparator, Range, minVersion, subset };
const napiCliSemver = requireFromNapiCli("semver") as NapiSemverApi;

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
	throw new Error(
		`Cannot restrict engines.node "${nodeRange}" to the Node.js versions supported by WASI packages: ` +
			`it does not intersect "${MINIMUM_WASI_NODE_VERSION}". ` +
			"Broaden engines.node to include a supported Node.js version or remove the WASI targets.",
	);
}

/**
 * restrictWasiNodeEngine(range) from CLI 3.10.5 with semver 7.8.5, for the
 * repository's engines.node ranges plus the WASI minimum itself.
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

/** Numeric tails after x-ranges: every case was measured as `null` at 7.8.5. */
const XRANGE_NUMERIC_TAILS = ["1.x.3", "1.x.2", "1.X.4", "0.x.9"] as const;

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

describe("semver pinned at 7.8.5", () => {
	test("every locked semver is 7.8.5 and shipped code links against the pin", async () => {
		assert.equal(
			requireFromTest.resolve("semver", { paths: [codingAgentDir] }),
			requireFromTest.resolve("semver"),
			"this test must exercise the same semver instance packages/coding-agent resolves",
		);

		const pinnedManifest = await readJson<Manifest>(requireFromTest.resolve("semver/package.json"));
		assert.equal(pinnedManifest.version, PINNED_SEMVER_VERSION);

		// The override keeps all copies at the pin, regardless of npm's layout.
		const lockfile = await readJson<Lockfile>(join(root, "package-lock.json"));
		assert.equal(resolvedSemverFor(lockfile, "packages/coding-agent"), PINNED_SEMVER_VERSION);
		const resolved = Object.entries(lockfile.packages).filter(
			([path]) => path.split("node_modules/").pop() === "semver",
		);
		assert.ok(resolved.length > 0, "package-lock.json must contain semver");
		for (const [path, node] of resolved) {
			assert.equal(node.version, PINNED_SEMVER_VERSION, `${path} must resolve the pin`);
		}
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

	test("numeric tails after x-ranges are rejected rather than silently widened", () => {
		for (const form of XRANGE_NUMERIC_TAILS) {
			assert.equal(pinned.validRange(form), null, form);
			const source = parseNpmSource(`npm:example@${form}`);
			assert.equal(source.version, form, `parseSource preserves the supplied ${form}`);
			assert.equal(source.range, undefined, `parseSource must not widen ${form} to an x-range`);
			assert.equal(source.pinned, false, `parseSource must not treat ${form} as an exact pin`);
		}
	});

	test("dependency ranges are satisfied and CLI 3.10.5 keeps its measured behavior", async () => {
		const napiManifest = await readJson<CliManifest>(napiCliManifestPath);
		const napiSemverManifest = await readJson<Manifest>(requireFromNapiCli.resolve("semver/package.json"));
		assert.equal(napiManifest.version, PINNED_NAPI_CLI_VERSION);
		assert.equal(napiSemverManifest.version, PINNED_SEMVER_VERSION);
		assert.ok(
			pinned.satisfies(napiSemverManifest.version, napiManifest.dependencies.semver),
			`@napi-rs/cli resolves semver ${napiSemverManifest.version}, outside its declared ${napiManifest.dependencies.semver}`,
		);

		const lockfile = await readJson<Lockfile>(join(root, "package-lock.json"));
		const lockedCli = Object.entries(lockfile.packages).filter(([path]) =>
			path.endsWith("node_modules/@napi-rs/cli"),
		);
		assert.ok(lockedCli.length > 0, "package-lock.json must contain @napi-rs/cli");
		for (const [path, node] of lockedCli) {
			assert.equal(node.version, napiManifest.version, `${path} must match the CLI being measured`);
			assert.equal(node.dependencies?.semver, napiManifest.dependencies.semver, `${path} semver dependency range`);
		}

		// Check declared dependency ranges, not just the resolved versions' floors.
		for (const [declarer, range] of semverEdges(lockfile)) {
			const resolvedVersion = resolvedSemverFor(lockfile, declarer);
			assert.ok(resolvedVersion, `${declarer} declares semver ${range} but resolves no node`);
			assert.ok(
				pinned.satisfies(resolvedVersion, range),
				`${declarer} declares semver ${range} and resolves incompatible ${resolvedVersion}`,
			);
		}

		// Run the transcribed CLI surface against the pin and its own resolution.
		for (const [nodeRange, restricted] of BASELINE_NAPI_WASI_ENGINE) {
			assert.equal(restrictWasiNodeEngine(napiCliSemver, nodeRange), restricted, `${nodeRange} at the CLI's build`);
			assert.equal(restrictWasiNodeEngine(pinnedNapiSurface, nodeRange), restricted, `${nodeRange} at the pin`);
		}

		const natives = await readJson<{
			devDependencies: Record<string, string>;
			engines: { node: string };
			napi: { targets: string[] };
		}>(join(root, "packages/natives/package.json"));

		// A CLI pin move requires re-measuring the transcribed surface above.
		assert.equal(natives.devDependencies["@napi-rs/cli"], PINNED_NAPI_CLI_VERSION);
		assert.ok(
			BASELINE_NAPI_WASI_ENGINE.has(natives.engines.node),
			`packages/natives engines.node ${natives.engines.node} is not in BASELINE_NAPI_WASI_ENGINE`,
		);

		// WASI restriction is not reached by this repository's native-only targets.
		assert.deepEqual(
			natives.napi.targets.filter((target) => target.includes("wasi") || target.includes("wasm")),
			[],
			"a WASI target would make @napi-rs/cli's semver surface live; re-measure before adding one",
		);
	});
});

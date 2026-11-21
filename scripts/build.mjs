#!/usr/bin/env node
// Incremental `npm run build`: runs each build step only when its inputs or outputs changed.
//
// Steps run the same package.json scripts a full build runs. The packages Atomic depends on are
// compiled into a staging directory instead, and only the files whose bytes changed are moved into
// their dist (see refresh-package-dist.mjs), so a process importing one of them while a build runs
// never reads a missing or half-written file. Each step keeps a content-hash stamp under
// node_modules/.cache/atomic-build (see build-stamps.mjs); TypeScript steps also keep their
// tsBuildInfo there, outside the shipped dist directories.
//
// `npm run build -- --force`, ATOMIC_BUILD_FORCE=1 or a CI environment rebuilds every step.
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	decideStep,
	fingerprintOutputs,
	formatAge,
	hashInputs,
	readStamp,
	removeStamp,
	writeStamp,
} from "./build-stamps.mjs";
import { refreshPackageDist } from "./refresh-package-dist.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD_CACHE_DIR = join(root, "node_modules", ".cache", "atomic-build");

/**
 * How long a local build reuses the fetched models.dev and remote provider catalog snapshot before
 * refetching it. `--force`, ATOMIC_BUILD_FORCE=1 and CI builds always refetch.
 */
export const MODEL_CATALOG_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Inputs of every step: the build tooling itself, the installed dependency tree, the shared compiler options,
 * the root tsconfig.json that esbuild and Bun.build read for files without a closer one, and Bun's bunfig.toml.
 */
const SHARED_INPUTS = [
	"package.json",
	"package-lock.json",
	"node_modules/.package-lock.json",
	"tsconfig.base.json",
	"tsconfig.json",
	"bunfig.toml",
	"scripts/build.mjs",
	"scripts/build-stamps.mjs",
	"scripts/package-files.mjs",
];

/** Compiles a staged step's package into a staging directory and moves the changed files into its dist. */
const STAGED_DIST_REFRESH = "scripts/refresh-package-dist.mjs";

/** @param {string} relative */
const isGeneratedModelSource = (relative) =>
	relative.startsWith("packages/ai/src/providers/data/") ||
	relative.includes("/.model-generation-") ||
	relative === "packages/ai/src/models.generated.ts" ||
	/^packages\/ai\/src\/providers\/[^/]+\.models\.ts$/u.test(relative);

/** Environment that changes what cargo and napi produce. */
const NATIVE_ENV =
	/^(?:CARGO_|RUST|NAPI_|CROSS_TARGET$|NATIVE_TARGET$|CC|CXX|AR$|CFLAGS|CXXFLAGS|LDFLAGS|MACOSX_DEPLOYMENT_TARGET$|SDKROOT$|ZIG)/iu;

/**
 * @typedef {object} BuildStep
 * @property {string} name
 * @property {string} packageDir
 * @property {Array<string | import("./build-stamps.mjs").PathSpec>} inputs
 * @property {Array<string | import("./build-stamps.mjs").PathSpec>} outputs
 * @property {Array<{ script: string, tsc?: boolean }>} scripts Package scripts to run in order. `tsc` appends incremental flags.
 * @property {true} [staged] After `scripts`, the package's dist is compiled into a staging directory, with the step's
 *   tsBuildInfo, and only the files whose bytes differ are moved into it (see refresh-package-dist.mjs).
 * @property {ReadonlyArray<"bun" | "rustc">} [toolchains]
 * @property {RegExp} [env] Environment variables whose values are inputs.
 * @property {ReadonlyArray<string>} [after] Steps whose output fingerprints are inputs.
 * @property {{ maxAgeMs: number, label: string }} [snapshot] Output also depends on fetched data, refreshed after `maxAgeMs`.
 */

/** @type {BuildStep[]} */
export const BUILD_STEPS = [
	{
		name: "schema",
		packageDir: "packages/schema",
		inputs: ["packages/schema/src", "packages/schema/package.json", "packages/schema/tsconfig.build.json"],
		outputs: ["packages/schema/dist"],
		scripts: [],
		staged: true,
	},
	{
		name: "telemetry",
		packageDir: "packages/telemetry",
		inputs: ["packages/telemetry/src", "packages/telemetry/package.json", "packages/telemetry/tsconfig.build.json"],
		outputs: ["packages/telemetry/dist"],
		scripts: [],
		staged: true,
	},
	{
		name: "ai-models",
		packageDir: "packages/ai",
		// models.dev and the other remote catalogs are refetched when the generator or its inputs change,
		// and otherwise once the snapshot is older than MODEL_CATALOG_MAX_AGE_MS.
		inputs: [
			{ path: "packages/ai/src", exclude: isGeneratedModelSource },
			"packages/ai/scripts",
			"packages/ai/package.json",
		],
		outputs: [
			"packages/ai/src/providers/data",
			"packages/ai/src/models.generated.ts",
			{
				path: "packages/ai/src/providers",
				match: isGeneratedModelSource,
				exclude: (relative) => relative.includes("/data/"),
			},
		],
		scripts: [{ script: "generate-models" }],
		snapshot: { maxAgeMs: MODEL_CATALOG_MAX_AGE_MS, label: "model catalog snapshot" },
	},
	{
		name: "ai",
		packageDir: "packages/ai",
		inputs: [
			"packages/ai/src",
			"packages/ai/scripts",
			"packages/ai/package.json",
			"packages/ai/tsconfig.base.json",
			"packages/ai/tsconfig.build.json",
			"packages/ai/tsconfig.json",
		],
		outputs: ["packages/ai/dist"],
		// The data the ai-models step left is checked as is: a stale catalog fails the build rather than being fetched again.
		scripts: [{ script: "check:model-data" }],
		staged: true,
		after: ["schema", "telemetry"],
	},
	{
		name: "tui",
		packageDir: "packages/tui",
		inputs: ["packages/tui/src", "packages/tui/package.json", "packages/tui/tsconfig.build.json"],
		outputs: ["packages/tui/dist"],
		scripts: [],
		staged: true,
	},
	{
		name: "agent",
		packageDir: "packages/agent",
		inputs: ["packages/agent/src", "packages/agent/package.json", "packages/agent/tsconfig.build.json"],
		outputs: ["packages/agent/dist"],
		scripts: [],
		staged: true,
		after: ["ai", "schema"],
	},
	{
		name: "codemode",
		packageDir: "packages/codemode",
		inputs: ["packages/codemode/src", "packages/codemode/package.json", "packages/codemode/tsconfig.build.json"],
		outputs: ["packages/codemode/dist"],
		scripts: [],
		staged: true,
	},
	{
		name: "natives",
		packageDir: "packages/natives",
		inputs: [
			"Cargo.toml",
			"Cargo.lock",
			"rust-toolchain.toml",
			".cargo",
			"crates",
			"packages/natives/scripts",
			"packages/natives/package.json",
		],
		outputs: ["packages/natives/native"],
		scripts: [{ script: "build" }],
		toolchains: ["bun", "rustc"],
		env: NATIVE_ENV,
	},
	{
		name: "atomic",
		packageDir: "packages/coding-agent",
		inputs: [
			"packages/coding-agent/src",
			"packages/coding-agent/scripts",
			"packages/coding-agent/package.json",
			"packages/coding-agent/tsconfig.build.json",
			"packages/subagents",
			"packages/mcp",
			"packages/web-access",
			"packages/intercom",
		],
		outputs: ["packages/coding-agent/dist"],
		scripts: [{ script: "build:tsc", tsc: true }, { script: "build:declarations" }, { script: "build:assets" }],
		toolchains: ["bun"],
		after: ["ai", "tui", "agent", "codemode", "natives"],
	},
];

/** Every input of `step`, shared inputs first. @param {BuildStep} step */
export function stepInputs(step) {
	return [...SHARED_INPUTS, ...(step.staged ? [STAGED_DIST_REFRESH] : []), ...step.inputs];
}

/**
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 */
export function shouldForce(args, env) {
	const truthy = (/** @type {string | undefined} */ value) =>
		value !== undefined && value !== "" && value !== "0" && value.toLowerCase() !== "false";
	return args.includes("--force") || truthy(env.ATOMIC_BUILD_FORCE) || truthy(env.CI);
}

/** @type {Map<string, string>} */
const toolchainVersions = new Map();

/** @param {"bun" | "rustc"} tool */
function toolchainVersion(tool) {
	const cached = toolchainVersions.get(tool);
	if (cached !== undefined) return cached;
	const command = tool === "rustc" ? "rustc -vV" : "bun --version";
	const result = spawnSync(command, { cwd: root, shell: true, encoding: "utf8" });
	const version =
		result.status === 0 ? result.stdout.trim() : `unavailable (${result.status ?? result.error?.message})`;
	toolchainVersions.set(tool, version);
	return version;
}

/** Runs a package.json script the way `npm run` does, with each `node_modules/.bin` on PATH. */
function runScript(/** @type {string} */ packageDir, /** @type {string} */ name, /** @type {string[]} */ extraArgs) {
	const manifest = JSON.parse(readFileSync(join(root, packageDir, "package.json"), "utf8"));
	const script = manifest.scripts?.[name];
	if (typeof script !== "string") throw new Error(`${packageDir}/package.json has no "${name}" script`);
	const command = [script, ...extraArgs.map((arg) => `"${arg}"`)].join(" ");
	const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
	const binDirs = [join(root, packageDir, "node_modules", ".bin"), join(root, "node_modules", ".bin")];
	const env = { ...process.env, [pathKey]: [...binDirs, process.env[pathKey] ?? ""].join(delimiter) };
	console.log(`\n> ${packageDir} ${name}: ${command}`);
	const result = spawnSync(command, { cwd: join(root, packageDir), shell: true, stdio: "inherit", env });
	if (result.status !== 0) {
		throw new Error(
			`${packageDir} script "${name}" failed (${result.status ?? result.signal ?? result.error?.message})`,
		);
	}
}

/** @param {BuildStep} step @param {Map<string, string>} outputHashes */
function stepKeys(step, outputHashes) {
	/** @type {Record<string, string | undefined>} */
	const keys = { node: process.version, platform: process.platform, arch: process.arch };
	for (const tool of step.toolchains ?? []) keys[`toolchain:${tool}`] = toolchainVersion(tool);
	if (step.env) {
		for (const [name, value] of Object.entries(process.env)) if (step.env.test(name)) keys[`env:${name}`] = value;
	}
	for (const upstream of step.after ?? []) keys[`after:${upstream}`] = outputHashes.get(upstream);
	return keys;
}

/** @param {{ force: boolean }} options */
export function build({ force }) {
	if (force) rmSync(BUILD_CACHE_DIR, { recursive: true, force: true });
	/** @type {Map<string, string>} */
	const outputHashes = new Map();
	for (const step of BUILD_STEPS) {
		const stampPath = join(BUILD_CACHE_DIR, `${step.name}.stamp.json`);
		const tsBuildInfo = join(BUILD_CACHE_DIR, `${step.name}.tsbuildinfo`);
		const inputHash = hashInputs(root, stepInputs(step), stepKeys(step, outputHashes));
		const stamp = readStamp(stampPath);
		const decision = decideStep({
			force,
			stamp,
			inputHash,
			outputs: fingerprintOutputs(root, step.outputs),
			maxAgeMs: step.snapshot?.maxAgeMs,
		});
		if (decision.reason === undefined) {
			console.log(`[build] ${step.name}: up to date`);
			outputHashes.set(step.name, stamp?.outputHash ?? "");
		} else {
			const builtAt = Date.now();
			console.log(`[build] ${step.name}: building (${decision.reason})`);
			removeStamp(stampPath);
			if (!decision.incremental) rmSync(tsBuildInfo, { force: true });
			for (const { script, tsc } of step.scripts) {
				runScript(step.packageDir, script, tsc ? ["--incremental", "--tsBuildInfoFile", tsBuildInfo] : []);
			}
			if (step.staged) {
				refreshPackageDist(join(root, step.packageDir), { generateModelData: false, tsBuildInfoFile: tsBuildInfo });
			}
			const outputs = fingerprintOutputs(root, step.outputs);
			if (outputs.missing.length > 0) throw new Error(`${step.name} did not produce ${outputs.missing.join(", ")}`);
			writeStamp(stampPath, { inputHash, outputHash: outputs.hash, builtAt });
			outputHashes.set(step.name, outputs.hash);
			if (decision.stale && step.snapshot && stamp) {
				const previous = Number.isFinite(stamp.builtAt) ? new Date(stamp.builtAt).toISOString() : "an unknown time";
				console.log(
					`[build] ${step.name}: refreshed the ${step.snapshot.label} from ${previous}, older than ${formatAge(step.snapshot.maxAgeMs)}`,
				);
			}
		}
	}
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	const args = process.argv.slice(2);
	const unknown = args.filter((arg) => arg !== "--force");
	if (unknown.length > 0) {
		console.error(`Unknown argument: ${unknown.join(" ")}\nUsage: npm run build [-- --force]`);
		process.exit(2);
	}
	try {
		build({ force: shouldForce(args, process.env) });
	} catch (error) {
		console.error(`[build] ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}

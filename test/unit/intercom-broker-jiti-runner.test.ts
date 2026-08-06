import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, test } from "vitest";

/**
 * The Node broker path used to resolve tsx first and fall back to jiti. tsx is the only thing
 * that pulled esbuild — a platform-specific native package that the single-runner release build
 * copied into every archive, so 0.9.12 shipped `@esbuild/linux-x64` on arm64. jiti has no
 * dependencies and no native binary. These tests prove jiti really runs the broker and that
 * nothing first-party resolves tsx any more.
 */

/** Real detached child process plus a real TypeScript loader. */
const REAL_BROKER_STARTUP_TIMEOUT_MS = 30_000;

/** Generous ceiling for one real broker startup through jiti. Measured at ~70 ms. */
const BROKER_STARTUP_BUDGET_MS = 8_000;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const extensionDir = join(repoRoot, "packages/intercom");
const brokerPath = join(extensionDir, "broker", "broker.ts");

const agentDir = mkdtempSync(join(tmpdir(), "intercom-jiti-runner-"));
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

type SpawnModule = typeof import("../../packages/intercom/broker/spawn.js");
type PathsModule = typeof import("../../packages/intercom/broker/paths.js");

let spawnModule: SpawnModule;
let pathsModule: PathsModule;

beforeAll(async () => {
	pathsModule = await import("../../packages/intercom/broker/paths.js");
	spawnModule = await import("../../packages/intercom/broker/spawn.js");
});

afterAll(() => {
	const pidPath = pathsModule.getBrokerPidPath();
	if (!existsSync(pidPath)) return;
	const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
	if (!Number.isFinite(pid)) return;
	try {
		process.kill(pid, "SIGTERM");
	} catch {
		// The broker already exited.
	}
});

function collectTypeScriptFiles(directory: string, found: string[]): void {
	let entries: string[];
	try {
		entries = readdirSync(directory);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === "node_modules" || entry === "dist" || entry === "binaries") continue;
		const candidate = join(directory, entry);
		if (statSync(candidate).isDirectory()) {
			collectTypeScriptFiles(candidate, found);
			continue;
		}
		if (candidate.endsWith(".ts") && !candidate.endsWith(".d.ts")) found.push(candidate);
	}
}

function firstPartySources(): string[] {
	const roots = [join(repoRoot, "packages/intercom"), join(repoRoot, "packages/coding-agent/src")];
	const files: string[] = [];
	for (const root of roots) collectTypeScriptFiles(root, files);
	return files;
}

describe("broker runner resolution", () => {
	test("the Node default sentinel resolves to a jiti CLI that exists on disk", () => {
		const launch = spawnModule.getBrokerLaunchSpec(
			brokerPath,
			"npx",
			["--no-install", "tsx"],
			extensionDir,
			"linux",
			join(agentDir, "intercom"),
			process.execPath,
			"node",
		);

		assert.equal(launch.kind, "direct");
		assert.equal(launch.command, process.execPath);
		const runner = launch.args[0] ?? "";
		assert.equal(basename(runner), "jiti-cli.mjs");
		assert.ok(existsSync(runner), `resolved jiti CLI does not exist: ${runner}`);
		assert.equal(runner.includes(`${sep}tsx${sep}`), false);
	});

	test("spawn.ts exposes no tsx resolver any more", () => {
		const source = readFileSync(join(extensionDir, "broker", "spawn.ts"), "utf8");

		assert.equal(source.includes("resolveTsxCliPath"), false);
		assert.equal(source.includes("getTsxCliPath"), false);
		// The npx/tsx config pair survives only as the recognized compatibility sentinel.
		assert.ok(source.includes('brokerArgs[1] === "tsx"'));
	});

	test("no first-party source resolves the tsx package at runtime", () => {
		const offenders: string[] = [];
		for (const file of firstPartySources()) {
			const source = readFileSync(file, "utf8");
			// The `npx --no-install tsx` sentinel is a config value, not a resolution, so match
			// only the ways first-party code could actually load or path-build to the package.
			const resolves =
				/require\(\s*["']tsx["']\s*\)/u.test(source) ||
				/\.resolve\(\s*["']tsx["']\s*\)/u.test(source) ||
				/from\s+["']tsx["']/u.test(source) ||
				/["']tsx["']\s*,\s*["']dist["']/u.test(source);
			if (resolves) offenders.push(file.slice(repoRoot.length + 1));
		}

		assert.deepEqual(offenders, []);
	});
});

describe("shipped dependency manifests", () => {
	test("neither package depends on tsx or esbuild", () => {
		for (const manifestPath of ["packages/intercom/package.json", "packages/coding-agent/package.json"]) {
			const manifest = JSON.parse(readFileSync(join(repoRoot, manifestPath), "utf8")) as {
				dependencies?: Record<string, string>;
				optionalDependencies?: Record<string, string>;
				devDependencies?: Record<string, string>;
			};
			const all = { ...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.devDependencies };
			assert.equal(all.tsx, undefined, `${manifestPath} still declares tsx`);
			assert.equal(all.esbuild, undefined, `${manifestPath} still declares esbuild`);
		}

		const codingAgent = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		assert.ok(codingAgent.dependencies?.jiti, "the broker runner must stay a declared dependency");
	});

	test("the published shrinkwrap ships no tsx, esbuild, or esbuild platform package", () => {
		const shrinkwrap = JSON.parse(
			readFileSync(join(repoRoot, "packages/coding-agent/npm-shrinkwrap.json"), "utf8"),
		) as { packages: Record<string, unknown> };

		const offenders = Object.keys(shrinkwrap.packages).filter((entry) =>
			/(^|\/)node_modules\/(tsx|esbuild|@esbuild\/[^/]+|fsevents)$/u.test(entry),
		);

		assert.deepEqual(offenders, []);
		assert.ok(Object.keys(shrinkwrap.packages).some((entry) => entry.endsWith("node_modules/jiti")));
	});
});

describe("real broker startup through jiti", () => {
	test(
		"jiti actually runs the broker and the socket becomes connectable",
		async () => {
			const started = process.hrtime.bigint();
			await spawnModule.spawnBrokerIfNeeded("npx", ["--no-install", "tsx"]);
			const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

			await spawnModule.waitForBroker(BROKER_STARTUP_BUDGET_MS);
			assert.ok(existsSync(pathsModule.getBrokerPidPath()));
			assert.ok(
				elapsedMs < BROKER_STARTUP_BUDGET_MS,
				`broker startup took ${elapsedMs.toFixed(1)} ms, budget ${BROKER_STARTUP_BUDGET_MS} ms`,
			);
			console.log(`[broker startup via jiti] ${elapsedMs.toFixed(1)} ms (budget ${BROKER_STARTUP_BUDGET_MS} ms)`);
		},
		REAL_BROKER_STARTUP_TIMEOUT_MS,
	);
});

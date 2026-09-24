/**
 * Integration smoke: run the built @bastani/atomic package under Node from an
 * installed-like layout (dependencies as node_modules siblings, no monorepo
 * packages/ directories next to the loader).
 *
 * Regression guard for #1600/#1609: the extension-loader alias fallback used
 * require.resolve("<pkg>/package.json"), which throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED under Node for packages that do not export
 * "./package.json" (e.g. @bastani/pi-ai). Every builtin extension
 * failed to load for npm installs (bin runs under `#!/usr/bin/env node`),
 * while the compiled binary (virtualModules) and Bun-run dev/test paths
 * (lenient exports-map resolution) stayed green — so only a Node-runtime
 * smoke over the installed layout can catch this class of regression.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, test } from "vitest";
import {
	preserveSharedPostgresRuntimeCache,
	registerSharedPostgresRuntimeHome,
	sharedPostgresRuntimeCache,
} from "../helpers/real-postgres.js";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../helpers/runtime.js";

const repoRoot = resolve(moduleDir(import.meta.url), "../..");
const repoNodeModules = join(repoRoot, "node_modules");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distCli = join(packageDir, "dist", "cli.js");

const distBuilt = fs.existsSync(distCli);

/**
 * Locate a REAL Node runtime on PATH. The repo's bunfig `[run] bun = true`
 * prepends a node->bun shim to PATH for package scripts (e.g.
 * `bun run test:integration`), so a bare spawnSync("node") can hit bun
 * masquerading as node — which exits 1 for `--version` here and, worse, would
 * silently neuter this regression guard (Bun's lenient exports-map resolution
 * hides the Node-only failure). Every candidate is therefore verified to be
 * genuine Node via `typeof Bun === "undefined"`.
 */
function findRealNode(): string | null {
	const names = process.platform === "win32" ? ["node.exe", "node.cmd"] : ["node"];
	const seen = new Set<string>();
	for (const dir of (process.env.PATH ?? "").split(delimiter)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			if (seen.has(candidate) || !fs.existsSync(candidate)) continue;
			seen.add(candidate);
			const probe = spawnSync(candidate, ["-e", "process.stdout.write(typeof Bun)"], {
				encoding: "utf8",
				timeout: 30_000,
			});
			if (probe.status === 0 && probe.stdout === "undefined") return candidate;
		}
	}
	return null;
}

const nodeExe = findRealNode();

// Hard-require the smoke only where the pipeline guarantees its
// prerequisites (test.yml sets this flag on the integration step, which runs
// after the package build). Other contexts without a prepared dist skip
// gracefully; the same commit's npm-under-Node coverage is enforced by the
// test.yml gate on branch pushes and pull requests.
const requireSmoke = process.env.ATOMIC_REQUIRE_INSTALLED_NODE_SMOKE === "1";
if (requireSmoke) {
	assert.ok(distBuilt, "packages/coding-agent/dist/cli.js missing — run the build step before the integration tests");
	assert.ok(
		nodeExe,
		`no real Node runtime found on PATH (bun-as-node shims are rejected) — required for the installed-package smoke. PATH=${process.env.PATH}`,
	);
}

const runTest = distBuilt && nodeExe ? test : test.skip;
if (!distBuilt || !nodeExe) {
	console.warn(
		"[installed-package-node-extensions] skipped: requires a built packages/coding-agent/dist and a real (non-bun-shim) node on PATH",
	);
}

let tmpRoot: string | undefined;
let packedRoot: string | undefined;
let releasePackedRuntimeCache: (() => void) | undefined;

afterAll(() => {
	if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	if (!packedRoot) return;
	const consumer = join(packedRoot, "consumer");
	const home = join(consumer, "home");
	const postgres = join(home, ".atomic", "postgres");
	if (fs.existsSync(postgres)) {
		assert.ok(nodeExe);
		const cleanup = spawnSync(nodeExe, [join(consumer, "consumer-parity.mjs"), "cleanup"], {
			cwd: consumer,
			encoding: "utf8",
			timeout: 30_000,
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				ATOMIC_POSTGRES_RUNTIME_CACHE_DIR: sharedPostgresRuntimeCache(),
			},
		});
		if (cleanup.status !== 0) preserveSharedPostgresRuntimeCache();
		assert.equal(
			cleanup.status,
			0,
			`cleanup failed; preserving ${packedRoot}: ${cleanup.error ?? ""}\n${cleanup.stdout}\n${cleanup.stderr}`,
		);
		const makeRemovable = (path: string) => {
			const stat = fs.lstatSync(path, { throwIfNoEntry: false });
			if (!stat || stat.isSymbolicLink()) return;
			fs.chmodSync(path, stat.isDirectory() ? 0o700 : 0o600);
			if (stat.isDirectory()) for (const name of fs.readdirSync(path)) makeRemovable(join(path, name));
		};
		if (fs.existsSync(join(postgres, "pg-runtime"))) makeRemovable(join(postgres, "pg-runtime"));
	}
	fs.rmSync(packedRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
	releasePackedRuntimeCache?.();
});

/** Symlink (junction on Windows, so no elevation is needed) a real directory. */
function linkDir(target: string, linkPath: string): void {
	const linkType = process.platform === "win32" ? "junction" : "dir";
	fs.symlinkSync(fs.realpathSync(target), linkPath, linkType);
}

/**
 * Build <tmp>/install/node_modules mirroring the repo's node_modules via
 * links, except @bastani/atomic itself, which is copied (not linked) so the
 * loader's realpath does not lead back into the monorepo and re-enable the
 * workspace-path short circuit.
 */
function buildInstalledLayout(): string {
	tmpRoot = fs.mkdtempSync(join(os.tmpdir(), "atomic-node-smoke-"));
	const layoutNodeModules = join(tmpRoot, "install", "node_modules");
	fs.mkdirSync(layoutNodeModules, { recursive: true });

	for (const entry of fs.readdirSync(repoNodeModules)) {
		if (entry === ".bin" || entry === ".cache") continue;
		const source = join(repoNodeModules, entry);
		if (!fs.statSync(source).isDirectory()) continue;
		if (entry === "@bastani" || entry === "@earendil-works") {
			const scopeDir = join(layoutNodeModules, entry);
			fs.mkdirSync(scopeDir);
			for (const scoped of fs.readdirSync(source)) {
				if (entry === "@bastani" && scoped === "atomic") continue;
				// The local build alias is not a dependency of the published package.
				// Exclude it on every platform so it cannot hide undeclared imports.
				if (entry === "@earendil-works" && scoped === "pi-ai") continue;
				linkDir(join(source, scoped), join(scopeDir, scoped));
			}
			continue;
		}
		linkDir(source, join(layoutNodeModules, entry));
	}

	const atomicDest = join(layoutNodeModules, "@bastani", "atomic");
	fs.mkdirSync(atomicDest, { recursive: true });
	fs.copyFileSync(join(packageDir, "package.json"), join(atomicDest, "package.json"));
	fs.cpSync(join(packageDir, "dist"), join(atomicDest, "dist"), { recursive: true, dereference: true });
	return atomicDest;
}

runTest(
	"installed @bastani/atomic loads builtin extensions under Node",
	() => {
		const atomicDest = buildInstalledLayout();
		assert.ok(tmpRoot, "layout setup must assign tmpRoot");
		// Isolated HOME + empty cwd: no repo-local or user config can leak in,
		// and the run deterministically ends at the no-configured-models exit.
		const homeDir = join(tmpRoot, "home");
		const workDir = join(tmpRoot, "cwd");
		fs.mkdirSync(homeDir, { recursive: true });
		fs.mkdirSync(workDir, { recursive: true });

		assert.ok(nodeExe, "real node executable must be resolved before the smoke runs");
		// Exercise emitted JavaScript: source-runtime tests hid a constructor-precedence
		// regression that wrapped the native exports object and failed on the second host.
		const supervisorProbe = spawnSync(
			nodeExe,
			[
				"--input-type=module",
				"-e",
				`import { TaskSupervisor } from "./dist/core/tasks/supervisor.js";
				for (let i = 0; i < 3; i++) new TaskSupervisor();
				console.log("repeated supervisor construction passed");`,
			],
			{ cwd: atomicDest, encoding: "utf8", timeout: 30_000 },
		);
		assert.equal(
			supervisorProbe.status,
			0,
			`installed supervisor construction failed:\n${supervisorProbe.stdout}\n${supervisorProbe.stderr}`,
		);
		assert.match(supervisorProbe.stdout, /repeated supervisor construction passed/);
		// Exercise the public installed SDK and host-module map with a registered classifier.
		// No real provider request or credential is used.
		for (const executable of [nodeExe, bunExecutable()]) {
			const probe = spawnSyncCollect(
				[
					executable,
					"--input-type=module",
					"-e",
					`
				import assert from "node:assert/strict";
				import { Type } from "typebox";
				import * as sdk from "@bastani/atomic";
				import { getVirtualModules } from "./dist/core/extensions/loader-host-modules.js";
				const hosted = (await getVirtualModules())["@bastani/atomic"];
				assert.equal(hosted.generateStructuredOutput, sdk.generateStructuredOutput);
				for (const name of ["inferRouterDecision", "routeModel", "resolveRouterModel"]) {
					assert.equal(Object.hasOwn(sdk, name), false);
					assert.equal(Object.hasOwn(hosted, name), false);
				}
				assert.equal(sdk.SettingsManager.inMemory().getRouterModel(), "");
				const classifier = {
					type: "classifier", provider: "fixture", id: "intent", api: "typesafe-system-one",
					name: "Fixture classifier", baseUrl: "https://example.invalid", input: ["text"],
					cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 4096
				};
				let requests = 0;
				const registry = {
					getAll: () => [],
					streamSimple: () => {throw Error("unexpected chat request")},
					getClassifierModel: (provider, id) => provider === "fixture" && id === "intent" ? classifier : undefined,
					classify: async (model, context) => {
						assert.equal(model.provider, "fixture");
						assert.equal(model.id, "intent");
						requests++;
						assert.ok("ok" in context.questions);
						const question = "ok";
						const choice = "true";
						return {api: classifier.api, provider: classifier.provider, model: classifier.id,
							answers: {[question]: {type: "choice", choice, probabilities: {[choice]: 1}, confidence: 1}},
							stopReason: "stop", timestamp: Date.now()};
					}
				};
				const schema = Type.Object({ok: Type.Literal(true)}, {additionalProperties: false});
				const general = await sdk.generateStructuredOutput({
					model: "fixture/intent", modelRegistry: registry, schema,
					state: {task: "classify this fixture"}, instructions: "Choose yes."
				});
				assert.deepEqual(general.value, {ok: true});
				assert.equal(requests, 1);
				console.log("installed structured decision passed");
			`,
				],
				{ cwd: atomicDest, timeout: 30_000 },
			);
			assert.equal(
				probe.exitCode,
				0,
				`installed SDK probe failed under ${executable}:\n${probe.stdout}\n${probe.stderr}`,
			);
			assert.match(probe.stdout.toString(), /installed structured decision passed/);
		}
		const result = spawnSync(nodeExe, [join(atomicDest, "dist", "cli.js"), "--no-session"], {
			cwd: workDir,
			input: "",
			encoding: "utf8",
			timeout: 180_000,
			env: { ...process.env, HOME: homeDir, USERPROFILE: homeDir },
		});

		const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
		assert.equal(result.signal, null, `smoke run killed by ${result.signal}:\n${output}`);
		assert.ok(!output.includes("Failed to load extension"), `extension load failure under Node:\n${output}`);
		assert.ok(
			!output.includes('is not defined by "exports"'),
			`exports-map resolution failure under Node:\n${output}`,
		);
		if (result.status !== 0) {
			assert.match(
				output,
				/No models available|No model selected|No API key found/,
				`unexpected non-zero exit (${result.status}):\n${output}`,
			);
		}
	},
	240_000,
);

// Packing, registry installation, two strict compiler passes and real Node hosts are structural work.
const PACKED_NODE_CONSUMER_TIMEOUT_MS = 360_000;

// #3105: no workspace links or loader aliases may participate in this consumer.
runTest(
	"packed Node consumer types, assets and builtin parity",
	() => {
		assert.ok(nodeExe);
		packedRoot = fs.mkdtempSync(join(os.tmpdir(), "atomic-packed-consumer-"));
		releasePackedRuntimeCache = registerSharedPostgresRuntimeHome(join(packedRoot, "consumer", "home"));
		const consumer = join(packedRoot, "consumer");
		fs.mkdirSync(consumer);
		fs.writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
		const npmCli = process.env.npm_execpath;
		assert.ok(npmCli && /npm-cli\.js$/.test(npmCli), "run this integration suite through npm");
		const execute = (args: string[], cwd: string, name: string) => {
			const result = spawnSync(nodeExe, args, {
				cwd,
				encoding: "utf8",
				timeout: PACKED_NODE_CONSUMER_TIMEOUT_MS,
				maxBuffer: 64 * 1024 * 1024,
				env: {
					...process.env,
					HOME: join(consumer, "home"),
					USERPROFILE: join(consumer, "home"),
					ATOMIC_CODING_AGENT_DIR: join(consumer, "home", ".atomic", "agent"),
					DBOS_SYSTEM_DATABASE_URL: undefined,
					ATOMIC_POSTGRES_RUNTIME_DIR: undefined,
					ATOMIC_POSTGRES_RUNTIME_CACHE_DIR: sharedPostgresRuntimeCache(),
					ATOMIC_INTERCOM_SESSION_ID: undefined,
				},
			});
			assert.equal(result.status, 0, `${name}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
			return result;
		};
		execute(
			[npmCli, "pack", "--workspace=@bastani/atomic", "--ignore-scripts", "--pack-destination", packedRoot],
			repoRoot,
			"pack atomic",
		);
		execute(
			[
				npmCli,
				"pack",
				"--workspace=@bastani/pi-ai",
				"--workspace=@bastani/atomic-natives",
				"--ignore-scripts",
				"--pack-destination",
				packedRoot,
			],
			repoRoot,
			"pack dependencies",
		);
		const archives = fs
			.readdirSync(packedRoot)
			.filter((name) => name.endsWith(".tgz"))
			.map((name) => join(packedRoot!, name));
		assert.equal(archives.length, 3);
		execute(
			[
				npmCli,
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--save-exact",
				...archives,
				"typescript@7.0.2",
				"@types/node@24.12.4",
			],
			consumer,
			"install packed closure",
		);
		const installed = join(consumer, "node_modules", "@bastani");
		for (const name of ["atomic", "pi-ai", "atomic-natives"]) {
			assert.ok(fs.realpathSync(join(installed, name)).startsWith(fs.realpathSync(consumer)));
		}
		const shrinkwrap = fs.readFileSync(join(installed, "atomic", "npm-shrinkwrap.json"), "utf8");
		assert.ok(!shrinkwrap.includes(repoRoot));
		assert.doesNotMatch(shrinkwrap, /"(?:link|resolved)"\s*:\s*(?:true|"(?:file:|\.\.\/|packages\/))/);
		assert.ok(fs.readdirSync(join(installed, "atomic-natives", "native")).some((name) => name.endsWith(".node")));
		const fixtures = [
			"consumer-parity-types.mts",
			"consumer-parity.mjs",
			"sdk-host-fixture-support.mjs",
			"sdk-host-durable-workflow.ts",
			"sdk-host-built-node.mjs",
			"sdk-host-lazy-mcp.mjs",
			"sdk-host-web-owners.mjs",
			"sdk-host-web-unavailable.mjs",
			"sdk-host-intercom-owners.mjs",
			"sdk-host-mcp-diagnostics.mjs",
		];
		for (const name of fixtures) fs.copyFileSync(join(repoRoot, "test", "fixtures", name), join(consumer, name));
		for (const skipLibCheck of [false, true]) {
			fs.writeFileSync(
				join(consumer, "tsconfig.json"),
				JSON.stringify({
					compilerOptions: {
						module: "NodeNext",
						moduleResolution: "NodeNext",
						target: "ES2023",
						strict: true,
						skipLibCheck,
						noEmit: true,
					},
					include: ["consumer-parity-types.mts"],
				}),
			);
			execute(
				[join(consumer, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.json"],
				consumer,
				`types skipLibCheck=${skipLibCheck}`,
			);
		}
		const runtime = execute([join(consumer, "consumer-parity.mjs")], consumer, "consumer parity");
		assert.equal(runtime.stderr, "");
		assert.match(runtime.stdout, /"packedConsumer":true/);
	},
	PACKED_NODE_CONSUMER_TIMEOUT_MS,
);

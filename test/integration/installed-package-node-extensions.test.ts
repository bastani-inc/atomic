/**
 * Integration smoke: run the built @bastani/atomic package under Node from an
 * installed-like layout (dependencies as node_modules siblings, no monorepo
 * packages/ directories next to the loader).
 *
 * Regression guard for #1600/#1609: the extension-loader alias fallback used
 * require.resolve("<pkg>/package.json"), which throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED under Node for packages that do not export
 * "./package.json" (e.g. @bastani/atomic-ai). Every builtin extension
 * failed to load for npm installs (bin runs under `#!/usr/bin/env node`),
 * while the compiled binary (virtualModules) and Bun-run dev/test paths
 * (lenient exports-map resolution) stayed green — so only a Node-runtime
 * smoke over the installed layout can catch this class of regression.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import { delimiter, join, resolve } from "node:path";
import { afterAll, test } from "vitest";
import { withoutSqliteExperimentalWarning } from "../fixtures/sdk-host-fixture-support.mjs";
import { startPtyProgram } from "../helpers/pty-program.js";
import { bunExecutable, moduleDir, readStreamText, spawnProcess, spawnSyncCollect } from "../helpers/runtime.js";
import { removeTestDirectory } from "../helpers/test-directory-removal.js";

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
let installedAtomicDir: string | undefined;
let packedRoot: string | undefined;

// Removing the copied package (tens of megabytes of dist files) is structural work under a loaded host.
const LAYOUT_CLEANUP_TIMEOUT_MS = 120_000;

afterAll(() => {
	if (tmpRoot) removeTestDirectory(tmpRoot, { retries: 20, retryDelayMs: 50 });
	if (!packedRoot) return;
	removeTestDirectory(packedRoot, { retries: 20, retryDelayMs: 50 });
}, LAYOUT_CLEANUP_TIMEOUT_MS);

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
	if (installedAtomicDir) return installedAtomicDir;
	tmpRoot = fs.mkdtempSync(join(os.tmpdir(), "atomic-node-smoke-"));
	const layoutNodeModules = join(tmpRoot, "install", "node_modules");
	fs.mkdirSync(layoutNodeModules, { recursive: true });

	for (const entry of fs.readdirSync(repoNodeModules)) {
		if (entry === ".bin" || entry === ".cache") continue;
		const source = join(repoNodeModules, entry);
		if (!fs.statSync(source).isDirectory()) continue;
		if (entry === "@bastani") {
			const scopeDir = join(layoutNodeModules, entry);
			fs.mkdirSync(scopeDir);
			for (const scoped of fs.readdirSync(source)) {
				if (entry === "@bastani" && scoped === "atomic") continue;
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
	installedAtomicDir = atomicDest;
	return atomicDest;
}

/** Files below `dir`, relative to it; empty when `dir` is missing. */
function filesBelow(dir: string): string[] {
	if (!fs.existsSync(dir)) return [];
	return fs
		.readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1));
}

// One real CLI start under Node, including the installed-layout copy, is structural work.
const INSTALLED_FIRST_START_TIMEOUT_MS = 240_000;

runTest(
	"installed layout starts in a fresh HOME without transpiling builtins (#4748)",
	async () => {
		const atomicDest = buildInstalledLayout();
		assert.ok(tmpRoot, "layout setup must assign tmpRoot");
		assert.ok(nodeExe, "real node executable must be resolved before the start runs");
		const homeDir = fs.mkdtempSync(join(tmpRoot, "fresh-home-"));
		const workDir = fs.mkdtempSync(join(tmpRoot, "fresh-cwd-"));

		// A minimal OpenAI-compatible endpoint: the first request lists every tool the start registered.
		const requestedTools: string[][] = [];
		const server = createServer((request, response) => {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			request.on("end", () => {
				const parsed = JSON.parse(body || "{}") as { tools?: { function?: { name?: string } }[] };
				requestedTools.push((parsed.tools ?? []).map((tool) => tool.function?.name ?? ""));
				response.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = { id: "fixture", object: "chat.completion.chunk", created: 0, model: "fixture-model" };
				response.write(
					`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`,
				);
				response.write(
					`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
				);
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
		try {
			const { port } = server.address() as AddressInfo;
			const agentDir = join(homeDir, ".atomic", "agent");
			fs.mkdirSync(agentDir, { recursive: true });
			fs.writeFileSync(
				join(agentDir, "models.json"),
				JSON.stringify({
					providers: {
						fixture: {
							baseUrl: `http://127.0.0.1:${port}/v1`,
							api: "openai-completions",
							apiKey: "fixture-key",
							models: [{ id: "fixture-model" }],
						},
					},
				}),
			);
			fs.writeFileSync(
				join(agentDir, "settings.json"),
				JSON.stringify({ defaultProvider: "fixture", defaultModel: "fixture-model", quietStartup: true }),
			);
			// The calling session's Atomic and pi variables (agent dir, model, intercom session) must not reach the child.
			const env: Record<string, string | undefined> = Object.fromEntries(
				Object.entries(process.env).filter(([name]) => !/^(?:ATOMIC|PI)_/.test(name)),
			);
			const child = spawnProcess([nodeExe, join(atomicDest, "dist", "cli.js"), "-p", "hi", "--no-session"], {
				cwd: workDir,
				env: { ...env, HOME: homeDir, USERPROFILE: homeDir },
				stdout: "pipe",
				stderr: "pipe",
				timeout: INSTALLED_FIRST_START_TIMEOUT_MS,
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				readStreamText(child.stdout),
				readStreamText(child.stderr),
				child.exited,
			]);
			const output = `${stdout}${stderr}`;
			assert.equal(exitCode, 0, `first start failed:\n${output}`);
			assert.ok(!output.includes("Failed to load extension"), `extension load failure:\n${output}`);
			const tools = requestedTools[0] ?? [];
			assert.ok(!tools.includes("workflow"));
			for (const builtinTool of ["subagent", "web_search", "fetch_content", "intercom"]) {
				assert.ok(tools.includes(builtinTool), `builtin tool ${builtinTool} missing from ${tools.join(",")}`);
			}
			// The builtins ship prebundled and load natively, so a first start has nothing to transpile.
			assert.deepEqual(filesBelow(join(agentDir, "cache", "transpile")), []);
		} finally {
			await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
		}
	},
	INSTALLED_FIRST_START_TIMEOUT_MS,
);

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
		// Each AgentTaskHost the SDK exports constructs the package's own TaskSupervisor.
		const supervisorProbe = spawnSync(
			nodeExe,
			[
				"--input-type=module",
				"-e",
				`import { AgentTaskHost } from "@bastani/atomic";
				for (let i = 0; i < 3; i++) new AgentTaskHost({ scope: { kind: "session", sessionId: "probe-" + i }, authorizeLaunch() {} });
				console.log("repeated supervisor construction passed");
				process.exit(0);`,
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
				for (const name of ["inferRouterDecision", "routeModel", "resolveDecisionModel"]) {
					assert.equal(Object.hasOwn(sdk, name), false);
					assert.equal(Object.hasOwn(hosted, name), false);
				}
				assert.equal(sdk.SettingsManager.inMemory().getDecisionModel(), "");
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
const PACKED_NODE_CONSUMER_TIMEOUT_MS = 480_000;

/** This host's napi target, as the platform package of `@bastani/atomic-natives` names it. */
function hostNativeTarget(): string {
	if (process.platform === "win32") return `win32-${process.arch}-msvc`;
	if (process.platform !== "linux") return `${process.platform}-${process.arch}`;
	const header = (process.report.getReport() as { header?: { glibcVersionRuntime?: string } }).header;
	return `linux-${process.arch}-${header?.glibcVersionRuntime ? "gnu" : "musl"}`;
}

/** An isolated profile for a consumer: its own home, agent directory and journal, and npm's repository cache. */
function consumerProfileEnv(consumer: string, npmCache?: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: join(consumer, "atomic-journal-home"),
		USERPROFILE: join(consumer, "atomic-journal-home"),
		ATOMIC_CODING_AGENT_DIR: join(consumer, "atomic-journal-home", ".atomic", "agent"),
		ATOMIC_WORKFLOW_JOURNAL_PATH: join(consumer, "atomic-journal-home", "journal.sqlite"),
		ATOMIC_INTERCOM_SESSION_ID: undefined,
		...(npmCache === undefined ? {} : { npm_config_cache: npmCache }),
	};
}

/** Run Node with `args` and log how long it took; `expectedStatus` is the exit status the run must end with. */
function runNodeLogged(args: string[], cwd: string, name: string, env: NodeJS.ProcessEnv, expectedStatus = 0) {
	assert.ok(nodeExe);
	const started = performance.now();
	const result = spawnSync(nodeExe, args, {
		cwd,
		encoding: "utf8",
		timeout: PACKED_NODE_CONSUMER_TIMEOUT_MS,
		maxBuffer: 64 * 1024 * 1024,
		env,
	});
	fs.writeSync(
		process.stdout.fd,
		`[packed-node-consumer] ${name}: ${Math.round(performance.now() - started)}ms (status=${result.status})\n`,
	);
	for (const line of (result.stdout ?? "").split("\n")) {
		if (line.startsWith("[packed-node-consumer]")) fs.writeSync(process.stdout.fd, `${line}\n`);
	}
	assert.equal(result.status, expectedStatus, `${name}: ${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
	return result;
}

interface PackedClosure {
	/** The packages a consumer installs, `@bastani/atomic-natives` as published. */
	archives: string[];
	/** This host's platform package of `@bastani/atomic-natives`, as publish.yml packs it. */
	platformArchive: string;
	target: string;
	/** npm's cache of the repository installation, which the consumers reuse. */
	npmCache: string;
}

let packedClosure: PackedClosure | undefined;

/**
 * Pack the published closure once for every consumer. `@bastani/atomic-natives` is packed as publish.yml leaves it: no
 * binary of its own, and every platform package listed as an optional dependency at its version.
 */
function packClosure(npmCli: string): PackedClosure {
	if (packedClosure) return packedClosure;
	packedRoot ??= fs.mkdtempSync(join(os.tmpdir(), "atomic-packed-consumer-"));
	const archivesDir = join(packedRoot, "archives");
	fs.mkdirSync(archivesDir);
	const npmCache = runNodeLogged(
		[npmCli, "config", "get", "cache"],
		repoRoot,
		"repository npm cache",
		process.env,
	).stdout.trim();
	assert.ok(npmCache, "npm must resolve the repository installation cache");
	const env = { ...process.env, npm_config_cache: npmCache };
	runNodeLogged(
		[
			npmCli,
			"pack",
			"--workspace=@bastani/atomic",
			"--workspace=@bastani/atomic-ai",
			"--workspace=@bastani/atomic-agent-core",
			"--workspace=@bastani/atomic-codemode",
			"--workspace=@bastani/atomic-schema",
			"--workspace=@bastani/atomic-telemetry",
			"--workspace=@bastani/atomic-tui",
			"--ignore-scripts",
			"--pack-destination",
			archivesDir,
		],
		repoRoot,
		"pack consumer closure",
		env,
	);
	const nativesDir = join(repoRoot, "packages", "natives");
	const nativesManifest = JSON.parse(fs.readFileSync(join(nativesDir, "package.json"), "utf8")) as {
		version: string;
		files: string[];
	};
	const published = JSON.parse(fs.readFileSync(join(packageDir, "npm-shrinkwrap.json"), "utf8")) as {
		packages: Record<string, { optionalDependencies?: Record<string, string> }>;
	};
	const optionalDependencies = published.packages["node_modules/@bastani/atomic-natives"]?.optionalDependencies;
	assert.ok(optionalDependencies, "the published shrinkwrap lists the platform packages of @bastani/atomic-natives");
	const nativesStage = join(packedRoot, "natives-package");
	for (const file of [...nativesManifest.files, "LICENSE"]) {
		fs.mkdirSync(join(nativesStage, file, ".."), { recursive: true });
		fs.copyFileSync(join(nativesDir, file), join(nativesStage, file));
	}
	fs.writeFileSync(join(nativesStage, "package.json"), JSON.stringify({ ...nativesManifest, optionalDependencies }));
	runNodeLogged(
		[npmCli, "pack", "--ignore-scripts", "--pack-destination", archivesDir],
		nativesStage,
		"pack native module package",
		env,
	);
	const target = hostNativeTarget();
	const platformPackage = join(packedRoot, "platform-package");
	fs.mkdirSync(platformPackage);
	fs.copyFileSync(
		join(nativesDir, "native", `atomic_natives.${target}.node`),
		join(platformPackage, `atomic_natives.${target}.node`),
	);
	fs.writeFileSync(
		join(platformPackage, "package.json"),
		JSON.stringify({
			name: `@bastani/atomic-natives-${target}`,
			version: nativesManifest.version,
			main: `atomic_natives.${target}.node`,
			files: [`atomic_natives.${target}.node`],
		}),
	);
	runNodeLogged(
		[npmCli, "pack", "--ignore-scripts", "--pack-destination", packedRoot],
		platformPackage,
		"pack platform package",
		env,
	);
	const archives = fs.readdirSync(archivesDir).map((name) => join(archivesDir, name));
	assert.equal(archives.length, 8);
	const platformArchive = fs
		.readdirSync(packedRoot)
		.filter((name) => name.endsWith(".tgz"))
		.map((name) => join(packedRoot!, name));
	assert.equal(platformArchive.length, 1);
	packedClosure = { archives, platformArchive: platformArchive[0]!, target, npmCache };
	return packedClosure;
}

/** npm's CLI, as the suite runs through npm. */
function npmCliPath(): string {
	const npmCli = process.env.npm_execpath;
	assert.ok(npmCli && /npm-cli\.js$/.test(npmCli), "run this integration suite through npm");
	return npmCli;
}

// #3105: no workspace links or loader aliases may participate in this consumer.
runTest(
	"packed Node consumer types, assets and builtin parity",
	() => {
		assert.ok(nodeExe);
		const npmCli = npmCliPath();
		const { archives, platformArchive, target, npmCache } = packClosure(npmCli);
		const consumer = join(packedRoot!, "consumer");
		fs.mkdirSync(consumer);
		fs.writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
		const consumerEnv = consumerProfileEnv(consumer);
		const execute = (args: string[], cwd: string, name: string, env = consumerEnv) =>
			runNodeLogged(args, cwd, name, env);
		const isolatedCache = execute([npmCli, "config", "get", "cache"], consumer, "isolated npm cache").stdout.trim();
		fs.writeSync(
			process.stdout.fd,
			`[packed-node-consumer] npm cache: isolated=${isolatedCache}; reused=${npmCache}\n`,
		);
		consumerEnv.npm_config_cache = npmCache;
		// Local tarball manifests lack the registry's _hasShrinkwrap marker. Seed
		// npm's root lock so this consumer uses the published dependency pins too.
		const publishedShrinkwrap = fs.readFileSync(join(packageDir, "npm-shrinkwrap.json"), "utf8");
		fs.writeFileSync(join(consumer, "npm-shrinkwrap.json"), publishedShrinkwrap);
		execute(
			[
				npmCli,
				"install",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--save-exact",
				...archives,
				platformArchive,
				"typescript@7.0.2",
				"@types/node@24.12.4",
			],
			consumer,
			"install packed closure",
		);
		const installed = join(consumer, "node_modules", "@bastani");
		for (const name of [
			"atomic",
			"atomic-ai",
			"atomic-agent-core",
			"atomic-codemode",
			"atomic-schema",
			"atomic-telemetry",
			"atomic-tui",
			"atomic-natives",
		]) {
			assert.ok(fs.realpathSync(join(installed, name)).startsWith(fs.realpathSync(consumer)));
		}
		const shrinkwrap = fs.readFileSync(join(installed, "atomic", "npm-shrinkwrap.json"), "utf8");
		assert.equal(shrinkwrap, publishedShrinkwrap, "the packed shrinkwrap must match the consumer's lock seed");
		assert.ok(!shrinkwrap.includes(repoRoot));
		assert.doesNotMatch(shrinkwrap, /"(?:link|resolved)"\s*:\s*(?:true|"(?:file:|\.\.\/|packages\/))/);
		assert.ok(!fs.readdirSync(join(installed, "atomic-natives", "native")).some((name) => name.endsWith(".node")));
		assert.ok(fs.existsSync(join(installed, `atomic-natives-${target}`, `atomic_natives.${target}.node`)));
		const fixtures = [
			"consumer-parity-types.mts",
			"consumer-parity.mjs",
			"sdk-host-fixture-support.mjs",
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
		assert.equal(withoutSqliteExperimentalWarning(runtime.stderr), "");
		assert.match(runtime.stdout, /"packedConsumer":true/);
	},
	PACKED_NODE_CONSUMER_TIMEOUT_MS,
);

/** How long an interactive start that stops before its first frame may take: a real CLI loading under Node. */
const STOPPED_START_TIMEOUT_MS = 60_000;

runTest(
	"an install that omits optional dependencies stops in every mode with one message naming the left-out package",
	async () => {
		assert.ok(nodeExe);
		const npmCli = npmCliPath();
		const { archives, target, npmCache } = packClosure(npmCli);
		const consumer = join(packedRoot!, "consumer-without-optional");
		fs.mkdirSync(consumer);
		fs.writeFileSync(join(consumer, "package.json"), JSON.stringify({ private: true, type: "module" }));
		fs.copyFileSync(join(packageDir, "npm-shrinkwrap.json"), join(consumer, "npm-shrinkwrap.json"));
		const env = consumerProfileEnv(consumer, npmCache);
		runNodeLogged(
			[
				npmCli,
				"install",
				"--omit=optional",
				"--ignore-scripts",
				"--no-audit",
				"--no-fund",
				"--save-exact",
				...archives,
			],
			consumer,
			"install without optional dependencies",
			env,
		);
		const installed = join(consumer, "node_modules", "@bastani");
		assert.ok(fs.existsSync(join(installed, "atomic-natives", "native", "index.js")));
		assert.ok(!fs.existsSync(join(installed, `atomic-natives-${target}`)), "npm left the platform package out");
		const expected =
			"Atomic's native module is not installed: this install of Atomic omitted optional dependencies, which leaves out " +
			`@bastani/atomic-natives-${target}. Reinstall Atomic with optional dependencies: npm install -g @bastani/atomic, ` +
			"pnpm add -g @bastani/atomic or bun add -g @bastani/atomic, without --omit=optional (npm, Bun) or --no-optional " +
			"(pnpm); in a project, run its install without those options.";
		const cli = join(installed, "atomic", "dist", "cli.js");
		const project = join(consumer, "project");
		fs.mkdirSync(join(project, ".atomic"), { recursive: true });
		const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

		for (const [mode, args] of [
			["print", ["-p", "hello"]],
			["json", ["--mode", "json", "-p", "hello"]],
			["rpc", ["--mode", "rpc"]],
		] as const) {
			const result = runNodeLogged(
				[cli, "--offline", ...args],
				project,
				`${mode} mode without optional dependencies`,
				env,
				1,
			);
			assert.equal(plain(withoutSqliteExperimentalWarning(result.stderr)), `Error: ${expected}\n`, mode);
			assert.equal(result.stdout, "", `${mode}: nothing on stdout`);
		}

		fs.writeFileSync(
			join(consumer, "sdk-without-native-module.mjs"),
			`import { createAgentSession } from "@bastani/atomic";
const written = [];
const write = process.stderr.write;
process.stderr.write = (chunk) => (written.push(String(chunk)), true);
let outcome;
try {
	await createAgentSession({ cwd: ${JSON.stringify(project)} });
	outcome = { created: true };
} catch (error) {
	outcome = { name: error.name, code: error.code, message: error.message };
}
process.stderr.write = write;
console.log(JSON.stringify({ ...outcome, stderr: written.join("") }));
`,
		);
		const sdk = runNodeLogged(
			[join(consumer, "sdk-without-native-module.mjs")],
			consumer,
			"SDK without optional dependencies",
			env,
		);
		const outcome = JSON.parse(sdk.stdout) as { name?: string; code?: string; message?: string; stderr: string };
		assert.deepEqual(
			{ ...outcome, stderr: withoutSqliteExperimentalWarning(outcome.stderr) },
			{ name: "NativeModuleUnavailableError", code: "NativeModuleUnavailable", message: expected, stderr: "" },
		);

		// Both interactive hosts: the isolated engine host for a trusted folder, the in-process one for an untrusted one.
		for (const trust of ["--approve", "--no-approve"]) {
			const program = startPtyProgram({
				executable: nodeExe,
				args: [cli, "--offline", trust],
				cwd: project,
				env: Object.fromEntries(
					Object.entries({ ...env, TERM: "xterm-256color" }).filter(
						(entry): entry is [string, string] => entry[1] !== undefined,
					),
				),
				timeoutMs: STOPPED_START_TIMEOUT_MS,
				cols: 500,
				rows: 24,
			});
			try {
				const exit = await program.exited;
				assert.deepEqual(exit, { exitCode: 1, timedOut: false }, program.screen());
				const lines = program
					.screen()
					.split("\n")
					.map((line) => line.trimEnd())
					.filter(
						(line) => line !== "" && !line.includes("ExperimentalWarning") && !line.includes("--trace-warnings"),
					);
				// The message alone: nothing of the early editor, which may have shown before the session started, stays.
				assert.deepEqual(lines, [`Error: ${expected}`], `${trust}:\n${program.screen()}`);
			} finally {
				program.kill();
			}
		}
	},
	PACKED_NODE_CONSUMER_TIMEOUT_MS,
);

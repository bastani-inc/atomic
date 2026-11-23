/**
 * Regression tests proving that memoized lazy imports and loaders never permanently poison their cache on a
 * transient failure (such as an in-place update directory swap) and still report update-restart errors when an
 * updated module genuinely cannot load.
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, test, vi } from "vitest";
import {
	gateSource,
	RELEASE_MODULE_STUB,
	releaseVersionModules,
} from "../../packages/coding-agent/scripts/in-place-update-gate.mjs";
import { createBrokerHostModulePlugin } from "../../packages/coding-agent/src/bun/internal-intercom-broker.ts";
import {
	BUILTIN_PACKAGE_DIR_NAMES,
	INSTALLED_EXTENSION_ENTRIES,
} from "../../packages/coding-agent/src/core/builtin-install-layout.ts";
import {
	isNativeBuiltinExtensionPath,
	resetNativeBuiltinExtensionEntriesForTest,
} from "../../packages/coding-agent/src/core/extensions/native-builtin-entries.ts";
import { memoizeAsync, memoizeAsyncByKey } from "../../packages/coding-agent/src/utils/memoize-async.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const REPO_ROOT = resolve(moduleDir(import.meta.url), "../..");
const CODING_AGENT_ROOT = join(REPO_ROOT, "packages/coding-agent");
const CHILD_TIMEOUT_MS = 60_000;

const cleanupPaths: string[] = [];
const originalPackageDir = process.env.ATOMIC_PACKAGE_DIR;

afterEach(() => {
	vi.restoreAllMocks();
	vi.doUnmock("markit-ai");
	vi.doUnmock("@silvia-odwyer/photon-node");
	if (originalPackageDir === undefined) delete process.env.ATOMIC_PACKAGE_DIR;
	else process.env.ATOMIC_PACKAGE_DIR = originalPackageDir;
	resetNativeBuiltinExtensionEntriesForTest();
	while (cleanupPaths.length > 0) {
		const target = cleanupPaths.pop()!;
		removeTempDirectory(target);
	}
});

/**
 * Stages a self-contained copy of the built `@bastani/atomic` package under the repository's cache directory so its
 * parent `node_modules` resolves every dependency while its own `dist/` and `package.json` are freely mutable.
 */
function stageBuiltPackage(): { readonly root: string; readonly packageDir: string } {
	const cacheRoot = join(REPO_ROOT, "node_modules", ".cache", "atomic-lazy-import-retry-test");
	mkdirSync(cacheRoot, { recursive: true });
	const root = mkdtempSync(join(cacheRoot, "pkg-"));
	cleanupPaths.push(root);
	const packageDir = join(root, "node_modules", "@bastani", "atomic");
	mkdirSync(packageDir, { recursive: true });
	cpSync(join(CODING_AGENT_ROOT, "package.json"), join(packageDir, "package.json"));
	cpSync(join(CODING_AGENT_ROOT, "dist"), join(packageDir, "dist"), {
		recursive: true,
		filter: (src) => !src.endsWith(".map") && !src.endsWith(".d.ts"),
	});
	return { root, packageDir };
}

function runBuiltDistScript(
	runtime: "node" | "bun",
	root: string,
	scriptBody: string,
	args: string[],
	env: Record<string, string> = {},
): Record<string, unknown> {
	const scriptPath = join(root, `probe-${runtime}.mjs`);
	writeFileSync(scriptPath, scriptBody, "utf8");
	const executable = runtime === "bun" ? bunExecutable() : process.execPath;
	const result = spawnSyncCollect([executable, scriptPath, ...args], {
		cwd: root,
		timeout: CHILD_TIMEOUT_MS,
		env: { ...process.env, ...env },
	});
	assert.equal(result.exitCode, 0, `stderr:\n${result.stderr.toString()}\nstdout:\n${result.stdout.toString()}`);
	const lastLine = result.stdout.toString().trim().split("\n").at(-1) ?? "{}";
	return JSON.parse(lastLine) as Record<string, unknown>;
}

describe("built dist getCreateJiti and builtin loader mid-swap recovery", () => {
	test.each(["node", "bun"] as const)(
		"recovers getCreateJiti after a transient missing jiti-loader during an in-place swap (%s)",
		(runtime) => {
			const { root, packageDir } = stageBuiltPackage();
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			const userExt = join(root, "user-ext.ts");
			writeFileSync(userExt, "export default function ext() {}\n", "utf8");

			const outcome = runBuiltDistScript(
				runtime,
				root,
				`
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, userExt, agentDir] = process.argv.slice(2);
const loader = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader-virtual-modules.js")).href);
const jitiFiles = ["jiti-loader.code.js", "jiti-loader.impl.js", "jiti-loader.js"]
	.map((name) => join(packageDir, "dist/core/extensions", name))
	.filter((file) => existsSync(file));

// Simulate npm directory swap transiently removing jiti-loader files.
for (const file of jitiFiles) renameSync(file, file + ".swap");
let firstError = null;
try {
	await loader.loadExtensionModule(userExt, undefined, agentDir);
} catch (error) {
	firstError = { name: error?.name, code: error?.code ?? error?.cause?.code, message: String(error?.message ?? error) };
}

// Swap completes: restore files on disk.
for (const file of jitiFiles) renameSync(file + ".swap", file);

let secondLoaded = false;
let secondError = null;
try {
	const factory = await loader.loadExtensionModule(userExt, undefined, agentDir);
	secondLoaded = typeof factory === "function";
} catch (error) {
	secondError = String(error?.message ?? error);
}

console.log(JSON.stringify({ firstError, secondLoaded, secondError }));
`,
				[packageDir, userExt, agentDir],
				{ ATOMIC_PACKAGE_DIR: packageDir, ATOMIC_CODING_AGENT_DIR: agentDir },
			);

			assert.ok(outcome.firstError !== null, "first load during swap must reject");
			assert.equal(
				outcome.secondLoaded,
				true,
				`second load after swap must recover instead of reusing rejected createJitiPromise (got error: ${String(outcome.secondError)})`,
			);
			assert.equal(outcome.secondError, null);
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"keeps the in-place-update restart error when jiti-loader is permanently incompatible after an update",
		() => {
			const { root, packageDir } = stageBuiltPackage();
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			const userExt = join(root, "user-ext.ts");
			writeFileSync(userExt, "export default function ext() {}\n", "utf8");

			const outcome = runBuiltDistScript(
				"node",
				root,
				`
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, userExt, agentDir] = process.argv.slice(2);
const loader = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader-virtual-modules.js")).href);

// Simulate a completed in-place update to a later version whose jiti-loader cannot link against this running process.
const manifestPath = join(packageDir, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const laterVersion = manifest.version + "-later.1";
manifest.version = laterVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\\n");
writeFileSync(
	join(packageDir, "dist/core/extensions/jiti-loader.code.js"),
	'import { nonexistentExportForTest } from "../../config.js";\\nexport const createJiti = () => nonexistentExportForTest;\\n',
);

const errors = [];
for (let i = 0; i < 2; i++) {
	try {
		await loader.loadExtensionModule(userExt, undefined, agentDir);
		errors.push({ ok: true });
	} catch (error) {
		errors.push({ name: error?.name, message: String(error?.message ?? error) });
	}
}
console.log(JSON.stringify({ laterVersion, errors }));
`,
				[packageDir, userExt, agentDir],
				{ ATOMIC_PACKAGE_DIR: packageDir, ATOMIC_CODING_AGENT_DIR: agentDir },
			);

			const laterVersion = String(outcome.laterVersion);
			const errors = outcome.errors as Array<{ name?: string; message?: string; ok?: boolean }>;
			assert.equal(errors.length, 2);
			for (const [index, entry] of errors.entries()) {
				assert.equal(entry.ok, undefined, `attempt ${index + 1} must reject`);
				assert.match(
					entry.message ?? "",
					new RegExp(
						`was updated to ${laterVersion.replaceAll(".", "\\.")} while this session was running; restart it`,
					),
				);
			}
		},
		CHILD_TIMEOUT_MS,
	);

	test(
		"recovers native builtin loading after a mid-swap failure instead of remaining forced onto jiti",
		() => {
			const { root, packageDir } = stageBuiltPackage();
			const agentDir = join(root, "agent");
			mkdirSync(agentDir, { recursive: true });
			const builtinEntry = join(packageDir, "dist/builtin/web-access/index.bundle.mjs");

			const outcome = runBuiltDistScript(
				"node",
				root,
				`
import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [packageDir, builtinEntry, agentDir] = process.argv.slice(2);
// Populate builtin discovery before the swap, matching a running interactive session.
const loader = await import(pathToFileURL(join(packageDir, "dist/core/extensions/loader-virtual-modules.js")).href);
const distIndex = join(packageDir, "dist/index.js");
const jitiFiles = ["jiti-loader.code.js", "jiti-loader.impl.js", "jiti-loader.js"]
	.map((name) => join(packageDir, "dist/core/extensions", name))
	.filter((file) => existsSync(file));

// Mid-swap: dist/index.js, builtin bundle, and jiti-loader are transiently absent.
renameSync(distIndex, distIndex + ".swap");
renameSync(builtinEntry, builtinEntry + ".swap");
for (const file of jitiFiles) renameSync(file, file + ".swap");

let firstFailed = false;
try {
	await loader.loadExtensionModule(builtinEntry, undefined, agentDir);
} catch {
	firstFailed = true;
}

// Swap completes: restore everything.
renameSync(distIndex + ".swap", distIndex);
renameSync(builtinEntry + ".swap", builtinEntry);
for (const file of jitiFiles) renameSync(file + ".swap", file);

let secondLoaded = false;
let loadedNatively = false;
let secondError = null;
try {
	const factory = await loader.loadExtensionModule(builtinEntry, undefined, agentDir);
	secondLoaded = typeof factory === "function";
	loadedNatively = loader.extensionLoaderTestHooks.hasNativeBuiltinFactory(builtinEntry);
} catch (error) {
	secondError = String(error?.message ?? error);
}

console.log(JSON.stringify({ firstFailed, secondLoaded, loadedNatively, secondError }));
`,
				[packageDir, builtinEntry, agentDir],
				{ ATOMIC_PACKAGE_DIR: packageDir, ATOMIC_CODING_AGENT_DIR: agentDir },
			);

			assert.equal(outcome.firstFailed, true);
			assert.equal(outcome.secondError, null);
			assert.equal(outcome.secondLoaded, true);
			assert.equal(
				outcome.loadedNatively,
				true,
				"installed builtin must recover its native load path after swap instead of staying poisoned onto jiti",
			);
		},
		CHILD_TIMEOUT_MS,
	);
});

describe("memoized lazy loaders across packages recover after transient failures", () => {
	test("native-builtin-entries does not cache an incomplete entry set across a transient swap", async () => {
		const packageDir = makeTempDirectory("atomic-native-entries-swap-");
		cleanupPaths.push(packageDir);
		for (const dirName of BUILTIN_PACKAGE_DIR_NAMES) {
			const builtinDir = join(packageDir, "builtin", dirName);
			const installedEntry = join(builtinDir, INSTALLED_EXTENSION_ENTRIES[dirName]);
			mkdirSync(dirname(installedEntry), { recursive: true });
			writeFileSync(join(builtinDir, "package.json"), JSON.stringify({ name: `@bastani/${dirName}` }));
			writeFileSync(installedEntry, "export default function register() {}\n");
		}
		process.env.ATOMIC_PACKAGE_DIR = packageDir;
		resetNativeBuiltinExtensionEntriesForTest();

		// Pre-warm builtin package discovery before the swap, as startup does.
		const { getBuiltinPackageLocations } = await import("../../packages/coding-agent/src/core/builtin-packages.ts");
		assert.equal(getBuiltinPackageLocations().length, BUILTIN_PACKAGE_DIR_NAMES.length);

		const subagentsEntry = resolve(packageDir, "builtin", "subagents", INSTALLED_EXTENSION_ENTRIES.subagents);
		const swapPath = `${subagentsEntry}.swap`;
		renameSync(subagentsEntry, swapPath);
		try {
			assert.equal(await isNativeBuiltinExtensionPath(subagentsEntry), false);
		} finally {
			renameSync(swapPath, subagentsEntry);
		}

		// After the file returns, a subsequent check must recover without any manual cache reset.
		assert.equal(await isNativeBuiltinExtensionPath(subagentsEntry), true);
	});

	test("native-builtin-entries does not cache a 3-of-4 set when one builtin directory is absent mid-swap", async () => {
		const packageDir = makeTempDirectory("atomic-native-entries-partial-swap-");
		cleanupPaths.push(packageDir);
		for (const dirName of BUILTIN_PACKAGE_DIR_NAMES) {
			const builtinDir = join(packageDir, "builtin", dirName);
			const installedEntry = join(builtinDir, INSTALLED_EXTENSION_ENTRIES[dirName]);
			mkdirSync(dirname(installedEntry), { recursive: true });
			writeFileSync(join(builtinDir, "package.json"), JSON.stringify({ name: `@bastani/${dirName}` }));
			writeFileSync(installedEntry, "export default function register() {}\n");
		}
		process.env.ATOMIC_PACKAGE_DIR = packageDir;
		resetNativeBuiltinExtensionEntriesForTest();

		const { getNativeBuiltinExtensionEntries } = await import(
			"../../packages/coding-agent/src/core/extensions/native-builtin-entries.ts"
		);
		const subDir = join(packageDir, "builtin", "subagents");
		const subSwap = join(packageDir, "builtin", "subagents.swap");
		const intercomEntry = resolve(packageDir, "builtin", "intercom", INSTALLED_EXTENSION_ENTRIES.intercom);
		const subagentsEntry = resolve(packageDir, "builtin", "subagents", INSTALLED_EXTENSION_ENTRIES.subagents);

		renameSync(subDir, subSwap);
		try {
			assert.equal(await isNativeBuiltinExtensionPath(intercomEntry), true);
		} finally {
			renameSync(subSwap, subDir);
		}

		assert.equal(await isNativeBuiltinExtensionPath(subagentsEntry), true);
		assert.equal((await getNativeBuiltinExtensionEntries()).size, BUILTIN_PACKAGE_DIR_NAMES.length);
	});

	test(
		"LegacySessionStore.deletionDatabase closes its opened database on post-open init failure without leaking workers or handles",
		() => {
			const root = makeTempDirectory("atomic-legacy-db-leak-");
			cleanupPaths.push(root);
			const outcome = runBuiltDistScript(
				"node",
				root,
				`
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

const [codingAgentRoot] = process.argv.slice(2);
const tmp = mkdtempSync(join(tmpdir(), "atomic-legacy-leak-child-"));
const agentDir = join(tmp, "agent");
const legacyDir = join(agentDir, "sessions");
mkdirSync(legacyDir, { recursive: true });
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;

const storageMod = await import(pathToFileURL(join(codingAgentRoot, "dist/core/storage/index.js")).href);
const dbPath = storageMod.defaultSessionDatabasePath(agentDir);
const sdk = await import(pathToFileURL(join(codingAgentRoot, "dist/index.js")).href);
await sdk.SessionManager.list(tmp, undefined);

writeFileSync(
	join(legacyDir, "2026-01-01T00-00-00-000Z_abc.jsonl"),
	JSON.stringify({ type: "session", version: 3, id: "abc", timestamp: "2026-01-01T00:00:00.000Z", cwd: tmp }) + "\\n",
);

const admin = new DatabaseSync(dbPath);
admin.exec("CREATE TABLE _tmp_blocker(x INT); CREATE INDEX session_legacy_deleted ON _tmp_blocker(x);");

const ss = await import(pathToFileURL(join(codingAgentRoot, "dist/core/session-storage.js")).href);
const store = await ss.resolveSessionStore(tmp, agentDir);

const fds = () => (process.platform === "linux" ? readdirSync("/proc/self/fd").length : -1);
const threads = () =>
	process.platform === "linux" ? Number(readFileSync("/proc/self/status", "utf8").match(/Threads:\\s+(\\d+)/)[1]) : -1;

const before = { threads: threads(), fds: fds() };
let failCount = 0;
for (let i = 0; i < 6; i++) {
	try {
		await store.readHeader("abc");
	} catch {
		failCount++;
	}
}
await new Promise((r) => setTimeout(r, 150));
const afterFailures = { threads: threads(), fds: fds() };

admin.exec("DROP INDEX session_legacy_deleted; DROP TABLE _tmp_blocker;");
admin.close();
const recoveredId = (await store.readHeader("abc"))?.id ?? null;
await store.close();
await new Promise((r) => setTimeout(r, 200));
const afterClose = { threads: threads(), fds: fds() };

let rmError = null;
try {
	rmSync(tmp, { recursive: true, force: false });
} catch (error) {
	rmError = { code: error?.code, message: String(error?.message ?? error) };
}
console.log(JSON.stringify({ platform: process.platform, failCount, recoveredId, before, afterFailures, afterClose, rmError }));
`,
				[CODING_AGENT_ROOT],
			);

			assert.equal(outcome.failCount, 6);
			assert.equal(outcome.recoveredId, "abc");
			assert.equal(
				outcome.rmError,
				null,
				`cleanup rmSync after store.close() must not fail: ${JSON.stringify(outcome.rmError)}`,
			);
			if (outcome.platform === "linux") {
				const before = outcome.before as { threads: number; fds: number };
				const afterFailures = outcome.afterFailures as { threads: number; fds: number };
				const afterClose = outcome.afterClose as { threads: number; fds: number };
				assert.ok(
					afterFailures.threads - before.threads <= 1,
					`threads leaked across 6 failed retries: before=${before.threads} afterFailures=${afterFailures.threads}`,
				);
				assert.ok(
					afterFailures.fds - before.fds <= 4,
					`FDs leaked across 6 failed retries: before=${before.fds} afterFailures=${afterFailures.fds}`,
				);
				assert.ok(
					afterClose.threads - before.threads <= 1,
					`threads still leaked after store.close(): before=${before.threads} afterClose=${afterClose.threads}`,
				);
				assert.ok(
					afterClose.fds - before.fds <= 4,
					`FDs still leaked after store.close(): before=${before.fds} afterClose=${afterClose.fds}`,
				);
			}
		},
		CHILD_TIMEOUT_MS,
	);

	test("createBrokerHostModulePlugin retries loadApp after a transient rejection and caches success", async () => {
		let attempts = 0;
		const plugin = createBrokerHostModulePlugin(async () => {
			attempts += 1;
			if (attempts === 1) throw new Error("transient app bundle missing");
			return {
				loadHostModule: async (specifier) => ({ specifier, attempt: attempts }),
			};
		});

		const callbacks = new Map<string, () => Promise<{ exports: object; loader: "object" }>>();
		plugin.setup({
			module(specifier, callback) {
				callbacks.set(specifier, callback);
			},
		});
		const resolveStorage = callbacks.get("@bastani/atomic/storage");
		assert.ok(resolveStorage);

		await assert.rejects(() => resolveStorage(), /transient app bundle missing/);
		const second = await resolveStorage();
		assert.deepEqual(second.exports, { specifier: "@bastani/atomic/storage", attempt: 2 });
		const third = await resolveStorage();
		assert.deepEqual(third.exports, { specifier: "@bastani/atomic/storage", attempt: 2 });
		assert.equal(attempts, 2);
	});

	test("markit retries dynamic import after a transient load rejection and caches the instance on success", async () => {
		vi.resetModules();
		let importCalls = 0;
		let constructions = 0;
		vi.doMock("markit-ai", () => {
			importCalls += 1;
			if (importCalls === 1) {
				throw Object.assign(new Error("Cannot find module 'markit-ai'"), { code: "ERR_MODULE_NOT_FOUND" });
			}
			return {
				Markit: class FakeMarkit {
					constructor() {
						constructions += 1;
					}
					async convert() {
						return { markdown: "# recovered" };
					}
				},
			};
		});

		const { convertBufferWithMarkit } = await import("../../packages/coding-agent/src/utils/markit.ts");
		const first = await convertBufferWithMarkit(new Uint8Array([1, 2, 3]), ".pdf");
		assert.equal(first.ok, false);

		const second = await convertBufferWithMarkit(new Uint8Array([1, 2, 3]), ".pdf");
		assert.equal(second.ok, true, `second conversion must recover (got error: ${second.error})`);
		assert.equal(second.content, "# recovered");

		const third = await convertBufferWithMarkit(new Uint8Array([1, 2, 3]), ".pdf");
		assert.equal(third.ok, true);
		assert.equal(constructions, 1, "Markit singleton must be reused after recovery");
	});

	test("loadPhoton retries after a transient import failure instead of caching null forever", async () => {
		vi.resetModules();
		let calls = 0;
		const fakePhoton = { PhotonImage: class {} };
		vi.doMock("@silvia-odwyer/photon-node", () => {
			calls += 1;
			if (calls === 1) {
				throw Object.assign(new Error("transient photon missing"), { code: "ERR_MODULE_NOT_FOUND" });
			}
			return fakePhoton;
		});

		const { loadPhoton } = await import("../../packages/coding-agent/src/utils/photon.ts");
		assert.equal(await loadPhoton(), null);
		const recovered = await loadPhoton();
		assert.equal(recovered?.PhotonImage, fakePhoton.PhotonImage);
		assert.equal(await loadPhoton(), recovered);
		assert.equal(calls, 2);
	});

	test("task-completion-history retries loading task-completion-entry after a transient rejection", async () => {
		vi.resetModules();
		let entryImportCalls = 0;
		const actualEntry = await vi.importActual<
			typeof import("../../packages/coding-agent/src/core/tasks/task-completion-entry.ts")
		>("../../packages/coding-agent/src/core/tasks/task-completion-entry.ts");
		vi.doMock("../../packages/coding-agent/src/core/tasks/task-completion-entry.ts", () => {
			entryImportCalls += 1;
			if (entryImportCalls === 1) {
				throw Object.assign(new Error("transient entry module missing"), { code: "ERR_MODULE_NOT_FOUND" });
			}
			return actualEntry;
		});
		try {
			const { AgentTaskHost } = await import("../../packages/coding-agent/src/core/tasks/agent-adapter.js");
			const { readTaskCompletionHistory } = await import(
				"../../packages/coding-agent/src/core/tasks/task-completion-history.ts"
			);
			const oversizedJson = JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: "2026-01-01T00:00:00.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello from oversized" }] },
			});
			const host = new AgentTaskHost({
				scope: { kind: "session", sessionId: "completion-history-retry" },
				authorizeLaunch() {},
			});
			const started = await host.startAgentTask(
				{ kind: "agent", agent: "debugger", task: "retry test", cwd: process.cwd() },
				"op-retry" as never,
				(context) => {
					context.bindTranscript({
						getSessionId: () => "child-retry",
						getEntries: () => [],
						loadHistory: async () => ({ entries: [] }),
						getFallbackEntries: () => [],
						async *readHistory() {
							yield {
								items: [
									{
										kind: "oversized" as const,
										sessionId: "child-retry",
										epoch: "1",
										seq: 1,
										bytes: oversizedJson.length,
									},
								],
							};
						},
						async *readHistoryChunks() {
							yield Buffer.from(oversizedJson, "utf8");
						},
					});
					return {
						result: Promise.resolve({
							kind: "completed" as const,
							output: {
								ownerId: context.ref.ownerId,
								taskId: context.ref.taskId,
								artifactId: `output:${context.ref.taskId}`,
								byteCount: "2",
								omittedRanges: [],
							},
						}),
						cleanup: Promise.resolve({ kind: "reaped" as const }),
					};
				},
			);
			assert.ok(started.ok);
			await host.waitForTask(started.value.taskId);
			const resolvedLease = host.resolveTask(started.value.taskId);
			assert.ok(resolvedLease.ok);

			const first = await readTaskCompletionHistory(resolvedLease.value);
			assert.ok(first?.unavailable, "first attempt should report unavailable due to transient load failure");

			const second = await readTaskCompletionHistory(resolvedLease.value);
			assert.equal(second?.unavailable, undefined, `second attempt must recover (got: ${second?.unavailable})`);
			assert.equal(second?.prompt, "hello from oversized");
			assert.equal(entryImportCalls, 2);
		} finally {
			vi.doUnmock("../../packages/coding-agent/src/core/tasks/task-completion-entry.ts");
		}
	});

	test("storage-postgres cloud auth lazyClient retries after transient failure and coalesces concurrent retries", () => {
		const root = makeTempDirectory("atomic-pg-auth-retry-");
		cleanupPaths.push(root);
		const authModuleUrl = pathToFileURL(join(REPO_ROOT, "packages/storage-postgres/auth.js")).href;
		const outcome = runBuiltDistScript(
			"node",
			root,
			`
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [root, authUrl] = process.argv.slice(2);
writeFileSync(join(root, "package.json"), '{"name":"pg-auth-test","private":true}\\n');
const counterFile = join(root, "constructions.txt");
writeFileSync(counterFile, "0");

const { createCloudPasswordProvider } = await import(authUrl);
const provider = createCloudPasswordProvider({
	auth: "azure-entra",
	host: "db.postgres.database.azure.com",
	port: 5432,
	user: "alice",
	searchPaths: [root],
});

let firstError = null;
try {
	await provider();
} catch (error) {
	firstError = String(error?.message ?? error);
}

// Install @azure/identity after the initial missing-package failure (do not pre-create the directory).
const pkgDir = join(root, "node_modules", "@azure", "identity");
mkdirSync(pkgDir, { recursive: true });
writeFileSync(join(pkgDir, "package.json"), '{"name":"@azure/identity","main":"index.cjs"}\\n');
writeFileSync(
	join(pkgDir, "index.cjs"),
	\`const fs = require("node:fs");
class DefaultAzureCredential {
  constructor() {
    const n = Number(fs.readFileSync(\${JSON.stringify(counterFile)}, "utf8")) + 1;
    fs.writeFileSync(\${JSON.stringify(counterFile)}, String(n));
  }
  async getToken() {
    return { token: "recovered-token", expiresOnTimestamp: Date.now() + 60 * 60 * 1000 };
  }
}
module.exports = { DefaultAzureCredential };
\`,
);

const [t1, t2] = await Promise.all([provider(), provider()]);
console.log(JSON.stringify({ firstError, t1, t2, constructions: Number(readFileSync(counterFile, "utf8")) }));
`,
			[root, authModuleUrl],
		);

		assert.match(String(outcome.firstError ?? ""), /optional package @azure\/identity/);
		assert.equal(outcome.t1, "recovered-token");
		assert.equal(outcome.t2, "recovered-token");
		assert.equal(outcome.constructions, 1);
	});

	test("in-place-update gate release probe does not permanently cache undefined across a mid-swap probe", () => {
		const root = makeTempDirectory("atomic-gate-probe-retry-");
		cleanupPaths.push(root);
		const dist = join(root, "dist");
		const records = [
			{
				version: "1.0.0",
				packages: {
					"@bastani/atomic": {
						files: { "dist/_shared/old.js": ["APP_NAME", "VERSION"], "dist/index.js": ["APP_NAME", "VERSION"] },
						startup: ["dist/_shared/old.js"],
						running: ["dist/index.js", "dist/_shared/old.js"],
					},
				},
			},
		];
		const { probes, stubs } = releaseVersionModules(records, (p: string) => p === "index.js");
		mkdirSync(join(dist, "_shared"), { recursive: true });
		mkdirSync(join(dist, "core", "a"), { recursive: true });
		mkdirSync(join(dist, "core", "b"), { recursive: true });
		writeFileSync(
			join(dist, "_shared", "old.js"),
			'export const VERSION = "1.0.0";\nexport const APP_NAME = "atomic";\n',
		);
		writeFileSync(
			join(dist, "core", "a", "entry.js"),
			gateSource({ path: "core/a/entry.js", code: "./entry.code.js", exports: ["a"], probes, version: "2.0.0" }),
		);
		writeFileSync(
			join(dist, "core", "b", "entry.js"),
			gateSource({ path: "core/b/entry.js", code: "./entry.code.js", exports: ["b"], probes, version: "2.0.0" }),
		);
		writeFileSync(join(dist, "core", "b", "entry.code.js"), 'throw new Error("broken in 2.0.0");\n');

		const outcome = runBuiltDistScript(
			"node",
			root,
			`
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [dist, stubsJson] = process.argv.slice(2);
const stubs = JSON.parse(stubsJson);
// Process holds 1.0.0's _shared/old.js.
await import(pathToFileURL(join(dist, "_shared/old.js")).href);

// Mid-swap: probe files are temporarily gone and core/a/entry.code.js is missing.
rmSync(join(dist, "_shared/old.js"));
let firstMsg = null;
try {
	await import(pathToFileURL(join(dist, "core/a/entry.js")).href);
} catch (error) {
	firstMsg = String(error?.message ?? error);
}

// Swap completes: stub is written back.
for (const stub of stubs) writeFileSync(join(dist, stub), ${JSON.stringify(RELEASE_MODULE_STUB)});
let secondMsg = null;
try {
	await import(pathToFileURL(join(dist, "core/b/entry.js")).href);
} catch (error) {
	secondMsg = String(error?.message ?? error);
}
console.log(JSON.stringify({ firstMsg, secondMsg }));
`,
			[dist, JSON.stringify(stubs)],
		);

		assert.ok(outcome.firstMsg !== null);
		assert.match(
			String(outcome.secondMsg ?? ""),
			/atomic was updated to 2\.0\.0 while this session was running; restart it/,
		);
	});
});

describe("memoizeAsync and memoizeAsyncByKey state-machine invariants", () => {
	test("clears a rejected flight before callers observe the rejection so immediate retry in catch starts a fresh load", async () => {
		let calls = 0;
		const load = memoizeAsync(async () => {
			calls += 1;
			if (calls === 1) throw new Error("boom-1");
			return `ok-${calls}`;
		});

		const first = load();
		let second: Promise<string> | undefined;
		let retriedValue: string | undefined;
		try {
			await first;
			assert.fail("first call must reject");
		} catch (error) {
			assert.match(String(error), /boom-1/);
			assert.equal(load.peek(), undefined);
			second = load();
			assert.notEqual(
				second,
				first,
				"immediate retry inside catch must start a new flight, not reuse the rejected one",
			);
			retriedValue = await second;
		}

		assert.equal(retriedValue, "ok-2");
		assert.equal(load.peek(), "ok-2");
		assert.equal(await load(), "ok-2");
		assert.equal(calls, 2);
	});

	test("coalesces concurrent callers onto one flight and lets concurrent waiters retry without clobbering the new flight", async () => {
		let calls = 0;
		let rejectFirst!: (error: Error) => void;
		let resolveSecond!: (value: string) => void;
		const load = memoizeAsync<string>(() => {
			calls += 1;
			if (calls === 1) {
				return new Promise((_resolve, reject) => {
					rejectFirst = reject;
				});
			}
			return new Promise((resolve) => {
				resolveSecond = resolve;
			});
		});

		const p1 = load();
		const p2 = load();
		assert.equal(p1, p2);
		assert.equal(calls, 1);

		const retryFromCaller1 = p1.catch(() => load());
		const observeCaller2 = p2.catch((err) => `saw:${(err as Error).message}`);
		rejectFirst(new Error("fail-1"));

		assert.equal(await observeCaller2, "saw:fail-1");
		// Caller 1's retry is now in-flight; a third caller must coalesce onto it rather than starting a 3rd flight.
		const p3 = load();
		assert.equal(calls, 2);
		resolveSecond("ok-2");
		assert.equal(await retryFromCaller1, "ok-2");
		assert.equal(await p3, "ok-2");
		assert.equal(calls, 2);
	});

	test("turns synchronous throws into rejected promises without poisoning the cache", async () => {
		let calls = 0;
		const load = memoizeAsync<string>(() => {
			calls += 1;
			if (calls === 1) throw new Error("sync-boom");
			return Promise.resolve("recovered");
		});

		const first = load();
		await assert.rejects(() => first, /sync-boom/);
		assert.equal(load.peek(), undefined);
		assert.equal(await load(), "recovered");
		assert.equal(load.peek(), "recovered");
		assert.equal(calls, 2);
	});

	test("never lets a superseded flight after reset() clobber a newer flight or populate peek()", async () => {
		let calls = 0;
		let resolve1!: (value: string) => void;
		let reject1!: (error: Error) => void;
		let resolve2!: (value: string) => void;
		const load = memoizeAsync<string>(() => {
			calls += 1;
			if (calls === 1) {
				return new Promise((resolve) => {
					resolve1 = resolve;
				});
			}
			if (calls === 2) {
				return new Promise((_resolve, reject) => {
					reject1 = reject;
				});
			}
			return new Promise((resolve) => {
				resolve2 = resolve;
			});
		});

		// Case A: flight 1 fulfills AFTER reset() -> must not repopulate peek() or overwrite flight 2.
		const f1 = load();
		load.reset();
		const f2 = load();
		resolve1("stale-1");
		assert.equal(await f1, "stale-1");
		assert.equal(load.peek(), undefined);

		// Case B: flight 2 rejects AFTER reset() and flight 3 starts -> must not clear flight 3!
		load.reset();
		const f3 = load();
		reject1(new Error("stale-reject-2"));
		await assert.rejects(() => f2, /stale-reject-2/);
		assert.equal(load(), f3, "stale rejection must not clobber newer flight 3");
		resolve2("fresh-3");
		assert.equal(await f3, "fresh-3");
		assert.equal(load.peek(), "fresh-3");
		assert.equal(calls, 3);
	});

	test("respects shouldCache: clears uncacheable sentinels and throwing predicates, caches valid results", async () => {
		let calls = 0;
		const load = memoizeAsync<string | null>(
			async () => {
				calls += 1;
				if (calls === 1) return null;
				if (calls === 2) return "throw-in-predicate";
				return "valid";
			},
			{
				shouldCache: (value) => {
					if (value === "throw-in-predicate") throw new Error("predicate-boom");
					return value !== null;
				},
			},
		);

		assert.equal(await load(), null);
		assert.equal(load.peek(), undefined);
		await assert.rejects(() => load(), /predicate-boom/);
		assert.equal(load.peek(), undefined);
		assert.equal(await load(), "valid");
		assert.equal(load.peek(), "valid");
		assert.equal(await load(), "valid");
		assert.equal(calls, 3);
	});

	test("memoizeAsyncByKey isolates keys, clears only matching identities, and supports per-key and full reset", async () => {
		const counts = new Map<string, number>();
		const load = memoizeAsyncByKey(
			async (key: string): Promise<string | null> => {
				const n = (counts.get(key) ?? 0) + 1;
				counts.set(key, n);
				if (key === "reject" && n === 1) throw new Error("key-reject");
				if (key === "sentinel" && n === 1) return null;
				return `${key}:${n}`;
			},
			{ shouldCache: (value) => value !== null },
		);

		await assert.rejects(() => load("reject"), /key-reject/);
		assert.equal(await load("reject"), "reject:2");
		assert.equal(await load("reject"), "reject:2");

		assert.equal(await load("sentinel"), null);
		assert.equal(await load("sentinel"), "sentinel:2");
		assert.equal(await load("sentinel"), "sentinel:2");

		load.reset("reject");
		assert.equal(await load("reject"), "reject:3");
		assert.equal(await load("sentinel"), "sentinel:2");

		load.reset();
		assert.equal(await load("sentinel"), "sentinel:3");
	});

	test("memoizeAsyncByKey never lets a superseded flight rejection or uncacheable result after reset(key) clobber a newer flight", async () => {
		let calls = 0;
		let reject1!: (error: Error) => void;
		let resolve2!: (value: string | null) => void;
		let resolve3!: (value: string | null) => void;
		let resolve4!: (value: string | null) => void;
		const load = memoizeAsyncByKey(
			(key: string): Promise<string | null> => {
				calls += 1;
				if (key === "k" && calls === 1) {
					return new Promise((_resolve, reject) => {
						reject1 = reject;
					});
				}
				if (key === "k" && calls === 2) {
					return new Promise((resolve) => {
						resolve2 = resolve;
					});
				}
				if (key === "k" && calls === 3) {
					return new Promise((resolve) => {
						resolve3 = resolve;
					});
				}
				return new Promise((resolve) => {
					resolve4 = resolve;
				});
			},
			{ shouldCache: (value) => value !== null },
		);

		// Case A: superseded flight 1 rejects after reset("k") and flight 2 started -> must NOT delete flight 2.
		const f1 = load("k");
		load.reset("k");
		const f2 = load("k");
		reject1(new Error("stale-key-reject"));
		await assert.rejects(() => f1, /stale-key-reject/);
		assert.equal(load("k"), f2, "stale rejection must not clobber newer flight for the same key");
		resolve2("fresh-2");
		assert.equal(await f2, "fresh-2");
		assert.equal(await load("k"), "fresh-2");

		// Case B: superseded flight 3 resolves with uncacheable null after reset("k") and flight 4 started -> must NOT delete flight 4.
		load.reset("k");
		const f3 = load("k");
		load.reset("k");
		const f4 = load("k");
		resolve3(null);
		assert.equal(await f3, null);
		assert.equal(load("k"), f4, "stale uncacheable settlement must not clobber newer flight for the same key");
		resolve4("fresh-4");
		assert.equal(await f4, "fresh-4");
		assert.equal(calls, 4);
	});
});

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { collectEverythingTracked, collectGarbage, trackCollection } from "../../../test/helpers/collect-garbage.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { clearExtensionCache, loadExtensionsCached } from "../src/core/extensions/loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createRpcCommandHandler } from "../src/modes/rpc/rpc-command-handler.ts";

const COMMAND = "probe-4986";

function replaceEnvironmentVariable(name: string, value: string): () => void {
	const previous = process.env[name];
	process.env[name] = value;
	return () => {
		if (previous === undefined) delete process.env[name];
		else process.env[name] = previous;
	};
}
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	clearExtensionCache();
});

function workspace() {
	const root = mkdtempSync(join(tmpdir(), "atomic-reload-current-code-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const extensionDir = join(agentDir, "extensions", "probe");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(join(extensionDir, "lib"), { recursive: true });
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	return { cwd, agentDir, extensionDir };
}

/** An extension whose command description names the version of its entry file and of the module it imports. */
function writeEntry(extensionDir: string, version: string): void {
	writeFileSync(
		join(extensionDir, "index.ts"),
		`import { helperVersion } from "./lib/helper.ts";
export default function (pi: any) {
	pi.registerCommand(${JSON.stringify(COMMAND)}, {
		description: "entry-${version} helper-" + helperVersion,
		handler: async () => {},
	});
}
`,
	);
}

function writeHelper(extensionDir: string, version: string): void {
	writeFileSync(join(extensionDir, "lib", "helper.ts"), `export const helperVersion: string = "${version}";\n`);
}

async function startRuntime(cwd: string, agentDir: string) {
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir,
			resourceLoaderOptions: { builtinPackagePaths: [], noSkills: true, noThemes: true, noPromptTemplates: true },
		});
		return {
			...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.inMemory(cwd),
	});
	cleanups.push(() => runtime.dispose());
	return runtime;
}

function probeDescription(runtime: Awaited<ReturnType<typeof startRuntime>>): string | undefined {
	return runtime.session.extensionRunner.getRegisteredCommands().find((command) => command.name === COMMAND)
		?.description;
}

describe("/reload runs the current code of edited extensions", () => {
	test("a session reload runs an edited extension file and an edited module it imports (#4986)", async () => {
		const { cwd, agentDir, extensionDir } = workspace();
		writeEntry(extensionDir, "1");
		writeHelper(extensionDir, "1");
		const runtime = await startRuntime(cwd, agentDir);
		assert.equal(probeDescription(runtime), "entry-1 helper-1");

		writeEntry(extensionDir, "2");
		await runtime.session.reload();
		assert.equal(probeDescription(runtime), "entry-2 helper-1");

		writeHelper(extensionDir, "3");
		await runtime.session.reload();
		assert.equal(probeDescription(runtime), "entry-2 helper-3");
	});

	test("an RPC reload runs an edited extension file and an edited module it imports (#4986)", async () => {
		const { cwd, agentDir, extensionDir } = workspace();
		writeEntry(extensionDir, "1");
		writeHelper(extensionDir, "1");
		const runtime = await startRuntime(cwd, agentDir);
		const handle = createRpcCommandHandler({
			runtimeHost: runtime,
			getSession: () => runtime.session,
			rebindSession: async () => {},
			output: () => {},
		});
		const description = async () => {
			const response = await handle({ id: "commands", type: "get_commands" });
			assert.ok(response?.success && response.command === "get_commands");
			return response.data.commands.find((command) => command.name === COMMAND)?.description;
		};
		assert.equal(await description(), "entry-1 helper-1");

		writeEntry(extensionDir, "2");
		assert.equal((await handle({ id: "reload-1", type: "reload" }))?.success, true);
		assert.equal(await description(), "entry-2 helper-1");

		writeHelper(extensionDir, "3");
		assert.equal((await handle({ id: "reload-2", type: "reload" }))?.success, true);
		assert.equal(await description(), "entry-2 helper-3");
	});

	for (const firstImport of ["transformed", "native"] as const) {
		test(`a reload reads an edited JSON file the extension imports, and one it imports later (${firstImport} first import)`, async () => {
			if (firstImport === "native") cleanups.push(replaceEnvironmentVariable("JITI_TRY_NATIVE", "true"));
			const lazyJson = globalThis as typeof globalThis & { __lazyJsonVersion?: () => Promise<string> };
			cleanups.push(() => {
				delete lazyJson.__lazyJsonVersion;
			});
			const { cwd, agentDir, extensionDir } = workspace();
			const writeJson = (name: string, version: string) =>
				writeFileSync(join(extensionDir, "lib", name), JSON.stringify({ version }));
			writeJson("config.json", "1");
			writeJson("later.json", "1");
			writeFileSync(
				join(extensionDir, "index.ts"),
				`import config from "./lib/config.json";
export default function (pi: any) {
	(globalThis as any).__lazyJsonVersion = async () => (await import("./lib/later.json")).default.version;
	pi.registerCommand(${JSON.stringify(COMMAND)}, { description: "config-" + config.version, handler: async () => {} });
}
`,
			);
			const runtime = await startRuntime(cwd, agentDir);
			assert.equal(probeDescription(runtime), "config-1");
			assert.equal(await lazyJson.__lazyJsonVersion?.(), "1");

			writeJson("config.json", "2");
			await runtime.session.reload();
			assert.equal(probeDescription(runtime), "config-2");

			writeJson("later.json", "3");
			await runtime.session.reload();
			assert.equal(await lazyJson.__lazyJsonVersion?.(), "3");
		});
	}

	// Bun (outside the compiled binary) first imports an extension natively. Node can strip the types of these
	// fixtures too, so asking jiti for native imports here takes the same path Bun does.
	test("a reload after a native first import runs an edited module the extension imports (#4986)", async () => {
		cleanups.push(replaceEnvironmentVariable("JITI_TRY_NATIVE", "true"));
		const { cwd, agentDir, extensionDir } = workspace();
		writeEntry(extensionDir, "1");
		writeHelper(extensionDir, "1");
		const runtime = await startRuntime(cwd, agentDir);
		assert.equal(probeDescription(runtime), "entry-1 helper-1");

		writeHelper(extensionDir, "2");
		await runtime.session.reload();
		assert.equal(probeDescription(runtime), "entry-1 helper-2");

		writeEntry(extensionDir, "3");
		writeHelper(extensionDir, "3");
		await runtime.session.reload();
		assert.equal(probeDescription(runtime), "entry-3 helper-3");
		const restartWarnings = (runtime.session.resourceLoader.getExtensions().warnings ?? []).filter((warning) =>
			/Restart Atomic/.test(warning.warning),
		);
		assert.deepEqual(restartWarnings, []);
	});

	test("fifty reloads of an edited extension keep memory bounded (#4986)", { timeout: 120_000 }, async () => {
		cleanups.push(replaceEnvironmentVariable("JITI_TRY_NATIVE", "true"));
		const tracked = trackCollection();
		const trackingGlobal = globalThis as typeof globalThis & { __trackReload4986?: (target: object) => void };
		trackingGlobal.__trackReload4986 = (target) => tracked.track(target);
		cleanups.push(() => {
			delete trackingGlobal.__trackReload4986;
		});
		const { cwd, agentDir, extensionDir } = workspace();
		// Each evaluation of the entry holds 4 MB, so a retained evaluation per reload shows in the heap too.
		const writeHeavyEntry = (version: number) =>
			writeFileSync(
				join(extensionDir, "index.ts"),
				`import { helperVersion } from "./lib/helper.ts";
const payload = { bytes: new Uint8Array(4 * 1024 * 1024).fill(${version % 255}) };
(globalThis as any).__trackReload4986(payload);
export default function (pi: any) {
	pi.registerCommand(${JSON.stringify(COMMAND)}, {
		description: "entry-${version} helper-" + helperVersion + (payload.bytes.length > 0 ? "" : " empty"),
		handler: async () => {},
	});
}
`,
			);
		writeHeavyEntry(0);
		writeHelper(extensionDir, "0");
		const runtime = await startRuntime(cwd, agentDir);

		const reloads = 50;
		let heapAfterWarmup = 0;
		for (let reload = 1; reload <= reloads; reload++) {
			writeHeavyEntry(reload);
			writeHelper(extensionDir, String(reload));
			await runtime.session.reload();
			assert.equal(probeDescription(runtime), `entry-${reload} helper-${reload}`);
			if (reload === 10) {
				await collectGarbage();
				heapAfterWarmup = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;
			}
		}
		await collectEverythingTracked(tracked, 100);
		await collectGarbage();
		const heapAfterLoop = process.memoryUsage().heapUsed + process.memoryUsage().arrayBuffers;

		assert.equal(tracked.created, reloads + 1);
		// The live generation and the first, natively imported one stay; every other evaluation is collected.
		assert.ok(tracked.uncollected().length <= 3, `uncollected evaluations: ${tracked.uncollected().join(", ")}`);
		// 40 retained evaluations would add 160 MB.
		const growthMb = (heapAfterLoop - heapAfterWarmup) / (1024 * 1024);
		assert.ok(growthMb < 40, `heap grew ${growthMb.toFixed(1)} MB over 40 reloads`);
	});
});

describe("reloads of a single JavaScript extension", () => {
	/** A reload of one extension path, as `/reload` does it: a new cache generation, then a cached load. */
	async function reloadWarnings(extensionPath: string, cwd: string, agentDir: string) {
		clearExtensionCache();
		const result = await loadExtensionsCached(
			[extensionPath],
			cwd,
			undefined,
			undefined,
			undefined,
			undefined,
			agentDir,
		);
		assert.deepEqual(result.errors, []);
		return (result.warnings ?? []).filter((warning) => warning.path === extensionPath);
	}

	const esmSource = (version: string) => `export default function () { globalThis.__esm4986 = "${version}"; }\n`;

	test("an edited .js extension that jiti compiles reloads its new code without a warning (#4986)", async () => {
		const { cwd, agentDir, extensionDir } = workspace();
		// ESM syntax outside a "type": "module" package is compiled, like TypeScript.
		const entry = join(extensionDir, "index.js");
		const loaded = globalThis as typeof globalThis & { __esm4986?: string };
		writeFileSync(entry, esmSource("1"));
		await reloadWarnings(entry, cwd, agentDir);
		assert.equal(loaded.__esm4986, "1");

		writeFileSync(entry, esmSource("22"));
		assert.deepEqual(await reloadWarnings(entry, cwd, agentDir), []);
		assert.equal(loaded.__esm4986, "22");
	});
});

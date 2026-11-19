import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Fill the run's shared extension transpile cache (`test/helpers/shared-transpile-cache.ts`) before any worker starts,
 * with one real load of every builtin package's extension entries through the extension loader, the way a session
 * loads them. Tests that link to the shared cache then find the builtin graph already compiled, including each file's
 * first test, which otherwise compiles it cold while the other workers do the same.
 *
 * Runs once in the orchestrator, after `global-setup-test-directory.ts` has created the run directory. Entries are
 * content-keyed, so a stale or partial cache only means a test compiles what is missing. A failure is reported and the
 * run continues: tests then compile on demand, as they did before.
 */
export default async function setup(): Promise<void> {
	const runDirectory = process.env.ATOMIC_TEST_RUN_DIR;
	if (runDirectory === undefined) return;
	const started = performance.now();
	try {
		const [
			{ sharedTranspileAgentDir },
			{ getBuiltinPackageLocations },
			{ loadExtensionModule },
			{ getExtensionTranspileCacheDir },
		] = await Promise.all([
			import("./helpers/shared-transpile-cache.ts"),
			import("../src/core/builtin-packages.ts"),
			import("../src/core/extensions/loader-virtual-modules.ts"),
			import("../src/config.ts"),
		]);
		const imported = performance.now();
		const agentDir = sharedTranspileAgentDir(runDirectory);
		mkdirSync(agentDir, { recursive: true });
		for (const location of getBuiltinPackageLocations()) {
			for (const entry of extensionEntries(location.packageDir)) {
				await loadExtensionModule(entry, undefined, agentDir);
			}
		}
		const entries = readdirSync(getExtensionTranspileCacheDir(agentDir)).length;
		console.log(
			`[warm-transpile-cache] compiled the builtin packages into the shared transpile cache in ${Math.round(performance.now() - imported)} ms after ${Math.round(imported - started)} ms loading the loader (${entries} entries)`,
		);
	} catch (error) {
		console.warn(
			`[warm-transpile-cache] could not warm the shared transpile cache after ${Math.round(performance.now() - started)} ms; tests compile on demand: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
		);
	}
}

/** The extension entries a builtin package declares in its manifest. */
function extensionEntries(packageDir: string): string[] {
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")) as {
		pi?: { extensions?: string[] };
		atomic?: { extensions?: string[] };
	};
	const entries = manifest.atomic?.extensions ?? manifest.pi?.extensions ?? [];
	return entries.map((entry) => resolve(packageDir, entry));
}

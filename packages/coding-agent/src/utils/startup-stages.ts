/**
 * Loads the modules an interactive session needs in stages, with a turn of the event loop between them, while the
 * early editor shows (`modes/interactive/startup-shell.ts`): on Node, importing a module graph runs all of it without a
 * turn of the event loop, so the early editor could not answer a key until the whole session had loaded.
 *
 * The build writes the stages (`scripts/write-startup-stages.mjs`) next to this build's modules, in `startup-stages/`:
 * loading them in order, then the session's entry modules, runs every module exactly once and in the order the runtime
 * the build ran on runs them for the entry modules alone. `cli.js` imports its entry modules at the same time, and
 * runtimes differ in which of their module graphs they run first (Node 22 does not run them in the order Node 24
 * does): the stages run them in the build runtime's order everywhere, one of the orders the language lets any runtime
 * run them in. None of them awaits at its top level in this build (the build checks it), so
 * each stage has run in full by the turn after it; a stage that has not (an installed package awaiting at its top level)
 * ends the stages there, so that nothing waits on a later stage.
 */
import { readFileSync } from "node:fs";
import { startupNodeOptions } from "@bastani/atomic-codemode/node-options";

interface StartupStages {
	readonly version: 1;
	readonly stages: number;
}

/**
 * Options under which code of the user's can resolve or load a module differently for each importer: a stage, a new
 * importer, could then load something else than the session's own modules would.
 */
const RESOLUTION_OPTIONS = new Set([
	"--require",
	"-r",
	"--import",
	"--loader",
	"--experimental-loader",
	"--preserve-symlinks",
	"--preserve-symlinks-main",
	"--experimental-policy",
	// Conditions choose which file of a package a name resolves to.
	"--conditions",
	"-C",
	"--no-addons",
	// A configuration file can hold any of these, which then show nowhere in the process's own options.
	"--experimental-config-file",
	"--experimental-default-config-file",
	"--config-file",
]);

/** Where this build's stages are: beside its own modules, found as this module's own imports are. */
const STAGES_DIR = new URL("../startup-stages/", import.meta.url);

function readStageCount(): number {
	try {
		const stages = JSON.parse(readFileSync(new URL("stages.json", STAGES_DIR), "utf8")) as StartupStages;
		return stages.version === 1 && Number.isInteger(stages.stages) ? stages.stages : 0;
	} catch {
		return 0;
	}
}

/**
 * Loads the stages one at a time, with a turn of the event loop after each. A stage that fails, or has not run in full
 * by the turn after it, ends the stages: the session's own imports then take the rest as before, and report a failure
 * where they always did. Without stages (a source checkout, a build without them), or with a preload, a module loader
 * or another option that changes how modules resolve, nothing loads here.
 */
export async function loadStartupStages(): Promise<void> {
	// Bun loads a module graph across turns of the event loop already, in an order that varies from run to run.
	if (process.versions.bun !== undefined) return;
	if (startupNodeOptions().some((option) => RESOLUTION_OPTIONS.has(option.name))) return;
	const count = readStageCount();
	for (let stage = 0; stage < count; stage++) {
		// Each stage has run in full before the next one starts: the order of the modules depends on it.
		const run: { outcome: "running" | "loaded" | "failed" } = { outcome: "running" };
		import(new URL(`${stage}.js`, STAGES_DIR).href).then(
			() => {
				run.outcome = "loaded";
			},
			() => {
				run.outcome = "failed";
			},
		);
		await new Promise<void>((resolve) => setImmediate(resolve));
		if (run.outcome !== "loaded") return;
	}
}

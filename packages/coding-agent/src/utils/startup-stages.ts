/**
 * Loads the modules an interactive session needs in stages, with a turn of the event loop between them, while the
 * early editor shows (`modes/interactive/startup-shell.ts`): on Node, importing a module graph runs all of it without a
 * turn of the event loop, so the early editor could not answer a key until the whole session had loaded.
 *
 * The build writes the stages (`scripts/write-startup-stages.mjs`) next to this build's modules, in `startup-stages/`:
 * loading them in order, then the session's entry modules, runs every module exactly once and in the order the runtime
 * runs them for the entry modules alone. None of them awaits at its top level (the build checks it), so waiting for a
 * stage never waits for a later one.
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
 * Loads the stages one at a time, with a turn of the event loop after each. A stage that fails ends the stages: the
 * session's own imports then fail the same way, where they always reported it. Without stages (a source checkout,
 * a build without them), or with a preload, a module loader or another option that changes how modules resolve,
 * nothing loads here.
 */
export async function loadStartupStages(): Promise<void> {
	// Bun loads a module graph across turns of the event loop already, in an order that varies from run to run.
	if (process.versions.bun !== undefined) return;
	if (startupNodeOptions().some((option) => RESOLUTION_OPTIONS.has(option.name))) return;
	const count = readStageCount();
	for (let stage = 0; stage < count; stage++) {
		// Each stage has run in full before the next one starts: the order of the modules depends on it.
		const loaded = await import(new URL(`${stage}.js`, STAGES_DIR).href).then(
			() => true,
			() => false,
		);
		if (!loaded) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

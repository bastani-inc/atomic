/**
 * Loads the modules an interactive session needs in stages, with a turn of the event loop between them, while the
 * early editor shows (`modes/interactive/startup-shell.ts`): importing a module graph runs all of it without a turn of
 * the event loop, so the early editor could not answer a key until the whole session had loaded.
 *
 * The build writes the stages (`scripts/write-startup-stages.mjs`) next to this build's modules, in `startup-stages/`:
 * loading them in order, then the session's entry modules, runs every module exactly once and in the order the runtime
 * runs them for the entry modules alone. None of them awaits at its top level (the build checks it), so waiting for a
 * stage never waits for a later one.
 */
import { readFileSync } from "node:fs";

interface StartupStages {
	readonly version: 1;
	readonly stages: number;
}

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
 * a build without them), nothing loads here.
 */
export async function loadStartupStages(): Promise<void> {
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

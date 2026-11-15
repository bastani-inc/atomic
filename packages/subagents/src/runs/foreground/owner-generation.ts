import { randomUUID } from "node:crypto";

const OWNER_GENERATION_KEY = Symbol.for("@bastani/subagents/owner-generation");

type OwnerGenerationHolder = { [OWNER_GENERATION_KEY]?: string };

/**
 * The owner process's generation: the same for every evaluation of this module in one process, such as an extension
 * `/reload`, and new in every process (#4848). A child released under another generation was released by a process
 * that is gone, with the calls it detached; one released under this generation still has them running here.
 */
export const SUBAGENT_OWNER_GENERATION: string = processOwnerGeneration();

function processOwnerGeneration(): string {
	const holder = globalThis as OwnerGenerationHolder;
	const kept = holder[OWNER_GENERATION_KEY];
	if (kept !== undefined) return kept;
	const generation = randomUUID();
	holder[OWNER_GENERATION_KEY] = generation;
	return generation;
}

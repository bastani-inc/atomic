import { scrubInteractiveEngineEnv } from "@bastani/atomic";

/**
 * Build a child environment from ordered layers, then remove Atomic's
 * interactive-engine control variables.
 *
 * Atomic already deletes those variables from its own `process.env` at startup;
 * scrubbing here is defense in depth for a caller-supplied or shared
 * environment that reintroduces one. The scrub deliberately runs LAST, after
 * `process.env`, the caller environment, and the subagent depth/workflow guards
 * have been merged, so no later layer can put a key back.
 */
export function buildSubagentSpawnEnv(
	...layers: Array<NodeJS.ProcessEnv | Record<string, string> | undefined>
): NodeJS.ProcessEnv {
	const merged: NodeJS.ProcessEnv = {};
	for (const layer of layers) {
		if (layer) Object.assign(merged, layer);
	}
	return scrubInteractiveEngineEnv(merged);
}

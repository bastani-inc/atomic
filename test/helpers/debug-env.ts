/**
 * Every variable that turns debug output on. Atomic writes `ATOMIC_DEBUG_SETTING` into the environment of every child
 * process it starts, so a suite started from an Atomic session, or with debug mode on, would otherwise inherit it.
 *
 * `test/unit/debug-mode.test.ts` fails when an area variable or a debug-mode name is missing here.
 */
export const DEBUG_ENV_VARS: readonly string[] = [
	"ATOMIC_DEBUG",
	"PI_DEBUG",
	"ATOMIC_DEBUG_SETTING",
	"ATOMIC_WORKFLOW_DEBUG",
	"ATOMIC_MODEL_ROUTING_DEBUG",
	"ATOMIC_DEBUG_POOLED_WATCH",
];

export function stripDebugEnvironment(env: NodeJS.ProcessEnv = process.env): void {
	for (const name of DEBUG_ENV_VARS) delete env[name];
}

/**
 * Supersession of file-based Herdr integrations by the builtin pane reporter.
 *
 * Herdr installs a `herdr-agent-state.ts` integration into the agent extension
 * directory of hosts that have no builtin reporter. Atomic has one, and inside
 * a Herdr pane exactly one writer may own the pane's agent state: two writers
 * make the label flap between agents, and a broken file integration that
 * merely *loads* used to silence the builtin and leave the pane unreported.
 *
 * The builtin therefore supersedes the installed asset at load time: when the
 * pane environment names this process as the pane's agent, the resource loader
 * skips the known integration files entirely, so they can neither report nor
 * displace the builtin. Outside a Herdr pane the builtin does nothing and the
 * file integration loads exactly as before.
 */

import { basename } from "node:path";

/** File-based Herdr integrations the builtin reporter supersedes. */
const HERDR_FILE_INTEGRATION_BASENAMES = new Set(["herdr-agent-state.ts", "herdr-agent-state.js"]);

/** Whether `path` is a known file-based Herdr integration, wherever it lives. */
export function isHerdrFileIntegrationPath(path: string): boolean {
	return HERDR_FILE_INTEGRATION_BASENAMES.has(basename(path));
}

/**
 * Whether this process runs inside a Herdr pane the builtin reporter can own.
 *
 * Mirrors the builtin's own activation gate (`readHerdrEnv`): all three
 * variables must be present and `HERDR_ENV` must be exactly `"1"`. Keeping the
 * two decisions on one predicate is what guarantees the loader never skips the
 * file integration in an environment where the builtin would not report.
 */
export function herdrPaneEnvironmentPresent(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.HERDR_ENV === "1" && !!env.HERDR_PANE_ID && !!env.HERDR_SOCKET_PATH;
}

/**
 * Drop superseded Herdr file integrations from an extension load set.
 *
 * Identity when nothing is skipped, so callers outside a Herdr pane see the
 * exact array they passed in.
 */
export function filterSupersededHerdrIntegrationPaths(paths: string[], env: NodeJS.ProcessEnv = process.env): string[] {
	if (!herdrPaneEnvironmentPresent(env)) return paths;
	if (!paths.some(isHerdrFileIntegrationPath)) return paths;
	return paths.filter((path) => !isHerdrFileIntegrationPath(path));
}

/**
 * Supersession of file-based Herdr integrations by the builtin pane reporter.
 *
 * Herdr installs a `herdr-agent-state.ts` integration into the agent extension
 * directory of hosts that have no builtin reporter — including the legacy Pi
 * root Atomic still auto-loads from. Atomic has a builtin reporter, and inside
 * a Herdr pane exactly one writer may own the pane's agent state: two writers
 * make the label flap between agents, and an installed integration that merely
 * *loads* used to silence the builtin and leave the pane unreported.
 *
 * The builtin therefore supersedes the installed asset at load time: when the
 * pane environment names this process as the pane's agent, the resource loader
 * skips the known integration files entirely, so they can neither report nor
 * displace the builtin. Outside a Herdr pane the builtin does nothing and the
 * file integration loads exactly as before.
 */

import { captureHerdrEnvironment } from "../../extensions/herdr/environment.js";

/** File-based Herdr integrations the builtin reporter supersedes. */
const HERDR_FILE_INTEGRATION_BASENAMES = new Set(["herdr-agent-state.ts", "herdr-agent-state.js"]);

/**
 * Last path segment, splitting on either separator.
 *
 * Not `node:path`'s `basename`, which leaves `\` inside a segment on POSIX: an
 * extension path can be recorded with Windows separators while the suite (and
 * a bundled run) evaluates it on a POSIX build.
 */
function lastSegment(path: string): string {
	const segments = path.split(/[\\/]/);
	return segments[segments.length - 1] ?? "";
}

/** Whether `path` is a known file-based Herdr integration, wherever it lives. */
export function isHerdrFileIntegrationPath(path: string): boolean {
	return HERDR_FILE_INTEGRATION_BASENAMES.has(lastSegment(path));
}

/**
 * Whether this process runs inside a Herdr pane the builtin reporter can own.
 *
 * Delegates to the builtin's own activation gate rather than restating the
 * variable list. One source of truth is what guarantees the loader never skips
 * the file integration in an environment where the builtin would not report —
 * a missing `HERDR_BIN_PATH`, for instance, leaves the pane to the installed
 * asset exactly as it is today.
 */
export function herdrPaneEnvironmentPresent(env: NodeJS.ProcessEnv = process.env): boolean {
	return captureHerdrEnvironment(env) !== undefined;
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

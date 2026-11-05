import { stripDebugEnvironment } from "./helpers/debug-env.js";

/**
 * Tests start with debug output off. Clear inherited debug variables in the runner before workers and their
 * subprocesses start, so a developer's debug mode, or the setting an Atomic session passes to its children, never
 * turns it on or writes to the developer's debug log. Tests that need debug mode turn it on themselves.
 */
export default function setup(): void {
	stripDebugEnvironment();
}

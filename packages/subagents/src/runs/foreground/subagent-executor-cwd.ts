import * as path from "node:path";

/** Resolve a caller-provided cwd against the current session cwd. */
export function resolveRequestedCwd(runtimeCwd: string, requestedCwd: string | undefined): string {
	return requestedCwd ? path.resolve(runtimeCwd, requestedCwd) : runtimeCwd;
}

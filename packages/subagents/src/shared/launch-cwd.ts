import { stat } from "node:fs/promises";

/** What a launch found at its working directory when it checked it, before its child starts. */
export interface CwdVerdict {
	readonly path: string;
	readonly state: "directory" | "missing" | "not-directory";
}

/** Checks `cwd` for a launch: missing when it cannot be read at all, as `existsSync` answers it. */
export async function checkLaunchCwd(cwd: string): Promise<CwdVerdict> {
	try {
		return { path: cwd, state: (await stat(cwd)).isDirectory() ? "directory" : "not-directory" };
	} catch {
		return { path: cwd, state: "missing" };
	}
}

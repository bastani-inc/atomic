import { stat } from "node:fs/promises";

export interface CwdVerdict {
	readonly path: string;
	readonly state: "directory" | "missing" | "not-directory";
}

export async function checkLaunchCwd(cwd: string): Promise<CwdVerdict> {
	try {
		return { path: cwd, state: (await stat(cwd)).isDirectory() ? "directory" : "not-directory" };
	} catch {
		return { path: cwd, state: "missing" };
	}
}

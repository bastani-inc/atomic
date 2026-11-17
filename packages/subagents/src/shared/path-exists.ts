import { access } from "node:fs/promises";

/** Whether `path` exists, as `existsSync` answers it: any error reads as absent. */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

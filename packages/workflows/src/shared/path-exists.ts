import { access } from "node:fs/promises";

/** Whether `path` exists; a path that cannot be inspected counts as missing, as with `existsSync`. */
export async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

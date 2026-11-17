import type { Stats } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

async function readText(file: string): Promise<string | undefined> {
	try {
		return await fs.readFile(file, "utf8");
	} catch {
		return undefined;
	}
}
async function samePath(left: string, right: string): Promise<boolean> {
	try {
		const [a, b] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	} catch {
		return false;
	}
}
export async function findGitRoot(cwd: string): Promise<string | undefined> {
	let current = path.resolve(cwd);
	try {
		if (!(await fs.stat(current)).isDirectory()) current = path.dirname(current);
	} catch {
		return undefined;
	}
	while (true) {
		try {
			const entry = await fs.stat(path.join(current, ".git"));
			if (entry.isDirectory() || entry.isFile()) return current;
		} catch {
			/* walk */
		}
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}
export async function resolveMainRepoRoot(repoRoot: string): Promise<string | undefined> {
	const gitEntry = path.join(repoRoot, ".git");
	let stats: Stats;
	try {
		stats = await fs.stat(gitEntry);
	} catch {
		return undefined;
	}
	if (stats.isDirectory()) return path.resolve(repoRoot);
	if (!stats.isFile()) return undefined;
	const contents = await readText(gitEntry);
	if (contents === undefined || !contents.startsWith("gitdir:")) return undefined;
	const pointer = contents.slice("gitdir:".length).trim();
	if (!pointer) return undefined;
	const gitDir = path.resolve(repoRoot, pointer);
	if (path.basename(path.dirname(gitDir)) !== "worktrees") return undefined;
	const commonGitDir = path.dirname(path.dirname(gitDir));
	if (path.basename(commonGitDir) !== ".git") return undefined;
	const back = (await readText(path.join(gitDir, "gitdir")))?.trim();
	const common = (await readText(path.join(gitDir, "commondir")))?.trim();
	if (!back || !common) return undefined;
	if (!(await samePath(path.resolve(gitDir, back), gitEntry))) return undefined;
	if (!(await samePath(path.resolve(gitDir, common), commonGitDir))) return undefined;
	return path.dirname(commonGitDir);
}
export async function findCanonicalGitRoot(cwd: string): Promise<string | undefined> {
	const repoRoot = await findGitRoot(cwd);
	return repoRoot === undefined ? undefined : resolveMainRepoRoot(repoRoot);
}

import * as fs from "node:fs";
import * as path from "node:path";

function readText(file: string): string | undefined {
	try { return fs.readFileSync(file, "utf8"); } catch { return undefined; }
}
function samePath(left: string, right: string): boolean {
	try {
		const a = fs.realpathSync.native(left);
		const b = fs.realpathSync.native(right);
		return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
	} catch { return false; }
}
export function findGitRoot(cwd: string): string | undefined {
	let current = path.resolve(cwd);
	try { if (!fs.statSync(current).isDirectory()) current = path.dirname(current); } catch { return undefined; }
	while (true) {
		try {
			const entry = fs.statSync(path.join(current, ".git"));
			if (entry.isDirectory() || entry.isFile()) return current;
		} catch { /* walk */ }
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}
export function resolveMainRepoRoot(repoRoot: string): string | undefined {
	const gitEntry = path.join(repoRoot, ".git");
	let stats: fs.Stats;
	try { stats = fs.statSync(gitEntry); } catch { return undefined; }
	if (stats.isDirectory()) return path.resolve(repoRoot);
	if (!stats.isFile()) return undefined;
	const contents = readText(gitEntry);
	if (contents === undefined || !contents.startsWith("gitdir:")) return undefined;
	const pointer = contents.slice("gitdir:".length).trim();
	if (!pointer) return undefined;
	const gitDir = path.resolve(repoRoot, pointer);
	if (path.basename(path.dirname(gitDir)) !== "worktrees") return undefined;
	const commonGitDir = path.dirname(path.dirname(gitDir));
	if (path.basename(commonGitDir) !== ".git") return undefined;
	const back = readText(path.join(gitDir, "gitdir"))?.trim();
	const common = readText(path.join(gitDir, "commondir"))?.trim();
	if (!back || !common) return undefined;
	if (!samePath(path.resolve(gitDir, back), gitEntry)) return undefined;
	if (!samePath(path.resolve(gitDir, common), commonGitDir)) return undefined;
	return path.dirname(commonGitDir);
}
export function findCanonicalGitRoot(cwd: string): string | undefined {
	const repoRoot = findGitRoot(cwd);
	return repoRoot === undefined ? undefined : resolveMainRepoRoot(repoRoot);
}

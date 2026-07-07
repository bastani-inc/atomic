import { access, readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { getManifestFromPackageJson } from "./package-manager-manifest.ts";
import { toPosixPath } from "./package-manager-resource-patterns.ts";
import { FILE_PATTERNS, type ResourceType } from "./package-manager-types.ts";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
const RESOURCE_DISCOVERY_YIELD_AFTER_MS = 8;
type IgnoreMatcher = ReturnType<typeof ignore>;
type SkillDiscoveryMode = "pi" | "agents";

type DirEntryInfo = {
	fullPath: string;
	isDir: boolean;
	isFile: boolean;
};

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) { negated = true; pattern = pattern.slice(1); }
	else if (pattern.startsWith("\\!")) pattern = pattern.slice(1);
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

async function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): Promise<void> {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
	for (const filename of IGNORE_FILE_NAMES) {
		try {
			const content = await readFile(join(dir, filename), "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) ig.add(patterns);
		} catch {}
	}
}

async function getEntryInfo(dir: string, name: string, isDirectory: boolean, isFileEntry: boolean, isSymlink: boolean): Promise<DirEntryInfo | null> {
	const fullPath = join(dir, name);
	let isDir = isDirectory;
	let isFile = isFileEntry;
	if (isSymlink) {
		try {
			const stats = await stat(fullPath);
			isDir = stats.isDirectory();
			isFile = stats.isFile();
		} catch { return null; }
	}
	return { fullPath, isDir, isFile };
}

export async function collectFiles(dir: string, filePattern: RegExp, skipNodeModules = true, ignoreMatcher?: IgnoreMatcher, rootDir?: string): Promise<string[]> {
	const files: string[] = [];
	if (!(await exists(dir))) return files;
	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	await addIgnoreRules(ig, dir, root);
	const startedAt = Date.now();
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			await yieldToEventLoopIfSlow(startedAt, RESOURCE_DISCOVERY_YIELD_AFTER_MS);
			if (entry.name.startsWith(".") || (skipNodeModules && entry.name === "node_modules")) continue;
			const info = await getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(root, info.fullPath));
			const ignorePath = info.isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;
			if (info.isDir) files.push(...await collectFiles(info.fullPath, filePattern, skipNodeModules, ig, root));
			else if (info.isFile && filePattern.test(entry.name)) files.push(info.fullPath);
		}
	} catch {}
	return files;
}

async function collectSkillEntries(dir: string, mode: SkillDiscoveryMode, ignoreMatcher?: IgnoreMatcher, rootDir?: string): Promise<string[]> {
	const entries: string[] = [];
	if (!(await exists(dir))) return entries;
	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	await addIgnoreRules(ig, dir, root);
	const startedAt = Date.now();
	try {
		const dirEntries = await readdir(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") continue;
			const info = await getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(root, info.fullPath));
			if (info.isFile && !ig.ignores(relPath)) { entries.push(info.fullPath); return entries; }
		}
		for (const entry of dirEntries) {
			await yieldToEventLoopIfSlow(startedAt, RESOURCE_DISCOVERY_YIELD_AFTER_MS);
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const info = await getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(root, info.fullPath));
			if (mode === "pi" && dir === root && info.isFile && entry.name.endsWith(".md") && !ig.ignores(relPath)) {
				entries.push(info.fullPath);
				continue;
			}
			if (!info.isDir || ig.ignores(`${relPath}/`)) continue;
			entries.push(...await collectSkillEntries(info.fullPath, mode, ig, root));
		}
	} catch {}
	return entries;
}

export async function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): Promise<string[]> {
	return collectSkillEntries(dir, mode);
}

async function findGitRepoRoot(startDir: string): Promise<string | null> {
	let dir = resolve(startDir);
	while (true) {
		if (await exists(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export async function collectAncestorAgentsSkillDirs(startDir: string): Promise<string[]> {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = await findGitRepoRoot(resolvedStartDir);
	let dir = resolvedStartDir;
	while (true) {
		skillDirs.push(join(dir, ".agents", "skills"));
		if (gitRepoRoot && dir === gitRepoRoot) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return skillDirs;
}

async function collectFlatEntries(dir: string, extension: string): Promise<string[]> {
	const entries: string[] = [];
	if (!(await exists(dir))) return entries;
	const ig = ignore();
	await addIgnoreRules(ig, dir, dir);
	const startedAt = Date.now();
	try {
		const dirEntries = await readdir(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			await yieldToEventLoopIfSlow(startedAt, RESOURCE_DISCOVERY_YIELD_AFTER_MS);
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const info = await getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(dir, info.fullPath));
			if (ig.ignores(relPath)) continue;
			if (info.isFile && entry.name.endsWith(extension)) entries.push(info.fullPath);
		}
	} catch {}
	return entries;
}

export async function collectAutoPromptEntries(dir: string): Promise<string[]> {
	return collectFlatEntries(dir, ".md");
}

export async function collectAutoThemeEntries(dir: string): Promise<string[]> {
	return collectFlatEntries(dir, ".json");
}

export async function resolveExtensionEntries(dir: string): Promise<string[] | null> {
	const packageJsonPath = join(dir, "package.json");
	if (await exists(packageJsonPath)) {
		try {
			const pkg = JSON.parse(await readFile(packageJsonPath, "utf-8")) as Record<string, unknown>;
			const manifest = getManifestFromPackageJson(pkg);
			if (manifest?.extensions?.length) {
				const entries: string[] = [];
				for (const extPath of manifest.extensions) {
					const resolvedExtPath = resolve(dir, extPath);
					if (await exists(resolvedExtPath)) entries.push(resolvedExtPath);
				}
				if (entries.length > 0) return entries;
			}
		} catch {}
	}
	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (await exists(indexTs)) return [indexTs];
	if (await exists(indexJs)) return [indexJs];
	return null;
}

export async function collectAutoExtensionEntries(dir: string): Promise<string[]> {
	const entries: string[] = [];
	if (!(await exists(dir))) return entries;
	const rootEntries = await resolveExtensionEntries(dir);
	if (rootEntries) return rootEntries;
	const ig = ignore();
	await addIgnoreRules(ig, dir, dir);
	const startedAt = Date.now();
	try {
		const dirEntries = await readdir(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			await yieldToEventLoopIfSlow(startedAt, RESOURCE_DISCOVERY_YIELD_AFTER_MS);
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const info = await getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(dir, info.fullPath));
			const ignorePath = info.isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;
			if (info.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) entries.push(info.fullPath);
			else if (info.isDir) {
				const resolvedEntries = await resolveExtensionEntries(info.fullPath);
				if (resolvedEntries) entries.push(...resolvedEntries);
			}
		}
	} catch {}
	return entries;
}

export async function collectResourceFiles(dir: string, resourceType: ResourceType): Promise<string[]> {
	if (resourceType === "skills") return collectSkillEntries(dir, "pi");
	if (resourceType === "extensions") return collectAutoExtensionEntries(dir);
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

export function isPathUnder(target: string, root: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	return resolvedTarget === resolvedRoot || resolvedTarget.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`);
}

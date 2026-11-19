import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { pathExists as exists } from "../utils/path-exists.ts";
import { stripBom } from "../utils/text.ts";
import { NestedGitignore } from "./gitignore-rules.ts";
import { getManifestFromPackageJson } from "./package-manager-manifest.ts";
import { toPosixPath } from "./package-manager-resource-patterns.ts";
import { FILE_PATTERNS, type FileKind } from "./package-manager-types.ts";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
const RESOURCE_DISCOVERY_YIELD_AFTER_MS = 8;
type IgnoreMatcher = NestedGitignore;
type SkillDiscoveryMode = "pi" | "agents";

type DirEntryInfo = {
	fullPath: string;
	isDir: boolean;
	isFile: boolean;
};

async function withIgnoreRules(rules: NestedGitignore, dir: string, rootDir: string): Promise<NestedGitignore> {
	const contents: string[] = [];
	for (const filename of IGNORE_FILE_NAMES) {
		try {
			contents.push(await readFile(join(dir, filename), "utf-8"));
		} catch {}
	}
	return rules.within(toPosixPath(relative(rootDir, dir)), contents);
}

async function getEntryInfo(
	dir: string,
	name: string,
	isDirectory: boolean,
	isFileEntry: boolean,
	isSymlink: boolean,
): Promise<DirEntryInfo | null> {
	const fullPath = join(dir, name);
	let isDir = isDirectory;
	let isFile = isFileEntry;
	if (isSymlink) {
		try {
			const stats = await stat(fullPath);
			isDir = stats.isDirectory();
			isFile = stats.isFile();
		} catch {
			return null;
		}
	}
	return { fullPath, isDir, isFile };
}

export async function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
	excludeTopLevel?: ReadonlySet<string>,
): Promise<string[]> {
	const files: string[] = [];
	if (!(await exists(dir))) return files;
	const root = rootDir ?? dir;
	const ig = await withIgnoreRules(ignoreMatcher ?? NestedGitignore.empty(), dir, root);
	const startedAt = Date.now();
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			await yieldToEventLoopIfSlow(startedAt, RESOURCE_DISCOVERY_YIELD_AFTER_MS);
			if (entry.name.startsWith(".") || (skipNodeModules && entry.name === "node_modules")) continue;
			if (dir === root && excludeTopLevel?.has(entry.name)) continue;
			const info = await getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(root, info.fullPath));
			const ignorePath = info.isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;
			if (info.isDir) files.push(...(await collectFiles(info.fullPath, filePattern, skipNodeModules, ig, root)));
			else if (info.isFile && filePattern.test(entry.name)) files.push(info.fullPath);
		}
	} catch {}
	return files;
}

async function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): Promise<string[]> {
	const entries: string[] = [];
	if (!(await exists(dir))) return entries;
	const root = rootDir ?? dir;
	const ig = await withIgnoreRules(ignoreMatcher ?? NestedGitignore.empty(), dir, root);
	const startedAt = Date.now();
	try {
		const dirEntries = await readdir(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") continue;
			const info = await getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(root, info.fullPath));
			if (info.isFile && !ig.ignores(relPath)) {
				entries.push(info.fullPath);
				return entries;
			}
		}
		for (const entry of dirEntries) {
			await yieldToEventLoopIfSlow(startedAt, RESOURCE_DISCOVERY_YIELD_AFTER_MS);
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const info = await getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(root, info.fullPath));
			const shouldIncludeMarkdownFile =
				info.isFile &&
				entry.name.endsWith(".md") &&
				!ig.ignores(relPath) &&
				((mode === "pi" && dir === root) || (mode === "agents" && dir !== root));
			if (shouldIncludeMarkdownFile) {
				entries.push(info.fullPath);
				continue;
			}
			if (!info.isDir || ig.ignores(`${relPath}/`)) continue;
			entries.push(...(await collectSkillEntries(info.fullPath, mode, ig, root)));
		}
	} catch {}
	return entries;
}

export async function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): Promise<string[]> {
	return collectSkillEntries(dir, mode);
}

async function findGitRepoRoot(startDir: string): Promise<string | null> {
	const directories: string[] = [];
	for (let dir = resolve(startDir); ; dir = dirname(dir)) {
		directories.push(dir);
		if (dirname(dir) === dir) break;
	}
	const present = await Promise.all(directories.map((dir) => exists(join(dir, ".git"))));
	return directories.find((_, index) => present[index]) ?? null;
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
	const ig = await withIgnoreRules(NestedGitignore.empty(), dir, dir);
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
			const manifest = getManifestFromPackageJson(JSON.parse(stripBom(await readFile(packageJsonPath, "utf-8"))));
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
	const ig = await withIgnoreRules(NestedGitignore.empty(), dir, dir);
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

export async function collectResourceFiles(
	dir: string,
	resourceType: FileKind,
	excludeTopLevel?: ReadonlySet<string>,
): Promise<string[]> {
	if (resourceType === "skills") return collectSkillEntries(dir, "pi");
	if (resourceType === "extensions") return collectAutoExtensionEntries(dir);
	return collectFiles(dir, FILE_PATTERNS[resourceType], true, undefined, undefined, excludeTopLevel);
}

export function isPathUnder(target: string, root: string): boolean {
	const resolvedRoot = resolve(root);
	const resolvedTarget = resolve(target);
	return (
		resolvedTarget === resolvedRoot ||
		resolvedTarget.startsWith(resolvedRoot.endsWith(sep) ? resolvedRoot : `${resolvedRoot}${sep}`)
	);
}

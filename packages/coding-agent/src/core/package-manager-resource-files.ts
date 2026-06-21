import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import ignore from "ignore";
import { readPiManifestFile } from "./package-manager-manifest.ts";
import { toPosixPath } from "./package-manager-resource-patterns.ts";
import { FILE_PATTERNS, type ResourceType } from "./package-manager-types.ts";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
type IgnoreMatcher = ReturnType<typeof ignore>;

type DirEntryInfo = {
	fullPath: string;
	isDir: boolean;
	isFile: boolean;
};

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		if (!existsSync(ignorePath)) continue;
		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				ig.add(patterns);
			}
		} catch {}
	}
}

function getEntryInfo(dir: string, name: string, isDirectory: boolean, isFileEntry: boolean, isSymlink: boolean): DirEntryInfo | null {
	const fullPath = join(dir, name);
	let isDir = isDirectory;
	let isFile = isFileEntry;
	if (isSymlink) {
		try {
			const stats = statSync(fullPath);
			isDir = stats.isDirectory();
			isFile = stats.isFile();
		} catch {
			return null;
		}
	}
	return { fullPath, isDir, isFile };
}

export function collectFiles(
	dir: string,
	filePattern: RegExp,
	skipNodeModules = true,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const files: string[] = [];
	if (!existsSync(dir)) return files;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (skipNodeModules && entry.name === "node_modules") continue;

			const info = getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;

			const relPath = toPosixPath(relative(root, info.fullPath));
			const ignorePath = info.isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (info.isDir) {
				files.push(...collectFiles(info.fullPath, filePattern, skipNodeModules, ig, root));
			} else if (info.isFile && filePattern.test(entry.name)) {
				files.push(info.fullPath);
			}
		}
	} catch {}

	return files;
}

type SkillDiscoveryMode = "pi" | "agents";

function collectSkillEntries(
	dir: string,
	mode: SkillDiscoveryMode,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	addIgnoreRules(ig, dir, root);

	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name !== "SKILL.md") continue;
			const info = getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(root, info.fullPath));
			if (info.isFile && !ig.ignores(relPath)) {
				entries.push(info.fullPath);
				return entries;
			}
		}

		for (const entry of dirEntries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue;
			const info = getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;

			const relPath = toPosixPath(relative(root, info.fullPath));
			if (mode === "pi" && dir === root && info.isFile && entry.name.endsWith(".md") && !ig.ignores(relPath)) {
				entries.push(info.fullPath);
				continue;
			}
			if (!info.isDir || ig.ignores(`${relPath}/`)) continue;
			entries.push(...collectSkillEntries(info.fullPath, mode, ig, root));
		}
	} catch {}

	return entries;
}

export function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
	return collectSkillEntries(dir, mode);
}

function findGitRepoRoot(startDir: string): string | null {
	let dir = resolve(startDir);
	while (true) {
		if (existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function collectAncestorAgentsSkillDirs(startDir: string): string[] {
	const skillDirs: string[] = [];
	const resolvedStartDir = resolve(startDir);
	const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

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

function collectFlatEntries(dir: string, extension: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);
	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const info = getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;
			const relPath = toPosixPath(relative(dir, info.fullPath));
			if (ig.ignores(relPath)) continue;
			if (info.isFile && entry.name.endsWith(extension)) entries.push(info.fullPath);
		}
	} catch {}
	return entries;
}

export function collectAutoPromptEntries(dir: string): string[] {
	return collectFlatEntries(dir, ".md");
}

export function collectAutoThemeEntries(dir: string): string[] {
	return collectFlatEntries(dir, ".json");
}

export function resolveExtensionEntries(dir: string): string[] | null {
	const packageJsonPath = join(dir, "package.json");
	if (existsSync(packageJsonPath)) {
		const manifest = readPiManifestFile(packageJsonPath);
		if (manifest?.extensions?.length) {
			const entries: string[] = [];
			for (const extPath of manifest.extensions) {
				const resolvedExtPath = resolve(dir, extPath);
				if (existsSync(resolvedExtPath)) entries.push(resolvedExtPath);
			}
			if (entries.length > 0) return entries;
		}
	}

	const indexTs = join(dir, "index.ts");
	const indexJs = join(dir, "index.js");
	if (existsSync(indexTs)) return [indexTs];
	if (existsSync(indexJs)) return [indexJs];
	return null;
}

export function collectAutoExtensionEntries(dir: string): string[] {
	const entries: string[] = [];
	if (!existsSync(dir)) return entries;

	const rootEntries = resolveExtensionEntries(dir);
	if (rootEntries) return rootEntries;

	const ig = ignore();
	addIgnoreRules(ig, dir, dir);
	try {
		const dirEntries = readdirSync(dir, { withFileTypes: true });
		for (const entry of dirEntries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const info = getEntryInfo(dir, entry.name, entry.isDirectory(), entry.isFile(), entry.isSymbolicLink());
			if (!info) continue;

			const relPath = toPosixPath(relative(dir, info.fullPath));
			const ignorePath = info.isDir ? `${relPath}/` : relPath;
			if (ig.ignores(ignorePath)) continue;

			if (info.isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
				entries.push(info.fullPath);
			} else if (info.isDir) {
				const resolvedEntries = resolveExtensionEntries(info.fullPath);
				if (resolvedEntries) entries.push(...resolvedEntries);
			}
		}
	} catch {}
	return entries;
}

export function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
	if (resourceType === "skills") {
		return collectSkillEntries(dir, "pi");
	}
	if (resourceType === "extensions") {
		return collectAutoExtensionEntries(dir);
	}
	return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

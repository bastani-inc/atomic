import { access, readdir, readFile, stat } from "node:fs/promises";
import ignore from "ignore";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { canonicalizePath, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import type { LoadSkillsOptions, LoadSkillsResult, Skill, SkillFrontmatter } from "./skills.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
const YIELD_AFTER_MS = 8;
type IgnoreMatcher = ReturnType<typeof ignore>;

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed || (trimmed.startsWith("#") && !trimmed.startsWith("\\#"))) return null;
	let pattern = line;
	let negated = false;
	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}
	if (pattern.startsWith("/")) pattern = pattern.slice(1);
	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

async function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): Promise<void> {
	const relativeDir = relative(rootDir, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";
	for (const filename of IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, filename);
		try {
			const content = await readFile(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) ig.add(patterns);
		} catch {}
	}
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user": return createSyntheticSourceInfo(filePath, { source: "local", scope: "user", baseDir });
		case "project": return createSyntheticSourceInfo(filePath, { source: "local", scope: "project", baseDir });
		case "path": return createSyntheticSourceInfo(filePath, { source: "local", baseDir });
		default: return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

function validateName(name: string): string[] {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name)) errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
	if (name.startsWith("-") || name.endsWith("-")) errors.push("name must not start or end with a hyphen");
	if (name.includes("--")) errors.push("name must not contain consecutive hyphens");
	return errors;
}

function validateDescription(description: string | undefined): string[] {
	if (!description || description.trim() === "") return ["description is required"];
	if (description.length > MAX_DESCRIPTION_LENGTH) {
		return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`];
	}
	return [];
}

async function loadSkillFromFile(filePath: string, source: string): Promise<{ skill: Skill | null; diagnostics: ResourceDiagnostic[] }> {
	const diagnostics: ResourceDiagnostic[] = [];
	try {
		const rawContent = await readFile(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
		const skillDir = dirname(filePath);
		for (const error of validateDescription(frontmatter.description)) diagnostics.push({ type: "warning", message: error, path: filePath });
		const name = frontmatter.name || basename(skillDir);
		for (const error of validateName(name)) diagnostics.push({ type: "warning", message: error, path: filePath });
		if (!frontmatter.description || frontmatter.description.trim() === "") return { skill: null, diagnostics };
		return {
			skill: {
				name,
				description: frontmatter.description,
				filePath,
				baseDir: skillDir,
				sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
				disableModelInvocation: frontmatter["disable-model-invocation"] === true,
			},
			diagnostics,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}
}

async function loadSkillsFromDirInternal(
	dir: string,
	source: string,
	includeRootFiles: boolean,
	ignoreMatcher?: IgnoreMatcher,
	rootDir?: string,
): Promise<LoadSkillsResult> {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	if (!(await exists(dir))) return { skills, diagnostics };
	const startedAt = Date.now();
	const root = rootDir ?? dir;
	const ig = ignoreMatcher ?? ignore();
	await addIgnoreRules(ig, dir, root);
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.name !== "SKILL.md") continue;
			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try { isFile = (await stat(fullPath)).isFile(); } catch { continue; }
			}
			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) continue;
			const result = await loadSkillFromFile(fullPath, source);
			if (result.skill) skills.push(result.skill);
			diagnostics.push(...result.diagnostics);
			return { skills, diagnostics };
		}
		for (const entry of entries) {
			await yieldToEventLoopIfSlow(startedAt, YIELD_AFTER_MS);
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = await stat(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch { continue; }
			}
			const relPath = toPosixPath(relative(root, fullPath));
			if (ig.ignores(isDirectory ? `${relPath}/` : relPath)) continue;
			if (isDirectory) {
				const subResult = await loadSkillsFromDirInternal(fullPath, source, false, ig, root);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}
			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) continue;
			const result = await loadSkillFromFile(fullPath, source);
			if (result.skill) skills.push(result.skill);
			diagnostics.push(...result.diagnostics);
		}
	} catch {}
	return { skills, diagnostics };
}

export async function loadSkillsAsync(options: LoadSkillsOptions): Promise<LoadSkillsResult> {
	const { agentDir, skillPaths, includeDefaults } = options;
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());
	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];
	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");
	const addSkills = (result: LoadSkillsResult) => {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			const realPath = canonicalizePath(skill.filePath);
			if (realPathSet.has(realPath)) continue;
			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: { resourceType: "skill", name: skill.name, winnerPath: existing.filePath, loserPath: skill.filePath },
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	};
	if (includeDefaults) {
		addSkills(await loadSkillsFromDirInternal(userSkillsDir, "user", true));
		addSkills(await loadSkillsFromDirInternal(projectSkillsDir, "project", true));
	}
	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		return target === normalizedRoot || target.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`);
	};
	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
			if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
		}
		return "path";
	};
	const startedAt = Date.now();
	for (const rawPath of skillPaths) {
		await yieldToEventLoopIfSlow(startedAt, YIELD_AFTER_MS);
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!(await exists(resolvedPath))) {
			allDiagnostics.push({ type: "warning", message: "skill path does not exist", path: resolvedPath });
			continue;
		}
		try {
			const stats = await stat(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				addSkills(await loadSkillsFromDirInternal(resolvedPath, source, true));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = await loadSkillFromFile(resolvedPath, source);
				if (result.skill) addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
				else allDiagnostics.push(...result.diagnostics);
			} else {
				allDiagnostics.push({ type: "warning", message: "skill path is not a markdown file", path: resolvedPath });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read skill path";
			allDiagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}
	return { skills: Array.from(skillMap.values()), diagnostics: [...allDiagnostics, ...collisionDiagnostics] };
}

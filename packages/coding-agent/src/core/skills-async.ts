import type { Dirent } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "../config.js";
import { createBatchedCanonicalizePathAsync } from "../utils/batched-canonical-path.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { getPathComparisonKey, isPathWithin, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import { NestedGitignore } from "./gitignore-rules.ts";
import type { LoadSkillsOptions, LoadSkillsResult, Skill, SkillFrontmatter } from "./skills.ts";
import { createSyntheticSourceInfo, isSyntheticPath, type SourceInfo } from "./source-info.ts";

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];
type IgnoreMatcher = NestedGitignore;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

async function withIgnoreRules(
	rules: IgnoreMatcher,
	dir: string,
	rootDir: string,
	entries: readonly Dirent[],
): Promise<IgnoreMatcher> {
	// Match case-insensitively against the directory listing, then open the canonical lowercase filename so
	// case-insensitive filesystems (Windows, default macOS) honor e.g. `.GITIGNORE` while case-sensitive
	// filesystems keep exact-name semantics identical to direct `readFile(join(dir, filename))`.
	const present = IGNORE_FILE_NAMES.filter((filename) =>
		entries.some((entry) => entry.name.toLowerCase() === filename),
	);
	if (present.length === 0) return rules;
	const loaded = await Promise.all(
		present.map((filename) => readFile(join(dir, filename), "utf-8").catch(() => null)),
	);
	const contents = loaded.filter((content): content is string => content !== null);
	if (contents.length === 0) return rules;
	return rules.within(toPosixPath(relative(rootDir, dir)), contents);
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	switch (source) {
		case "user":
			return createSyntheticSourceInfo(filePath, { source: "local", scope: "user", baseDir });
		case "project":
			return createSyntheticSourceInfo(filePath, { source: "local", scope: "project", baseDir });
		case "path":
			return createSyntheticSourceInfo(filePath, { source: "local", baseDir });
		default:
			return createSyntheticSourceInfo(filePath, { source, baseDir });
	}
}

function validateName(name: string): string[] {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name))
		errors.push("name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)");
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

async function loadSkillFromFile(
	filePath: string,
	source: string,
): Promise<{ skill: Skill | null; diagnostics: ResourceDiagnostic[] }> {
	const diagnostics: ResourceDiagnostic[] = [];
	try {
		const rawContent = await readFile(filePath, "utf-8");
		const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
		const skillDir = dirname(filePath);
		for (const error of validateDescription(frontmatter.description))
			diagnostics.push({ type: "warning", message: error, path: filePath });
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
	let entries: Dirent[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return { skills, candidates: skills, diagnostics };
	}
	const root = rootDir ?? dir;
	const ig = await withIgnoreRules(ignoreMatcher ?? NestedGitignore.empty(), dir, root, entries);
	try {
		for (const entry of entries) {
			if (entry.name !== "SKILL.md") continue;
			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = (await stat(fullPath)).isFile();
				} catch {
					continue;
				}
			}
			const relPath = toPosixPath(relative(root, fullPath));
			if (!isFile || ig.ignores(relPath)) continue;
			const result = await loadSkillFromFile(fullPath, source);
			if (result.skill) skills.push(result.skill);
			diagnostics.push(...result.diagnostics);
			return { skills, candidates: skills, diagnostics };
		}
		const childTasks: Array<Promise<LoadSkillsResult | undefined>> = [];
		for (const entry of entries) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const fullPath = join(dir, entry.name);
			childTasks.push(
				(async (): Promise<LoadSkillsResult | undefined> => {
					let isDirectory = entry.isDirectory();
					let isFile = entry.isFile();
					if (entry.isSymbolicLink()) {
						try {
							const stats = await stat(fullPath);
							isDirectory = stats.isDirectory();
							isFile = stats.isFile();
						} catch {
							return undefined;
						}
					}
					const relPath = toPosixPath(relative(root, fullPath));
					if (ig.ignores(isDirectory ? `${relPath}/` : relPath)) return undefined;
					if (isDirectory) {
						return loadSkillsFromDirInternal(fullPath, source, false, ig, root);
					}
					if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) return undefined;
					const result = await loadSkillFromFile(fullPath, source);
					return {
						skills: result.skill ? [result.skill] : [],
						candidates: result.skill ? [result.skill] : [],
						diagnostics: result.diagnostics,
					};
				})(),
			);
		}
		const childResults = await Promise.all(childTasks);
		for (const subResult of childResults) {
			if (!subResult) continue;
			skills.push(...subResult.skills);
			diagnostics.push(...subResult.diagnostics);
		}
	} catch {}
	return { skills, candidates: skills, diagnostics };
}

export async function loadSkillsAsync(options: LoadSkillsOptions): Promise<LoadSkillsResult> {
	const { agentDir, skillPaths, includeDefaults } = options;
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(agentDir ?? getAgentDir());
	const skillMap = new Map<string, Skill>();
	const candidates: Skill[] = [];
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];
	const userSkillsDir = join(resolvedAgentDir, "skills");
	const projectSkillsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "skills");
	const canonicalize = createBatchedCanonicalizePathAsync();
	const resolveSkillPathKey = async (filePath: string): Promise<string> => {
		if (isSyntheticPath(filePath)) return filePath;
		return getPathComparisonKey(await canonicalize(filePath));
	};
	const addSkills = async (result: LoadSkillsResult) => {
		allDiagnostics.push(...result.diagnostics);
		if (result.skills.length === 0) return;
		const realPaths = await Promise.all(result.skills.map((skill) => resolveSkillPathKey(skill.filePath)));
		for (const [index, skill] of result.skills.entries()) {
			const realPath = realPaths[index]!;
			if (realPathSet.has(realPath)) continue;
			realPathSet.add(realPath);
			candidates.push(skill);
			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
					collision: {
						resourceType: "skill",
						name: skill.name,
						winnerPath: existing.filePath,
						loserPath: skill.filePath,
					},
				});
			} else {
				skillMap.set(skill.name, skill);
			}
		}
	};
	const getSource = (resolvedPath: string): "user" | "project" | "path" => {
		if (!includeDefaults) {
			if (isPathWithin(userSkillsDir, resolvedPath)) return "user";
			if (isPathWithin(projectSkillsDir, resolvedPath)) return "project";
		}
		return "path";
	};
	const loadExplicitPath = async (rawPath: string): Promise<LoadSkillsResult> => {
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		try {
			const stats = await stat(resolvedPath);
			const source = getSource(resolvedPath);
			if (stats.isDirectory()) {
				return loadSkillsFromDirInternal(resolvedPath, source, true);
			}
			if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = await loadSkillFromFile(resolvedPath, source);
				return {
					skills: result.skill ? [result.skill] : [],
					candidates: result.skill ? [result.skill] : [],
					diagnostics: result.diagnostics,
				};
			}
			return {
				skills: [],
				candidates: [],
				diagnostics: [{ type: "warning", message: "skill path is not a markdown file", path: resolvedPath }],
			};
		} catch (error) {
			if (!(await exists(resolvedPath))) {
				return {
					skills: [],
					candidates: [],
					diagnostics: [{ type: "warning", message: "skill path does not exist", path: resolvedPath }],
				};
			}
			const message = error instanceof Error ? error.message : "failed to read skill path";
			return {
				skills: [],
				candidates: [],
				diagnostics: [{ type: "warning", message, path: resolvedPath }],
			};
		}
	};

	const tasks: Array<Promise<LoadSkillsResult>> = [];
	if (includeDefaults) {
		tasks.push(loadSkillsFromDirInternal(userSkillsDir, "user", true));
		tasks.push(loadSkillsFromDirInternal(projectSkillsDir, "project", true));
	}
	for (const rawPath of skillPaths) {
		tasks.push(loadExplicitPath(rawPath));
	}
	const results = await Promise.all(tasks);
	for (const result of results) {
		await addSkills(result);
	}
	return {
		skills: Array.from(skillMap.values()),
		candidates,
		diagnostics: [...allDiagnostics, ...collisionDiagnostics],
	};
}

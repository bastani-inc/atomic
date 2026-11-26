/**
 * Skill resolution and caching for subagent extension
 */

import type { Dirent, Stats } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import { type SkillCatalog, skillUri } from "@bastani/atomic";
import { pathExists } from "../shared/path-exists.js";
import {
	buildSkillPaths,
	clearSkillPathDiscoveryCache,
	inferSkillSource,
	type SkillSearchPath,
} from "./skills-paths.js";

export { __setGlobalNpmRootExecForTest } from "./skills-paths.js";

export type SkillSource =
	| "project"
	| "user"
	| "project-package"
	| "user-package"
	| "project-settings"
	| "user-settings"
	| "extension"
	| "builtin"
	| "unknown";

export interface ResolvedSkill {
	name: string;
	path: string;
	content: string;
	source: SkillSource;
}

interface SkillCacheEntry {
	mtime: number;
	skill: ResolvedSkill;
}

interface CachedSkillEntry {
	name: string;
	filePath: string;
	source: SkillSource;
	description?: string;
	order: number;
}

const skillCache = new Map<string, SkillCacheEntry>();
const MAX_CACHE_SIZE = 50;

let loadSkillsCache: { cwd: string; skills: Promise<CachedSkillEntry[]>; timestamp: number } | null = null;
const LOAD_SKILLS_CACHE_TTL_MS = 5000;

const SUBAGENT_ORCHESTRATION_SKILL = "subagent";

/** Bare skill name from `/skill:name` or `/skill:name@qualifier`. */
export function skillSelectorBaseName(selector: string): string {
	const separator = selector.indexOf("@");
	return separator === -1 ? selector : selector.slice(0, separator);
}

export function isSubagentOrchestrationSkillSelector(selector: string): boolean {
	return skillSelectorBaseName(selector) === SUBAGENT_ORCHESTRATION_SKILL;
}

const SOURCE_PRIORITY: Record<SkillSource, number> = {
	project: 700,
	"project-settings": 650,
	"project-package": 600,
	user: 300,
	"user-settings": 250,
	"user-package": 200,
	extension: 150,
	builtin: 100,
	unknown: 0,
};

function stripSkillFrontmatter(content: string): string {
	const normalized = content.replace(/\r\n/g, "\n");
	if (!normalized.startsWith("---")) return normalized;

	const endIndex = normalized.indexOf("\n---", 3);
	if (endIndex === -1) return normalized;

	return normalized.slice(endIndex + 4).trim();
}

function chooseHigherPrioritySkill(
	existing: CachedSkillEntry | undefined,
	candidate: CachedSkillEntry,
): CachedSkillEntry {
	if (!existing) return candidate;
	const existingPriority = SOURCE_PRIORITY[existing.source] ?? 0;
	const candidatePriority = SOURCE_PRIORITY[candidate.source] ?? 0;
	if (candidatePriority > existingPriority) return candidate;
	if (candidatePriority < existingPriority) return existing;
	return candidate.order < existing.order ? candidate : existing;
}

async function maybeReadSkillDescription(filePath: string): Promise<string | undefined> {
	try {
		const content = await readFile(filePath, "utf-8");
		const normalized = content.replace(/\r\n/g, "\n");
		if (!normalized.startsWith("---")) return undefined;

		const endIndex = normalized.indexOf("\n---", 3);
		if (endIndex === -1) return undefined;

		const frontmatter = normalized.slice(3, endIndex).trim();
		const match = frontmatter.match(/^description:\s*(.+)$/m);
		if (!match) return undefined;
		return match[1]?.trim().replace(/^['"]|['"]$/g, "");
	} catch {
		// Description parsing is best-effort metadata extraction.
		return undefined;
	}
}

async function collectFilesystemSkills(cwd: string, skillPaths: SkillSearchPath[]): Promise<CachedSkillEntry[]> {
	const entries: CachedSkillEntry[] = [];
	const seen = new Set<string>();
	let order = 0;

	const pushEntry = async (name: string, filePath: string, sourceHint?: SkillSource): Promise<void> => {
		const resolvedFile = path.resolve(filePath);
		if (seen.has(resolvedFile)) return;
		if (!(await pathExists(resolvedFile))) return;
		seen.add(resolvedFile);
		entries.push({
			name,
			filePath: resolvedFile,
			source: await inferSkillSource(resolvedFile, cwd, sourceHint),
			description: await maybeReadSkillDescription(resolvedFile),
			order: order++,
		});
	};

	for (const skillPath of skillPaths) {
		if (!(await pathExists(skillPath.path))) continue;

		let skillPathStat: Stats;
		try {
			skillPathStat = await stat(skillPath.path);
		} catch {
			continue;
		}

		if (skillPathStat.isFile()) {
			const fileName = path.basename(skillPath.path);
			if (!fileName.toLowerCase().endsWith(".md")) continue;
			const skillName =
				fileName.toLowerCase() === "skill.md"
					? path.basename(path.dirname(skillPath.path))
					: path.basename(fileName, path.extname(fileName));
			await pushEntry(skillName, skillPath.path, skillPath.source);
			continue;
		}

		if (!skillPathStat.isDirectory()) continue;

		const rootSkillFile = path.join(skillPath.path, "SKILL.md");
		if (await pathExists(rootSkillFile)) {
			await pushEntry(path.basename(skillPath.path), rootSkillFile, skillPath.source);
		}

		let childEntries: Dirent[];
		try {
			childEntries = await readdir(skillPath.path, { withFileTypes: true });
		} catch {
			continue;
		}

		for (const child of childEntries) {
			if (child.name.startsWith(".")) continue;
			const childPath = path.join(skillPath.path, child.name);
			if (child.isDirectory() || child.isSymbolicLink()) {
				const nestedSkillPath = path.join(childPath, "SKILL.md");
				if (await pathExists(nestedSkillPath)) {
					await pushEntry(child.name, nestedSkillPath, skillPath.source);
				}
				continue;
			}
			if (child.isFile() && child.name.toLowerCase().endsWith(".md")) {
				await pushEntry(path.basename(child.name, path.extname(child.name)), childPath, skillPath.source);
			}
		}
	}

	return entries;
}

async function loadSkills(cwd: string): Promise<CachedSkillEntry[]> {
	const skillPaths = await buildSkillPaths(cwd);
	const loaded = await collectFilesystemSkills(cwd, skillPaths);
	const dedupedByName = new Map<string, CachedSkillEntry>();

	for (const entry of loaded) {
		const current = dedupedByName.get(entry.name);
		dedupedByName.set(entry.name, chooseHigherPrioritySkill(current, entry));
	}

	return [...dedupedByName.values()].sort((a, b) => a.order - b.order);
}

function getCachedSkills(cwd: string): Promise<CachedSkillEntry[]> {
	const now = Date.now();
	if (loadSkillsCache && loadSkillsCache.cwd === cwd && now - loadSkillsCache.timestamp < LOAD_SKILLS_CACHE_TTL_MS) {
		return loadSkillsCache.skills;
	}

	const entry = { cwd, skills: loadSkills(cwd), timestamp: now };
	loadSkillsCache = entry;
	entry.skills.catch(() => {
		if (loadSkillsCache === entry) loadSkillsCache = null;
	});
	return entry.skills;
}

export async function resolveSkillPath(
	skillName: string,
	cwd: string,
): Promise<{ path: string; source: SkillSource } | undefined> {
	const skills = await getCachedSkills(cwd);
	const skill = skills.find((s) => s.name === skillName);
	if (!skill) return undefined;
	return { path: skill.filePath, source: skill.source };
}

async function readSkill(
	skillName: string,
	skillPath: string,
	source: SkillSource,
): Promise<ResolvedSkill | undefined> {
	const cacheKey = `${skillPath}\0${skillName}`;
	try {
		const { mtimeMs } = await stat(skillPath);
		const cached = skillCache.get(cacheKey);
		if (cached && cached.mtime === mtimeMs) {
			return cached.skill;
		}

		const raw = await readFile(skillPath, "utf-8");
		const content = stripSkillFrontmatter(raw);
		const skill: ResolvedSkill = {
			name: skillName,
			path: skillPath,
			content,
			source,
		};

		skillCache.set(cacheKey, { mtime: mtimeMs, skill });
		if (skillCache.size > MAX_CACHE_SIZE) {
			const firstKey = skillCache.keys().next().value;
			if (firstKey) skillCache.delete(firstKey);
		}

		return skill;
	} catch {
		// Treat unreadable skill files as unresolved so callers can surface as missing.
		return undefined;
	}
}

async function catalogSkillSource(
	skillPath: string,
	cwd: string,
	catalogSource: {
		readonly scope: "user" | "project" | "temporary";
		readonly origin: "package" | "top-level";
		readonly configurationOrigin?: string;
	},
): Promise<SkillSource> {
	if (catalogSource.configurationOrigin === "bundled") return "builtin";
	if (catalogSource.scope === "project") return catalogSource.origin === "package" ? "project-package" : "project";
	if (catalogSource.scope === "user") return catalogSource.origin === "package" ? "user-package" : "user";
	return inferSkillSource(skillPath, cwd);
}

export async function resolveSkillsFromCatalog(
	skillNames: string[],
	catalog: SkillCatalog,
	cwd: string,
): Promise<{ resolved: ResolvedSkill[]; missing: string[] }> {
	const resolved: ResolvedSkill[] = [];
	const missing: string[] = [];
	for (const name of skillNames) {
		const selector = name.trim();
		if (!selector) continue;
		if (isSubagentOrchestrationSkillSelector(selector)) {
			missing.push(selector);
			continue;
		}
		const resolution = catalog.resolve(selector);
		if (!resolution.ok) {
			missing.push(selector);
			continue;
		}
		const candidate = resolution.candidate;
		const skill = await readSkill(
			selector,
			candidate.skill.filePath,
			await catalogSkillSource(candidate.skill.filePath, cwd, candidate.skill.sourceInfo),
		);
		if (skill) resolved.push(skill);
		else missing.push(selector);
	}
	return { resolved, missing };
}

export async function resolveSkills(
	skillNames: string[],
	cwd: string,
): Promise<{ resolved: ResolvedSkill[]; missing: string[] }> {
	const resolved: ResolvedSkill[] = [];
	const missing: string[] = [];

	for (const name of skillNames) {
		const trimmed = name.trim();
		if (!trimmed) continue;
		if (isSubagentOrchestrationSkillSelector(trimmed)) {
			missing.push(trimmed);
			continue;
		}

		const location = await resolveSkillPath(trimmed, cwd);
		if (!location) {
			missing.push(trimmed);
			continue;
		}

		const skill = await readSkill(trimmed, location.path, location.source);
		if (skill) {
			resolved.push(skill);
		} else {
			missing.push(trimmed);
		}
	}

	return { resolved, missing };
}

export async function resolveSkillsWithFallback(
	skillNames: string[],
	primaryCwd: string,
	fallbackCwd?: string,
): Promise<{ resolved: ResolvedSkill[]; missing: string[] }> {
	const primary = await resolveSkills(skillNames, primaryCwd);
	if (!fallbackCwd || primary.missing.length === 0) return primary;
	if (path.resolve(primaryCwd) === path.resolve(fallbackCwd)) return primary;

	const fallback = await resolveSkills(primary.missing, fallbackCwd);
	return {
		resolved: [...primary.resolved, ...fallback.resolved],
		missing: fallback.missing,
	};
}

export function buildSkillInjection(skills: ResolvedSkill[]): string {
	if (skills.length === 0) return "";

	return skills
		.map((s) => {
			const location = skillUri(s.name);
			return `<skill name="${s.name}" location="${location}">\nReferences are relative to ${location}/.\n\n${s.content}\n</skill>`;
		})
		.join("\n\n");
}

export function normalizeSkillInput(input: string | string[] | boolean | undefined): string[] | false | undefined {
	if (input === false) return false;
	if (input === true || input === undefined) return undefined;
	if (Array.isArray(input)) {
		return [...new Set(input.map((s) => s.trim()).filter((s) => s.length > 0))];
	}
	// Guard against JSON-encoded arrays arriving as strings (e.g. '["a","b"]').
	// Models sometimes serialise the skill parameter as a JSON string instead of
	// a native array, and naively splitting on "," would embed brackets/quotes
	// into the skill names, causing resolution to silently fail.
	const trimmed = input.trim();
	if (trimmed.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmed);
			if (Array.isArray(parsed)) {
				return normalizeSkillInput(parsed);
			}
		} catch {
			// Not valid JSON – fall through to comma-split
		}
	}
	return [
		...new Set(
			input
				.split(",")
				.map((s) => s.trim())
				.filter((s) => s.length > 0),
		),
	];
}

export async function discoverAvailableSkills(cwd: string): Promise<
	Array<{
		name: string;
		source: SkillSource;
		description?: string;
	}>
> {
	const skills = await getCachedSkills(cwd);
	return skills
		.filter((s) => s.name !== SUBAGENT_ORCHESTRATION_SKILL)
		.map((s) => ({
			name: s.name,
			source: s.source,
			description: s.description,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

export function clearSkillCache(): void {
	skillCache.clear();
	loadSkillsCache = null;
	clearSkillPathDiscoveryCache();
}

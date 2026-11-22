import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { getProjectConfigDirs } from "../config.js";
import { type ColorMode, resolveColorMode } from "../modes/interactive/theme/color-utils.ts";
import { loadThemeFromContent, type Theme } from "../modes/interactive/theme/theme.js";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { pathExists as existsAsync } from "../utils/path-exists.ts";
import type { ResourceDiagnostic, ResourceOverlap } from "./diagnostics.ts";
import type { PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplatesAsync } from "./prompt-templates-async.ts";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import { getLoaderAgentDirs, resolveResourcePath } from "./resource-loader-paths.ts";
import { findSourceInfoForPath, getDefaultSourceInfoForPath } from "./resource-loader-source-info.ts";
import {
	buildSkillCatalogWith,
	decorateSkillDiagnostics,
	resolveSkillCatalogPaths,
	type SkillCatalog,
} from "./skill-catalog.ts";
import type { LoadSkillsResult, Skill } from "./skills.ts";
import { loadSkillsAsync } from "./skills-async.ts";
import type { SourceInfo } from "./source-info.ts";

const RESOURCE_LOAD_YIELD_AFTER_MS = 8;

export interface LoadedSkillsStage {
	readonly skillPaths: string[];
	readonly skillsResult: LoadSkillsResult;
	readonly sourcedSkills: Skill[];
}

export interface PreparedSkillsCommit {
	readonly lastSkillPaths: string[];
	readonly skills: Skill[];
	readonly skillCatalog: SkillCatalog;
	readonly skillDiagnostics: ResourceDiagnostic[];
}

export async function loadSkillsStageAsync(
	loader: DefaultResourceLoader,
	skillPaths: string[],
	metadataByPath?: Map<string, PathMetadata>,
): Promise<LoadedSkillsStage> {
	const state = resourceInternals(loader);
	const skillsResult =
		state.noSkills && skillPaths.length === 0
			? { skills: [], candidates: [], diagnostics: [] }
			: await loadSkillsAsync({ cwd: state.cwd, agentDir: state.agentDir, skillPaths, includeDefaults: false });
	const sourcedSkills = await Promise.all(
		skillsResult.skills.map(async (skill) => ({
			...skill,
			sourceInfo:
				(await findSourceInfoForPath(loader, skill.filePath, state.extensionSkillSourceInfos, metadataByPath)) ??
				skill.sourceInfo ??
				(await getDefaultSourceInfoForPath(loader, skill.filePath)),
		})),
	);
	return { skillPaths, skillsResult, sourcedSkills };
}

export async function prepareSkillsCommitAsync(
	loader: DefaultResourceLoader,
	stage: LoadedSkillsStage,
	metadataByPath?: Map<string, PathMetadata>,
	missingSkillPaths: readonly string[] = [],
): Promise<PreparedSkillsCommit> {
	const state = resourceInternals(loader);
	const withSourceInfo = async (skill: Skill): Promise<Skill> => ({
		...skill,
		sourceInfo:
			(await findSourceInfoForPath(loader, skill.filePath, state.extensionSkillSourceInfos, metadataByPath)) ??
			skill.sourceInfo ??
			(await getDefaultSourceInfoForPath(loader, skill.filePath)),
	});
	const sourcedResult = {
		skills: stage.sourcedSkills,
		diagnostics: stage.skillsResult.diagnostics,
	};
	const resolvedSkills = state.skillsOverride ? state.skillsOverride(sourcedResult) : sourcedResult;
	const skills = await Promise.all(resolvedSkills.skills.map(withSourceInfo));
	const retainedNames = new Set(skills.map((skill) => skill.name));
	const candidates = (await Promise.all(stage.skillsResult.candidates.map(withSourceInfo))).filter((skill) =>
		retainedNames.has(skill.name),
	);
	const realPathOf = await resolveSkillCatalogPaths([...candidates, ...skills], resolvedSkills.diagnostics);
	const skillCatalog = buildSkillCatalogWith(candidates, skills, realPathOf);
	const skillDiagnostics = decorateSkillDiagnostics(resolvedSkills.diagnostics, skillCatalog, realPathOf);
	for (const resolved of missingSkillPaths) {
		if (!skillDiagnostics.some((d) => d.path === resolved)) {
			skillDiagnostics.push({ type: "error", message: "Skill path does not exist", path: resolved });
		}
	}
	return { lastSkillPaths: stage.skillPaths, skills, skillCatalog, skillDiagnostics };
}

export async function updateSkillsFromPathsAsync(
	loader: DefaultResourceLoader,
	skillPaths: string[],
	metadataByPath?: Map<string, PathMetadata>,
): Promise<void> {
	const state = resourceInternals(loader);
	const stage = await loadSkillsStageAsync(loader, skillPaths, metadataByPath);
	const commit = await prepareSkillsCommitAsync(loader, stage, metadataByPath);
	state.skills = commit.skills;
	state.skillCatalog = commit.skillCatalog;
	state.skillDiagnostics = commit.skillDiagnostics;
}

export interface LoadedPromptsStage {
	readonly promptPaths: string[];
	readonly loadedDiagnostics: ResourceDiagnostic[];
	readonly sourcedPrompts: PromptTemplate[];
	readonly deduped: {
		prompts: PromptTemplate[];
		diagnostics: ResourceDiagnostic[];
		overlaps: ResourceOverlap[];
	};
}

export interface PreparedPromptsCommit {
	readonly lastPromptPaths: string[];
	readonly promptSourceInfos: Array<readonly [string, SourceInfo]>;
	readonly promptOverlaps: ResourceOverlap[];
	readonly prompts: PromptTemplate[];
	readonly promptDiagnostics: ResourceDiagnostic[];
}

export async function loadPromptsStageAsync(
	loader: DefaultResourceLoader,
	promptPaths: string[],
	metadataByPath?: Map<string, PathMetadata>,
): Promise<LoadedPromptsStage> {
	const state = resourceInternals(loader);
	const loaded =
		state.noPromptTemplates && promptPaths.length === 0
			? { templates: [], diagnostics: [] }
			: await loadPromptTemplatesAsync({
					cwd: state.cwd,
					agentDir: state.agentDir,
					promptPaths,
					includeDefaults: false,
				});
	const sourcedPrompts = await Promise.all(
		loaded.templates.map(async (prompt) => ({
			...prompt,
			sourceInfo:
				(await findSourceInfoForPath(loader, prompt.filePath, state.extensionPromptSourceInfos, metadataByPath)) ??
				prompt.sourceInfo ??
				(await getDefaultSourceInfoForPath(loader, prompt.filePath)),
		})),
	);
	const deduped = dedupePrompts(sourcedPrompts);
	return { promptPaths, loadedDiagnostics: loaded.diagnostics, sourcedPrompts, deduped };
}

export async function preparePromptsCommitAsync(
	loader: DefaultResourceLoader,
	stage: LoadedPromptsStage,
	metadataByPath?: Map<string, PathMetadata>,
	missingPromptPaths: readonly string[] = [],
): Promise<PreparedPromptsCommit> {
	const state = resourceInternals(loader);
	const localPromptSourceInfos = new Map(state.extensionPromptSourceInfos);
	const promptSourceInfos: Array<readonly [string, SourceInfo]> = [];
	for (const prompt of stage.sourcedPrompts) {
		if (prompt.sourceInfo) {
			localPromptSourceInfos.set(prompt.filePath, prompt.sourceInfo);
			promptSourceInfos.push([prompt.filePath, prompt.sourceInfo]);
		}
	}
	const promptsResult = {
		prompts: stage.deduped.prompts,
		diagnostics: [...stage.loadedDiagnostics, ...stage.deduped.diagnostics],
	};
	const resolvedPrompts = state.promptsOverride ? state.promptsOverride(promptsResult) : promptsResult;
	const prompts = await Promise.all(
		resolvedPrompts.prompts.map(async (prompt) => ({
			...prompt,
			sourceInfo:
				(await findSourceInfoForPath(loader, prompt.filePath, localPromptSourceInfos, metadataByPath)) ??
				prompt.sourceInfo ??
				(await getDefaultSourceInfoForPath(loader, prompt.filePath)),
		})),
	);
	const promptDiagnostics = [...resolvedPrompts.diagnostics];
	for (const resolved of missingPromptPaths) {
		if (!promptDiagnostics.some((d) => d.path === resolved)) {
			promptDiagnostics.push({
				type: "error",
				message: "Prompt template path does not exist",
				path: resolved,
			});
		}
	}
	return {
		lastPromptPaths: stage.promptPaths,
		promptSourceInfos,
		promptOverlaps: stage.deduped.overlaps,
		prompts,
		promptDiagnostics,
	};
}

export async function updatePromptsFromPathsAsync(
	loader: DefaultResourceLoader,
	promptPaths: string[],
	metadataByPath?: Map<string, PathMetadata>,
): Promise<void> {
	const state = resourceInternals(loader);
	const stage = await loadPromptsStageAsync(loader, promptPaths, metadataByPath);
	const commit = await preparePromptsCommitAsync(loader, stage, metadataByPath);
	for (const [filePath, info] of commit.promptSourceInfos) {
		state.extensionPromptSourceInfos.set(filePath, info);
	}
	state.extensionsResult.overlaps ??= [];
	const overlaps = state.extensionsResult.overlaps;
	const extensionOverlaps = overlaps.filter((overlap) => overlap.resourceType !== "prompt");
	overlaps.splice(0, overlaps.length, ...extensionOverlaps, ...commit.promptOverlaps);
	state.prompts = commit.prompts;
	state.promptDiagnostics = commit.promptDiagnostics;
}

export interface LoadedThemesStage {
	readonly themePaths: string[];
	readonly themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
}

export interface PreparedThemesCommit {
	readonly lastThemePaths: string[];
	readonly themes: Theme[];
	readonly themeDiagnostics: ResourceDiagnostic[];
}

export async function loadThemesStageAsync(
	loader: DefaultResourceLoader,
	themePaths: string[],
): Promise<LoadedThemesStage> {
	const state = resourceInternals(loader);
	const themesResult =
		state.noThemes && themePaths.length === 0
			? { themes: [], diagnostics: [] }
			: loadAndDedupeThemes(await loadThemesAsync(loader, themePaths, false));
	return { themePaths, themesResult };
}

export async function prepareThemesCommitAsync(
	loader: DefaultResourceLoader,
	stage: LoadedThemesStage,
	metadataByPath?: Map<string, PathMetadata>,
	missingThemePaths: readonly string[] = [],
): Promise<PreparedThemesCommit> {
	const state = resourceInternals(loader);
	const resolvedThemes = state.themesOverride ? state.themesOverride(stage.themesResult) : stage.themesResult;
	for (const theme of resolvedThemes.themes) {
		const sourcePath = theme.sourcePath;
		theme.sourceInfo = sourcePath
			? ((await findSourceInfoForPath(loader, sourcePath, state.extensionThemeSourceInfos, metadataByPath)) ??
				theme.sourceInfo ??
				(await getDefaultSourceInfoForPath(loader, sourcePath)))
			: theme.sourceInfo;
	}
	const themeDiagnostics = [...resolvedThemes.diagnostics];
	for (const resolved of missingThemePaths) {
		if (!themeDiagnostics.some((d) => d.path === resolved)) {
			themeDiagnostics.push({ type: "error", message: "Theme path does not exist", path: resolved });
		}
	}
	return {
		lastThemePaths: stage.themePaths,
		themes: [...resolvedThemes.themes],
		themeDiagnostics,
	};
}

export async function updateThemesFromPathsAsync(
	loader: DefaultResourceLoader,
	themePaths: string[],
	metadataByPath?: Map<string, PathMetadata>,
): Promise<void> {
	const state = resourceInternals(loader);
	const stage = await loadThemesStageAsync(loader, themePaths);
	const commit = await prepareThemesCommitAsync(loader, stage, metadataByPath);
	state.themes = commit.themes;
	state.themeDiagnostics = commit.themeDiagnostics;
}

function loadAndDedupeThemes(loaded: { themes: Theme[]; diagnostics: ResourceDiagnostic[] }): {
	themes: Theme[];
	diagnostics: ResourceDiagnostic[];
} {
	const deduped = dedupeThemes(loaded.themes);
	return { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
}

async function loadThemesAsync(
	loader: DefaultResourceLoader,
	paths: string[],
	includeDefaults = true,
): Promise<{ themes: Theme[]; diagnostics: ResourceDiagnostic[] }> {
	const state = resourceInternals(loader);
	const colorMode = resolveColorMode(state.settingsManager.getTerminalCapabilityOverrides().trueColor);
	const themes: Theme[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	if (includeDefaults) {
		for (const dir of [
			...getLoaderAgentDirs(state.agentDir).map((agentDir) => join(agentDir, "themes")),
			...getProjectThemeDirs(state.cwd),
		]) {
			await loadThemesFromDirAsync(dir, themes, diagnostics, colorMode);
		}
	}
	const startedAt = Date.now();
	for (const p of paths) {
		await yieldToEventLoopIfSlow(startedAt, RESOURCE_LOAD_YIELD_AFTER_MS);
		const resolved = resolveResourcePath(state.cwd, p);
		if (!(await existsAsync(resolved))) {
			diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
			continue;
		}
		try {
			const stats = await stat(resolved);
			if (stats.isDirectory()) await loadThemesFromDirAsync(resolved, themes, diagnostics, colorMode);
			else if (stats.isFile() && resolved.endsWith(".json"))
				await loadThemeFromFileAsync(resolved, themes, diagnostics, colorMode);
			else diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read theme path";
			diagnostics.push({ type: "warning", message, path: resolved });
		}
	}
	return { themes, diagnostics };
}

function getProjectThemeDirs(cwd: string): string[] {
	return getProjectConfigDirs(cwd).map((configDir) => join(configDir, "themes"));
}

async function loadThemesFromDirAsync(
	dir: string,
	themes: Theme[],
	diagnostics: ResourceDiagnostic[],
	colorMode: ColorMode,
): Promise<void> {
	if (!(await existsAsync(dir))) return;
	const startedAt = Date.now();
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			await yieldToEventLoopIfSlow(startedAt, RESOURCE_LOAD_YIELD_AFTER_MS);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = (await stat(join(dir, entry.name))).isFile();
				} catch {
					continue;
				}
			}
			if (isFile && entry.name.endsWith(".json"))
				await loadThemeFromFileAsync(join(dir, entry.name), themes, diagnostics, colorMode);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read theme directory";
		diagnostics.push({ type: "warning", message, path: dir });
	}
}

async function loadThemeFromFileAsync(
	filePath: string,
	themes: Theme[],
	diagnostics: ResourceDiagnostic[],
	colorMode: ColorMode,
): Promise<void> {
	try {
		themes.push(loadThemeFromContent(filePath, await readFile(filePath, "utf-8"), colorMode));
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to load theme";
		diagnostics.push({ type: "warning", message, path: filePath });
	}
}

function dedupePrompts(prompts: PromptTemplate[]): {
	prompts: PromptTemplate[];
	diagnostics: ResourceDiagnostic[];
	overlaps: ResourceOverlap[];
} {
	const bundledByName = new Map<string, PromptTemplate>();
	for (const prompt of prompts) {
		if (prompt.sourceInfo?.configurationOrigin === "bundled" && !bundledByName.has(prompt.name)) {
			bundledByName.set(prompt.name, prompt);
		}
	}
	const seen = new Map<string, PromptTemplate>();
	const diagnostics: ResourceDiagnostic[] = [];
	const overlaps: ResourceOverlap[] = [];
	for (const prompt of prompts) {
		const bundled = bundledByName.get(prompt.name);
		if (prompt.sourceInfo?.configurationOrigin === "inherited-pi" && bundled?.sourceInfo) {
			overlaps.push({
				resourceType: "prompt",
				name: prompt.name,
				bundled: bundled.sourceInfo,
				inherited: prompt.sourceInfo,
			});
			continue;
		}
		const existing = seen.get(prompt.name);
		if (existing) {
			diagnostics.push({
				type: "collision",
				message: `name "/${prompt.name}" collision`,
				path: prompt.filePath,
				collision: {
					resourceType: "prompt",
					name: prompt.name,
					winnerPath: existing.filePath,
					loserPath: prompt.filePath,
				},
			});
		} else {
			seen.set(prompt.name, prompt);
		}
	}
	return { prompts: Array.from(seen.values()), diagnostics, overlaps };
}

function dedupeThemes(themes: Theme[]): { themes: Theme[]; diagnostics: ResourceDiagnostic[] } {
	const seen = new Map<string, Theme>();
	const diagnostics: ResourceDiagnostic[] = [];
	for (const t of themes) {
		const name = t.name ?? "unnamed";
		const existing = seen.get(name);
		if (existing) {
			diagnostics.push({
				type: "collision",
				message: `name "${name}" collision`,
				path: t.sourcePath,
				collision: {
					resourceType: "theme",
					name,
					winnerPath: existing.sourcePath ?? "<builtin>",
					loserPath: t.sourcePath ?? "<builtin>",
				},
			});
		} else {
			seen.set(name, t);
		}
	}
	return { themes: Array.from(seen.values()), diagnostics };
}

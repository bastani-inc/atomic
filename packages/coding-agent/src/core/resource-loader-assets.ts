import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { getProjectConfigDirs } from "../config.ts";
import { loadThemeFromPath, type Theme } from "../modes/interactive/theme/theme.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import type { PathMetadata } from "./package-manager.ts";
import type { PromptTemplate } from "./prompt-templates.ts";
import { loadPromptTemplates } from "./prompt-templates.ts";
import type { Skill } from "./skills.ts";
import { loadSkills } from "./skills.ts";
import { resourceInternals } from "./resource-loader-internals.ts";
import { getLoaderAgentDirs, resolveResourcePath } from "./resource-loader-paths.ts";
import type { DefaultResourceLoader } from "./resource-loader-core.ts";
import { findSourceInfoForPath, getDefaultSourceInfoForPath } from "./resource-loader-source-info.ts";

export function updateSkillsFromPaths(
	loader: DefaultResourceLoader,
	skillPaths: string[],
	metadataByPath?: Map<string, PathMetadata>,
): void {
	const state = resourceInternals(loader);
	let skillsResult: { skills: Skill[]; diagnostics: ResourceDiagnostic[] };
	if (state.noSkills && skillPaths.length === 0) {
		skillsResult = { skills: [], diagnostics: [] };
	} else {
		skillsResult = loadSkills({
			cwd: state.cwd,
			agentDir: state.agentDir,
			skillPaths,
			includeDefaults: false,
		});
	}
	const resolvedSkills = state.skillsOverride ? state.skillsOverride(skillsResult) : skillsResult;
	state.skills = resolvedSkills.skills.map((skill) => ({
		...skill,
		sourceInfo:
			findSourceInfoForPath(loader, skill.filePath, state.extensionSkillSourceInfos, metadataByPath) ??
			skill.sourceInfo ??
			getDefaultSourceInfoForPath(loader, skill.filePath),
	}));
	state.skillDiagnostics = resolvedSkills.diagnostics;
}

export function updatePromptsFromPaths(
	loader: DefaultResourceLoader,
	promptPaths: string[],
	metadataByPath?: Map<string, PathMetadata>,
): void {
	const state = resourceInternals(loader);
	let promptsResult: { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] };
	if (state.noPromptTemplates && promptPaths.length === 0) {
		promptsResult = { prompts: [], diagnostics: [] };
	} else {
		const allPrompts = loadPromptTemplates({
			cwd: state.cwd,
			agentDir: state.agentDir,
			promptPaths,
			includeDefaults: false,
		});
		promptsResult = dedupePrompts(allPrompts);
	}
	const resolvedPrompts = state.promptsOverride ? state.promptsOverride(promptsResult) : promptsResult;
	state.prompts = resolvedPrompts.prompts.map((prompt) => ({
		...prompt,
		sourceInfo:
			findSourceInfoForPath(loader, prompt.filePath, state.extensionPromptSourceInfos, metadataByPath) ??
			prompt.sourceInfo ??
			getDefaultSourceInfoForPath(loader, prompt.filePath),
	}));
	state.promptDiagnostics = resolvedPrompts.diagnostics;
}

export function updateThemesFromPaths(
	loader: DefaultResourceLoader,
	themePaths: string[],
	metadataByPath?: Map<string, PathMetadata>,
): void {
	const state = resourceInternals(loader);
	let themesResult: { themes: Theme[]; diagnostics: ResourceDiagnostic[] };
	if (state.noThemes && themePaths.length === 0) {
		themesResult = { themes: [], diagnostics: [] };
	} else {
		const loaded = loadThemes(loader, themePaths, false);
		const deduped = dedupeThemes(loaded.themes);
		themesResult = { themes: deduped.themes, diagnostics: [...loaded.diagnostics, ...deduped.diagnostics] };
	}
	const resolvedThemes = state.themesOverride ? state.themesOverride(themesResult) : themesResult;
	state.themes = resolvedThemes.themes.map((theme) => {
		const sourcePath = theme.sourcePath;
		theme.sourceInfo = sourcePath
			? (findSourceInfoForPath(loader, sourcePath, state.extensionThemeSourceInfos, metadataByPath) ??
				theme.sourceInfo ??
				getDefaultSourceInfoForPath(loader, sourcePath))
			: theme.sourceInfo;
		return theme;
	});
	state.themeDiagnostics = resolvedThemes.diagnostics;
}

function loadThemes(
	loader: DefaultResourceLoader,
	paths: string[],
	includeDefaults = true,
): {
	themes: Theme[];
	diagnostics: ResourceDiagnostic[];
} {
	const state = resourceInternals(loader);
	const themes: Theme[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	if (includeDefaults) {
		const defaultDirs = [
			...getLoaderAgentDirs(state.agentDir).map((agentDir) => join(agentDir, "themes")),
			...getProjectThemeDirs(state.cwd),
		];

		for (const dir of defaultDirs) {
			loadThemesFromDir(dir, themes, diagnostics);
		}
	}

	for (const p of paths) {
		const resolved = resolveResourcePath(state.cwd, p);
		if (!existsSync(resolved)) {
			diagnostics.push({ type: "warning", message: "theme path does not exist", path: resolved });
			continue;
		}

		try {
			const stats = statSync(resolved);
			if (stats.isDirectory()) {
				loadThemesFromDir(resolved, themes, diagnostics);
			} else if (stats.isFile() && resolved.endsWith(".json")) {
				loadThemeFromFile(resolved, themes, diagnostics);
			} else {
				diagnostics.push({ type: "warning", message: "theme path is not a json file", path: resolved });
			}
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

function loadThemesFromDir(dir: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
	if (!existsSync(dir)) {
		return;
	}

	try {
		const entries = readdirSync(dir, { withFileTypes: true });
		for (const entry of entries) {
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = statSync(join(dir, entry.name)).isFile();
				} catch {
					continue;
				}
			}
			if (!isFile) {
				continue;
			}
			if (!entry.name.endsWith(".json")) {
				continue;
			}
			loadThemeFromFile(join(dir, entry.name), themes, diagnostics);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read theme directory";
		diagnostics.push({ type: "warning", message, path: dir });
	}
}

function loadThemeFromFile(filePath: string, themes: Theme[], diagnostics: ResourceDiagnostic[]): void {
	try {
		themes.push(loadThemeFromPath(filePath));
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to load theme";
		diagnostics.push({ type: "warning", message, path: filePath });
	}
}

function dedupePrompts(prompts: PromptTemplate[]): { prompts: PromptTemplate[]; diagnostics: ResourceDiagnostic[] } {
	const seen = new Map<string, PromptTemplate>();
	const diagnostics: ResourceDiagnostic[] = [];

	for (const prompt of prompts) {
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

	return { prompts: Array.from(seen.values()), diagnostics };
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

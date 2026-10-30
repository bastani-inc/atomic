import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../config.js";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { isPathWithin, resolvePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";
import type { LoadPromptTemplatesOptions, LoadPromptTemplatesResult, PromptTemplate } from "./prompt-templates.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";

const YIELD_AFTER_MS = 8;

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function loadTemplateFromFile(
	filePath: string,
	sourceInfo: SourceInfo,
): Promise<{ template: PromptTemplate | null; diagnostics: ResourceDiagnostic[] }> {
	const diagnostics: ResourceDiagnostic[] = [];
	let rawContent: string;
	try {
		rawContent = await readFile(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read prompt template file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { template: null, diagnostics };
	}

	let frontmatter: Record<string, string | undefined>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<Record<string, string | undefined>>(rawContent));
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to parse prompt template file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { template: null, diagnostics };
	}

	const name = basename(filePath).replace(/\.md$/, "");
	let description = typeof frontmatter.description === "string" ? frontmatter.description : "";
	if (!description) {
		const firstLine = body.split("\n").find((line) => line.trim());
		if (firstLine) description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
	}
	const argumentHint = typeof frontmatter["argument-hint"] === "string" ? frontmatter["argument-hint"] : undefined;
	return {
		template: {
			name,
			description,
			...(argumentHint && { argumentHint }),
			content: body,
			sourceInfo,
			filePath,
		},
		diagnostics,
	};
}

async function loadTemplatesFromDir(
	dir: string,
	getSourceInfo: (filePath: string) => Promise<SourceInfo>,
): Promise<LoadPromptTemplatesResult> {
	const templates: PromptTemplate[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	if (!(await exists(dir))) return { templates, diagnostics };
	const startedAt = Date.now();
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			await yieldToEventLoopIfSlow(startedAt, YIELD_AFTER_MS);
			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					isFile = (await stat(fullPath)).isFile();
				} catch {
					continue;
				}
			}
			if (!isFile || !entry.name.endsWith(".md")) continue;
			const result = await loadTemplateFromFile(fullPath, await getSourceInfo(fullPath));
			if (result.template) templates.push(result.template);
			diagnostics.push(...result.diagnostics);
		}
	} catch {}
	return { templates, diagnostics };
}

export async function loadPromptTemplatesAsync(
	options: LoadPromptTemplatesOptions,
): Promise<LoadPromptTemplatesResult> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);
	const promptPaths = options.promptPaths ?? [];
	const includeDefaults = options.includeDefaults ?? true;
	const templates: PromptTemplate[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	const addResult = (result: LoadPromptTemplatesResult): void => {
		templates.push(...result.templates);
		diagnostics.push(...result.diagnostics);
	};
	const globalPromptsDir = join(resolvedAgentDir, "prompts");
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");
	const getSourceInfo = async (resolvedPath: string): Promise<SourceInfo> => {
		if (isPathWithin(globalPromptsDir, resolvedPath)) {
			return createSyntheticSourceInfo(resolvedPath, { source: "local", scope: "user", baseDir: globalPromptsDir });
		}
		if (isPathWithin(projectPromptsDir, resolvedPath)) {
			return createSyntheticSourceInfo(resolvedPath, {
				source: "local",
				scope: "project",
				baseDir: projectPromptsDir,
			});
		}
		const stats = await stat(resolvedPath);
		return createSyntheticSourceInfo(resolvedPath, {
			source: "local",
			baseDir: stats.isDirectory() ? resolvedPath : dirname(resolvedPath),
		});
	};
	if (includeDefaults) {
		addResult(await loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
		addResult(await loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
	}
	const startedAt = Date.now();
	for (const rawPath of promptPaths) {
		await yieldToEventLoopIfSlow(startedAt, YIELD_AFTER_MS);
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!(await exists(resolvedPath))) continue;
		try {
			const stats = await stat(resolvedPath);
			if (stats.isDirectory()) {
				addResult(await loadTemplatesFromDir(resolvedPath, getSourceInfo));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const result = await loadTemplateFromFile(resolvedPath, await getSourceInfo(resolvedPath));
				if (result.template) templates.push(result.template);
				diagnostics.push(...result.diagnostics);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "failed to read prompt template path";
			diagnostics.push({ type: "warning", message, path: resolvedPath });
		}
	}
	return { templates, diagnostics };
}

import { access, readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";
import { yieldToEventLoopIfSlow } from "../utils/event-loop.ts";
import { resolvePath } from "../utils/paths.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import type { LoadPromptTemplatesOptions, PromptTemplate } from "./prompt-templates.ts";

const YIELD_AFTER_MS = 8;

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

async function loadTemplateFromFile(filePath: string, sourceInfo: SourceInfo): Promise<PromptTemplate | null> {
	try {
		const rawContent = await readFile(filePath, "utf-8");
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(rawContent);
		const name = basename(filePath).replace(/\.md$/, "");
		let description = frontmatter.description || "";
		if (!description) {
			const firstLine = body.split("\n").find((line) => line.trim());
			if (firstLine) description = firstLine.length > 60 ? `${firstLine.slice(0, 60)}...` : firstLine;
		}
		return {
			name,
			description,
			...(frontmatter["argument-hint"] && { argumentHint: frontmatter["argument-hint"] }),
			content: body,
			sourceInfo,
			filePath,
		};
	} catch {
		return null;
	}
}

async function loadTemplatesFromDir(
	dir: string,
	getSourceInfo: (filePath: string) => Promise<SourceInfo>,
): Promise<PromptTemplate[]> {
	const templates: PromptTemplate[] = [];
	if (!(await exists(dir))) return templates;
	const startedAt = Date.now();
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		for (const entry of entries) {
			await yieldToEventLoopIfSlow(startedAt, YIELD_AFTER_MS);
			const fullPath = join(dir, entry.name);
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try { isFile = (await stat(fullPath)).isFile(); } catch { continue; }
			}
			if (!isFile || !entry.name.endsWith(".md")) continue;
			const template = await loadTemplateFromFile(fullPath, await getSourceInfo(fullPath));
			if (template) templates.push(template);
		}
	} catch {}
	return templates;
}

export async function loadPromptTemplatesAsync(options: LoadPromptTemplatesOptions): Promise<PromptTemplate[]> {
	const resolvedCwd = resolvePath(options.cwd);
	const resolvedAgentDir = resolvePath(options.agentDir);
	const promptPaths = options.promptPaths ?? [];
	const includeDefaults = options.includeDefaults ?? true;
	const templates: PromptTemplate[] = [];
	const globalPromptsDir = join(resolvedAgentDir, "prompts");
	const projectPromptsDir = resolve(resolvedCwd, CONFIG_DIR_NAME, "prompts");
	const isUnderPath = (target: string, root: string): boolean => {
		const normalizedRoot = resolve(root);
		return target === normalizedRoot || target.startsWith(normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`);
	};
	const getSourceInfo = async (resolvedPath: string): Promise<SourceInfo> => {
		if (isUnderPath(resolvedPath, globalPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, { source: "local", scope: "user", baseDir: globalPromptsDir });
		}
		if (isUnderPath(resolvedPath, projectPromptsDir)) {
			return createSyntheticSourceInfo(resolvedPath, { source: "local", scope: "project", baseDir: projectPromptsDir });
		}
		const stats = await stat(resolvedPath);
		return createSyntheticSourceInfo(resolvedPath, { source: "local", baseDir: stats.isDirectory() ? resolvedPath : dirname(resolvedPath) });
	};
	if (includeDefaults) {
		templates.push(...await loadTemplatesFromDir(globalPromptsDir, getSourceInfo));
		templates.push(...await loadTemplatesFromDir(projectPromptsDir, getSourceInfo));
	}
	const startedAt = Date.now();
	for (const rawPath of promptPaths) {
		await yieldToEventLoopIfSlow(startedAt, YIELD_AFTER_MS);
		const resolvedPath = resolvePath(rawPath, resolvedCwd, { trim: true });
		if (!(await exists(resolvedPath))) continue;
		try {
			const stats = await stat(resolvedPath);
			if (stats.isDirectory()) {
				templates.push(...await loadTemplatesFromDir(resolvedPath, getSourceInfo));
			} else if (stats.isFile() && resolvedPath.endsWith(".md")) {
				const template = await loadTemplateFromFile(resolvedPath, await getSourceInfo(resolvedPath));
				if (template) templates.push(template);
			}
		} catch {}
	}
	return templates;
}

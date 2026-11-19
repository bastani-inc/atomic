import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import type { AgentState } from "@bastani/atomic-agent-core";
import { basename, join } from "path";
import { APP_NAME, getExportTemplateDirAsync } from "../../config.js";
import { getResolvedThemeColors, getThemeExportColors } from "../../modes/interactive/theme/theme.js";
import { normalizePath, resolvePath } from "../../utils/paths.ts";
import { SessionManager } from "../session-manager.ts";
import { SessionNotFoundError } from "../storage/session/errors.js";
import { renderHtmlInputs } from "./render-inputs.js";
import { type SavedAgentCard, savedFileCards } from "./saved-agent-cards.js";
import { captureHtmlHistory, encodeSessionData, sessionDataBytes } from "./session-data.js";

/**
 * Interface for rendering custom tools to HTML.
 * Used by agent-session to pre-render extension tool output.
 */
export interface ToolHtmlRenderer {
	/** Discard transient renderer state for a call after its output has been written. */
	releaseCall?(toolCallId: string): void;
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to HTML. Returns collapsed/expanded or undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

export interface ExportOptions {
	outputPath?: string;
	themeName?: string;
	/** Optional tool renderer for custom tools */
	toolRenderer?: ToolHtmlRenderer;
}

/** Parse a color string to RGB values. Supports hex (#RRGGBB) and rgb(r,g,b) formats. */
function parseColor(color: string): { r: number; g: number; b: number } | undefined {
	const hexMatch = color.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
	if (hexMatch) {
		return {
			r: Number.parseInt(hexMatch[1], 16),
			g: Number.parseInt(hexMatch[2], 16),
			b: Number.parseInt(hexMatch[3], 16),
		};
	}
	const rgbMatch = color.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
	if (rgbMatch) {
		return {
			r: Number.parseInt(rgbMatch[1], 10),
			g: Number.parseInt(rgbMatch[2], 10),
			b: Number.parseInt(rgbMatch[3], 10),
		};
	}
	return undefined;
}

/** Calculate relative luminance of a color (0-1, higher = lighter). */
function getLuminance(r: number, g: number, b: number): number {
	const toLinear = (c: number) => {
		const s = c / 255;
		return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** Adjust color brightness. Factor > 1 lightens, < 1 darkens. */
function adjustBrightness(color: string, factor: number): string {
	const parsed = parseColor(color);
	if (!parsed) return color;
	const adjust = (c: number) => Math.min(255, Math.max(0, Math.round(c * factor)));
	return `rgb(${adjust(parsed.r)}, ${adjust(parsed.g)}, ${adjust(parsed.b)})`;
}

/** Derive export background colors from a base color (e.g., userMessageBg). */
function deriveExportColors(baseColor: string): { pageBg: string; cardBg: string; infoBg: string } {
	const parsed = parseColor(baseColor);
	if (!parsed) {
		return {
			pageBg: "rgb(24, 24, 30)",
			cardBg: "rgb(30, 30, 36)",
			infoBg: "rgb(60, 55, 40)",
		};
	}

	const luminance = getLuminance(parsed.r, parsed.g, parsed.b);
	const isLight = luminance > 0.5;

	if (isLight) {
		return {
			pageBg: adjustBrightness(baseColor, 0.96),
			cardBg: baseColor,
			infoBg: `rgb(${Math.min(255, parsed.r + 10)}, ${Math.min(255, parsed.g + 5)}, ${Math.max(0, parsed.b - 20)})`,
		};
	}
	return {
		pageBg: adjustBrightness(baseColor, 0.7),
		cardBg: adjustBrightness(baseColor, 0.85),
		infoBg: `rgb(${Math.min(255, parsed.r + 20)}, ${Math.min(255, parsed.g + 15)}, ${parsed.b})`,
	};
}

/**
 * Generate CSS custom property declarations from theme colors.
 */
function generateThemeVars(themeName?: string): string {
	const colors = getResolvedThemeColors(themeName);
	const lines: string[] = [];
	for (const [key, value] of Object.entries(colors)) {
		lines.push(`--${key}: ${value};`);
	}

	// Use explicit theme export colors if available, otherwise derive from userMessageBg
	const themeExport = getThemeExportColors(themeName);
	const userMessageBg = colors.userMessageBg || "#343541";
	const derivedColors = deriveExportColors(userMessageBg);

	lines.push(`--exportPageBg: ${themeExport.pageBg ?? derivedColors.pageBg};`);
	lines.push(`--exportCardBg: ${themeExport.cardBg ?? derivedColors.cardBg};`);
	lines.push(`--exportInfoBg: ${themeExport.infoBg ?? derivedColors.infoBg};`);

	return lines.join("\n      ");
}

/** The fixed HTML before and after the streamed session data. */
async function htmlTemplate(themeName?: string, cards?: SavedAgentCard[]): Promise<readonly [string, string, boolean]> {
	const templateDir = await getExportTemplateDirAsync();
	const [template, templateCss, templateJs, markedJs, markedCjkFriendlyJs, hljsJs] = await Promise.all(
		[
			["template.html"],
			["template.css"],
			["template.js"],
			["vendor", "marked.min.js"],
			["vendor", "marked-cjk-friendly.min.js"],
			["vendor", "highlight.min.js"],
		].map((parts) => readFile(join(templateDir, ...parts), "utf-8")),
	);

	const themeVars = generateThemeVars(themeName);
	const colors = getResolvedThemeColors(themeName);
	const themeExport = getThemeExportColors(themeName);
	const derivedExportColors = deriveExportColors(colors.userMessageBg || "#343541");
	const bodyBg = themeExport.pageBg ?? derivedExportColors.pageBg;
	const containerBg = themeExport.cardBg ?? derivedExportColors.cardBg;
	const infoBg = themeExport.infoBg ?? derivedExportColors.infoBg;

	let viewer = templateJs;
	let includesCards = false;
	const toolRow = /function renderToolCall\(call\) \{\r?\n +const result = findToolResult\(call\.id\);/;
	const startRows = "        const fragment = document.createDocumentFragment();";
	const paintedRows = "        messagesEl.appendChild(fragment);";
	const initialRender = "      // Initial render";
	if (
		cards &&
		toolRow.test(viewer) &&
		[startRows, paintedRows, initialRender].every((slot) => viewer.includes(slot))
	) {
		const cardViewer = await readFile(join(templateDir, "saved-agent-viewer.js"), "utf8").catch(() => undefined);
		if (cardViewer) {
			viewer = viewer
				.replace(toolRow, "function renderToolCall(call, result = findToolResult(call.id)) {")
				.replace(startRows, () => `${startRows}\n        acceptedCards = null;`)
				.replace(paintedRows, () => `${paintedRows}\n        paintSavedAgentCards();`)
				.replace(initialRender, () => `${cardViewer}\n${initialRender}`);
			includesCards = true;
		}
	}

	// Build the CSS with theme variables injected
	const css = templateCss
		.replace("{{THEME_VARS}}", () => themeVars)
		.replace("{{BODY_BG}}", () => bodyBg)
		.replace("{{CONTAINER_BG}}", () => containerBg)
		.replace("{{INFO_BG}}", () => infoBg);

	const [prefix, suffix] = template.split("{{SESSION_DATA}}");
	if (prefix === undefined || suffix === undefined)
		throw new Error("Session export template is missing its data slot");
	const fill = (part: string) =>
		part
			.replace("{{CSS}}", () => css)
			.replace("{{JS}}", () => viewer)
			.replace("{{MARKED_JS}}", () => markedJs)
			.replace("{{MARKED_CJK_FRIENDLY_JS}}", () => markedCjkFriendlyJs)
			.replace("{{HIGHLIGHT_JS}}", () => hljsJs);
	return [fill(prefix), fill(suffix), includesCards];
}

/**
 * Export session to HTML using SessionManager and AgentState.
 * Used by TUI's /export command.
 */
export async function exportSessionToHtml(
	sm: SessionManager,
	state?: AgentState,
	options?: ExportOptions | string,
): Promise<string> {
	return writeSessionHtml(sm, state, typeof options === "string" ? { outputPath: options } : options || {});
}

async function writeSessionHtml(
	sm: SessionManager,
	state: AgentState | undefined,
	opts: ExportOptions,
	standalone = false,
) {
	const sessionFile = sm.getSessionFile();
	const sessionBasename = sessionFile ? basename(sessionFile, ".jsonl") : sm.getSessionId();
	const source = await captureHtmlHistory(sm).catch((error: Error) => {
		if (error instanceof SessionNotFoundError) throw new Error("Nothing to export yet - start a conversation first");
		throw error;
	});
	const cards = standalone ? await savedFileCards(source) : undefined;
	const inputs = opts.toolRenderer ? await renderHtmlInputs(source.readHistory(), opts.toolRenderer) : undefined;
	const presentation = {
		systemPrompt: state?.systemPrompt,
		tools: state?.tools?.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })),
	};
	const [prefix, suffix, includesCards] = await htmlTemplate(opts.themeName, cards);
	inputs?.freezeInputs();
	const metadataJson = JSON.stringify({
		leafId: source.leafId,
		...presentation,
		savedAgentCards: includesCards ? cards : undefined,
	});

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		outputPath = `${APP_NAME}-session-${sessionBasename}.html`;
	}

	const target = await realpath(outputPath).catch(() => outputPath);
	const mode = await stat(target).then(
		(s) => s.mode & 0o7777,
		() => 0o600,
	);
	const partial = `${target}.${randomUUID()}.partial`;
	try {
		const output = await open(partial, "wx", 0o600);
		try {
			await output.writeFile(prefix);
			for await (const encoded of encodeSessionData(sessionDataBytes(source, metadataJson, inputs)))
				await output.writeFile(encoded);
			await output.writeFile(suffix);
			await output.chmod(mode);
		} finally {
			await output.close();
		}
		await rename(partial, target);
	} catch (error) {
		await rm(partial, { force: true });
		if (error instanceof SessionNotFoundError) throw new Error("Nothing to export yet - start a conversation first");
		throw error;
	}
	return outputPath;
}

/**
 * Export session file to HTML (standalone, without AgentState).
 * Used by CLI for exporting arbitrary session files.
 */
export async function exportFromFile(inputPath: string, options?: ExportOptions | string): Promise<string> {
	const opts: ExportOptions = typeof options === "string" ? { outputPath: options } : options || {};
	const resolvedInputPath = resolvePath(inputPath);

	if (!existsSync(resolvedInputPath)) {
		throw new Error(`File not found: ${resolvedInputPath}`);
	}

	const sm = await SessionManager.open(resolvedInputPath);

	let outputPath = opts.outputPath ? normalizePath(opts.outputPath) : undefined;
	if (!outputPath) {
		const inputBasename = basename(resolvedInputPath, ".jsonl");
		outputPath = `${APP_NAME}-session-${inputBasename}.html`;
	}

	try {
		return await writeSessionHtml(sm, undefined, { ...opts, outputPath }, true);
	} finally {
		await sm.getSessionStore().close();
	}
}

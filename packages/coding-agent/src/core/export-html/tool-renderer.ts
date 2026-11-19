/**
 * Tool HTML renderer for custom tools in HTML export.
 *
 * Renders custom tool calls and results to HTML by invoking their TUI renderers
 * and converting the ANSI output to HTML.
 */

import type { ImageContent, TextContent } from "@bastani/atomic-ai/compat";
import { type Component, Text } from "@bastani/atomic-tui";
import { keyHint, keyText } from "../../modes/interactive/components/keybinding-hints.js";
import { isToolBlock } from "../../modes/interactive/components/tool-block.ts";
import type { Theme } from "../../modes/interactive/theme/theme.js";
import type { ToolRenderContext, ToolRenderers } from "../extensions/types.ts";
import { ansiLinesToHtml, stripAnsiEscapes } from "./ansi-to-html.ts";

export interface ToolHtmlRendererDeps {
	/** Renderers of calls to a tool, resolved by extensions and the registered tool. */
	getToolRenderers: (name: string) => ToolRenderers | undefined;
	/** Theme for styling */
	theme: Theme;
	/** Working directory for render context */
	cwd: string;
	/** Terminal width for rendering (default: 100) */
	width?: number;
}

export interface ToolHtmlRenderer {
	releaseCall?(toolCallId: string): void;
	/** Render a tool call to HTML. Returns undefined if tool has no custom renderer. */
	renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined;
	/** Render a tool result to collapsed/expanded HTML. Returns undefined if tool has no custom renderer. */
	renderResult(
		toolCallId: string,
		toolName: string,
		result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
		details: unknown,
		isError: boolean,
	): { collapsed?: string; expanded?: string } | undefined;
}

/**
 * Create a tool HTML renderer.
 *
 * The renderer looks up tool definitions and invokes their renderCall/renderResult
 * methods, converting the resulting TUI Component output (ANSI) to HTML.
 */
function isBlankRenderedLine(line: string): boolean {
	return stripAnsiEscapes(line).trim().length === 0;
}

function trimRenderedResultLines(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlankRenderedLine(lines[start])) start++;
	while (end > start && isBlankRenderedLine(lines[end - 1])) end--;
	return lines.slice(start, end);
}

export function createToolHtmlRenderer(deps: ToolHtmlRendererDeps): ToolHtmlRenderer {
	const { getToolRenderers, theme, cwd, width = 100 } = deps;

	const renderedCallComponents = new Map<string, Component>();
	const renderedResultComponents = new Map<string, Component>();
	const canonicalResultCallHtml = new Map<string, string>();
	const renderedStates = new Map<string, Record<string, unknown>>();
	const renderedArgs = new Map<string, unknown>();

	const getState = (toolCallId: string): Record<string, unknown> => {
		let state = renderedStates.get(toolCallId);
		if (!state) {
			state = {};
			renderedStates.set(toolCallId, state);
		}
		return state;
	};

	const createRenderContext = (
		toolCallId: string,
		lastComponent: Component | undefined,
		expanded: boolean,
		isPartial: boolean,
		isError: boolean,
	): ToolRenderContext => {
		return {
			args: renderedArgs.get(toolCallId),
			toolCallId,
			invalidate: () => {},
			lastComponent,
			state: getState(toolCallId),
			cwd,
			executionStarted: true,
			argsComplete: true,
			isPartial,
			expanded,
			showImages: false,
			isError,
			durationMs: undefined,
			outputPad: 1,
			keyText,
			keyHint,
		};
	};

	return {
		releaseCall(id) {
			renderedCallComponents.delete(id);
			renderedResultComponents.delete(id);
			canonicalResultCallHtml.delete(id);
			renderedStates.delete(id);
			renderedArgs.delete(id);
		},
		renderCall(toolCallId: string, toolName: string, args: unknown): string | undefined {
			renderedArgs.set(toolCallId, args);
			const canonicalCallHtml = canonicalResultCallHtml.get(toolCallId);
			if (canonicalCallHtml !== undefined) {
				return canonicalCallHtml;
			}
			let hasCustomCallRenderer = false;
			try {
				const toolDef = getToolRenderers(toolName);
				if (!toolDef?.renderCall) {
					return undefined;
				}
				hasCustomCallRenderer = true;

				const component = toolDef.renderCall(
					args,
					theme,
					createRenderContext(toolCallId, renderedCallComponents.get(toolCallId), false, true, false),
				);
				renderedCallComponents.set(toolCallId, component);
				const rawLines = component.render(width);
				const lines = isToolBlock(component) ? trimRenderedResultLines(rawLines) : rawLines;
				return ansiLinesToHtml(lines);
			} catch {
				renderedCallComponents.delete(toolCallId);
				if (!hasCustomCallRenderer) {
					return undefined;
				}
				const title =
					typeof theme?.fg === "function" && typeof theme?.bold === "function"
						? theme.fg("toolTitle", theme.bold(toolName))
						: toolName;
				return ansiLinesToHtml(new Text(title, 0, 0).render(width));
			}
		},

		renderResult(
			toolCallId: string,
			toolName: string,
			result: Array<{ type: string; text?: string; data?: string; mimeType?: string }>,
			details: unknown,
			isError: boolean,
		): { collapsed?: string; expanded?: string } | undefined {
			canonicalResultCallHtml.delete(toolCallId);
			let hasCustomResultRenderer = false;
			try {
				const toolDef = getToolRenderers(toolName);
				if (!toolDef?.renderResult) {
					const callComponent = renderedCallComponents.get(toolCallId);
					if (callComponent && isToolBlock(callComponent)) {
						return { expanded: "" };
					}
					return undefined;
				}
				hasCustomResultRenderer = true;

				// Build AgentToolResult from content array
				// Cast content since session storage uses generic object types
				const agentToolResult = {
					content: result as (TextContent | ImageContent)[],
					details,
					isError,
				};

				// Render collapsed
				const collapsedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: false, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), false, false, isError),
				);
				renderedResultComponents.set(toolCallId, collapsedComponent);
				const collapsedLines = trimRenderedResultLines(collapsedComponent.render(width));
				const collapsed = ansiLinesToHtml(collapsedLines);

				// Render expanded
				const expandedComponent = toolDef.renderResult(
					agentToolResult,
					{ expanded: true, isPartial: false },
					theme,
					createRenderContext(toolCallId, renderedResultComponents.get(toolCallId), true, false, isError),
				);
				renderedResultComponents.set(toolCallId, expandedComponent);
				const expandedLines = trimRenderedResultLines(expandedComponent.render(width));
				const expanded = ansiLinesToHtml(expandedLines);

				if (isToolBlock(collapsedComponent) || isToolBlock(expandedComponent)) {
					const [collapsedHeader, ...collapsedRest] = collapsedLines;
					const [expandedHeader, ...expandedRest] = expandedLines;
					if (
						!collapsed ||
						collapsed === expanded ||
						collapsedHeader === undefined ||
						collapsedHeader !== expandedHeader
					) {
						canonicalResultCallHtml.set(toolCallId, expanded || collapsed);
						return { expanded: "" };
					}
					canonicalResultCallHtml.set(toolCallId, ansiLinesToHtml([collapsedHeader]));
					const collapsedBody = ansiLinesToHtml(trimRenderedResultLines(collapsedRest));
					const expandedBody = ansiLinesToHtml(trimRenderedResultLines(expandedRest));
					return {
						...(collapsedBody && collapsedBody !== expandedBody ? { collapsed: collapsedBody } : {}),
						expanded: expandedBody,
					};
				}

				return {
					...(collapsed && collapsed !== expanded ? { collapsed } : {}),
					expanded,
				};
			} catch {
				renderedResultComponents.delete(toolCallId);
				if (!hasCustomResultRenderer) {
					return undefined;
				}
				const warning =
					typeof theme?.fg === "function"
						? theme.fg("warning", "Result renderer failed")
						: "Result renderer failed";
				return {
					expanded: ansiLinesToHtml(trimRenderedResultLines(new Text(warning, 0, 0).render(width))),
				};
			}
		},
	};
}

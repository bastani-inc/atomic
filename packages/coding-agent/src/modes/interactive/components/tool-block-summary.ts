import { singleLineDisplayText } from "../../../utils/terminal-text.ts";
import { builtinToolBlockPresentation } from "./tool-block-families.ts";

function plainArguments(tool: string, text: string): Record<string, string | string[]> | undefined {
	switch (tool) {
		case "bash":
			return { command: text };
		case "read":
		case "edit":
		case "write":
		case "ls":
			return { path: text };
		case "search":
		case "grep":
		case "find":
			return { pattern: text };
		case "web_search":
			return { query: text };
		case "fetch_content":
			return { urls: [text] };
		case "todo":
			return { action: text };
		case "wait":
			return { id: text };
		default:
			return undefined;
	}
}

export function formatToolActionSummary(action: { tool: string; text: string }, cwd = process.cwd()): string {
	const input = {
		toolName: action.tool,
		expanded: false,
		isPartial: false,
		cwd,
		executionStarted: true,
		argsComplete: true,
	};
	const family = builtinToolBlockPresentation({ ...input, args: undefined });
	if (!family) return `${singleLineDisplayText(action.tool).trim()}(…)`;
	const text = action.text.trim();
	let args: unknown;
	try {
		const parsed: unknown = JSON.parse(text);
		args =
			typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
				? parsed
				: typeof parsed === "string"
					? plainArguments(action.tool, parsed)
					: undefined;
	} catch {
		args = text && !/^[{["\d-]|^(?:true|false|null)\b/u.test(text) ? plainArguments(action.tool, text) : undefined;
	}
	const presentation = args === undefined ? undefined : builtinToolBlockPresentation({ ...input, args });
	return singleLineDisplayText(`${presentation?.title ?? family.title}(${presentation?.args ?? "…"})`).trim();
}

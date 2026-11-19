/**
 * Renderers for exporting a saved session file without a running session (`atomic --export <file>`): the tools Atomic
 * ships draw their calls and results as the chat draws them, with no extension loaded.
 */

import { codemodeRenderers } from "../../extensions/codemode/renderer.ts";
import type { ToolRenderers } from "../extensions/types.ts";
import { withBuiltinToolBlockRenderers } from "../tools/builtin-renderers.ts";

/** Built-in tools the chat draws through their renderers rather than the export page's own drawing. */
const BUILTIN_RENDERED_TOOLS = ["find", "grep", "search", "todo"] as const;

const renderers = new Map<string, ToolRenderers>([
	["codemode", codemodeRenderers],
	...BUILTIN_RENDERED_TOOLS.map((name): [string, ToolRenderers] => [
		name,
		withBuiltinToolBlockRenderers<ToolRenderers & { name: string }>({ name }),
	]),
]);

/** The renderers of a tool Atomic ships, by name; undefined for a tool an extension registers. */
export function savedSessionToolRenderers(name: string): ToolRenderers | undefined {
	return renderers.get(name);
}

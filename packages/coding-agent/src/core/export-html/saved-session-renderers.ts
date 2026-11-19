/**
 * Renderers for exporting a saved session file without a running session (`atomic --export <file>`): a codemode call
 * draws as the chat draws it, as its script, with no extension loaded. Other tools keep the page's own drawing, which
 * shows every argument and all of the result's text, such as a search's limit notice.
 */

import { savedCodemodeRenderers } from "../../extensions/codemode/renderer.ts";
import type { ToolRenderers } from "../extensions/types.ts";

/** The renderers of a tool Atomic ships, by name; undefined for a tool the page draws itself. */
export function savedSessionToolRenderers(name: string): ToolRenderers | undefined {
	return name === "codemode" ? savedCodemodeRenderers : undefined;
}

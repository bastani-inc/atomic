import { readFileSync } from "fs";
import { join } from "path";

export const EXPORT_HTML_TEMPLATE_SCRIPT_CHUNKS = [
	"data-tree.js",
	"tree-filter-render.js",
	"message-tools.js",
	"entries-navigation.js",
	"initialization.js",
] as const;

export function readExportHtmlTemplateScript(templateDir: string): string {
	return EXPORT_HTML_TEMPLATE_SCRIPT_CHUNKS.map((fileName) =>
		readFileSync(join(templateDir, "template-js", fileName), "utf-8"),
	).join("");
}

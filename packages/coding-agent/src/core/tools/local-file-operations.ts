import { constants } from "fs";
import { access, mkdir, readFile, writeFile } from "fs/promises";
import { stripBom } from "../../utils/text.ts";
import type { createEditToolDefinition, EditOperations } from "./edit.ts";
import { normalizeToLF } from "./edit-diff.ts";
import { isNotebookPath, readEditableNotebookText, serializeEditedNotebookText } from "./notebook.ts";
import { invalidateNativeSearchCache } from "./search-native.ts";
import type { WriteOperations } from "./write.ts";

/**
 * Local filesystem operations behind Atomic's built-in `edit`. A notebook is edited through the same cell-marker
 * projection `read` shows, and every write drops the file from the native search scan cache.
 */
export const localEditOperations: EditOperations = {
	readFile: async (path) =>
		isNotebookPath(path) ? Buffer.from(readEditableNotebookText(path, path), "utf-8") : readFile(path),
	writeFile: async (path, content) => {
		const persisted = isNotebookPath(path)
			? serializeEditedNotebookText(path, path, normalizeToLF(stripBom(content)))
			: content;
		await writeFile(path, persisted, "utf-8");
		invalidateNativeSearchCache(path);
	},
	access: (path) => access(path, constants.R_OK | constants.W_OK),
};

type EditToolDefinition = ReturnType<typeof createEditToolDefinition>;
type EditCallArgs = Parameters<NonNullable<EditToolDefinition["renderCall"]>>[0];

function withoutNotebookEdits<T extends EditCallArgs | undefined>(args: T): T {
	const path = (args as { file_path?: unknown } | undefined)?.file_path ?? args?.path;
	if (typeof path !== "string" || !isNotebookPath(path)) return args;
	const {
		edits: _edits,
		oldText: _oldText,
		newText: _newText,
		...rest
	} = args as EditCallArgs & {
		oldText?: unknown;
		newText?: unknown;
	};
	return rest as T;
}

/**
 * The built-in `edit` changes a notebook through `read`'s cell projection, but pi's preview diffs the raw `.ipynb`
 * JSON, where that text never matches. Notebook calls therefore render without a preview until the result's diff
 * arrives.
 */
export function withNotebookEditPreview(definition: EditToolDefinition): EditToolDefinition {
	const { renderCall, renderResult } = definition;
	return {
		...definition,
		renderCall: (args, theme, context) =>
			renderCall!(withoutNotebookEdits(args), theme, { ...context, args: withoutNotebookEdits(context.args) }),
		renderResult: (result, options, theme, context) =>
			renderResult!(result, options, theme, { ...context, args: withoutNotebookEdits(context.args) }),
	};
}

/** Local filesystem operations behind Atomic's built-in `write`; every write drops the file from the scan cache. */
export const localWriteOperations: WriteOperations = {
	writeFile: async (path, content) => {
		await writeFile(path, content, "utf-8");
		invalidateNativeSearchCache(path);
	},
	mkdir: async (dir) => {
		await mkdir(dir, { recursive: true });
	},
};

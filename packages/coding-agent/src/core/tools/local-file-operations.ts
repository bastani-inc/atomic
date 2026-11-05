import { constants } from "fs";
import { access, mkdir, readFile, writeFile } from "fs/promises";
import { stripBom } from "../../utils/text.ts";
import type { EditOperations } from "./edit.ts";
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

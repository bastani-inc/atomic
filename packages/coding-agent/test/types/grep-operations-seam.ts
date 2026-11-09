import type { GrepOperations } from "../../src/core/tools/grep.js";

export const directoryOnly: GrepOperations = { isDirectory: () => true };
export const synchronousReader: GrepOperations = { isDirectory: () => true, readFile: (_path: string) => "context" };
export const asynchronousReader: GrepOperations = {
	isDirectory: async () => true,
	readFile: async (_path: string) => "context",
};

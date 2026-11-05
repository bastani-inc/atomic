import type { WriteOperations } from "../../src/index.js";

// The public write seam is pi's two-method shape (#4328): remote backends implement only these.
export const remoteWriter: WriteOperations = {
	mkdir: async (_path: string) => {},
	writeFile: async (_path: string, _content: string) => {},
};
// @ts-expect-error a backend must create parent directories in its own filesystem namespace.
export const missingMkdir: WriteOperations = { writeFile: async () => {} };
// @ts-expect-error a backend must write files in its own filesystem namespace.
export const missingWriteFile: WriteOperations = { mkdir: async () => {} };
export const withReader: WriteOperations = {
	mkdir: async () => {},
	writeFile: async () => {},
	// @ts-expect-error the removed read half of the seam is not part of WriteOperations.
	readFile: async () => "",
};

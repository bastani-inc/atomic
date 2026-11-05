// PR #2482: compile the real adapters and their public write seam, not transport shims.
import type { WriteOperations } from "@bastani/atomic";
// @ts-expect-error grep was removed from the public tool API; do not restore it for adapters.
import type { createGrepTool } from "@bastani/atomic";
// @ts-expect-error grep details are not a public compatibility API.
import type { GrepToolDetails } from "@bastani/atomic";
// @ts-expect-error grep input is not a public compatibility API.
import type { GrepToolInput } from "@bastani/atomic";

// A remote writer implements pi's two-method seam (#4328).
export const remoteWriter: WriteOperations = {
	mkdir: async (_path: string) => {},
	writeFile: async (_path: string, _content: string) => {},
};
// @ts-expect-error a backend must create parent directories in its own filesystem namespace.
export const missingMkdir: WriteOperations = { writeFile: async () => {} };
// @ts-expect-error a backend must write files in its own filesystem namespace.
export const missingWriteFile: WriteOperations = { mkdir: async () => {} };

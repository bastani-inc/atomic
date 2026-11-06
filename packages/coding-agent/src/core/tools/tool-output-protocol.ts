/**
 * tool-output:// resolution: the oversized output of a released workflow stage's tool call, kept as a blob of its
 * session in the session's store and read back through it, whatever host the store is on.
 *
 *   tool-output://<sha256>    the full output, one line per text line; read it with a `:N-M` range or search it
 *
 * Only the current session's outputs resolve. The scheme is read-only.
 */

import { Buffer } from "node:buffer";
import { toolOutputUrlHash } from "../session-tool-output.ts";
import { SessionBlobError } from "../storage/errors.js";
import type { SessionStore } from "../storage/session/types.js";
import type { InternalResourceRouter } from "./resource-selectors.ts";

export interface ToolOutputSources {
	readonly sessionId: () => string;
	readonly sessionStore: () => SessionStore;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Reads `tool-output://<sha256>` from the current session's store. A store that holds no blobs throws
 * `blobs-unsupported`; a hash the session does not hold, or a URL that names no hash, throws `blob-missing`.
 */
export function createToolOutputRouter(sources: ToolOutputSources): InternalResourceRouter {
	return {
		read: async (url) => {
			const hash = toolOutputUrlHash(url);
			if (hash === undefined) return undefined;
			const store = sources.sessionStore();
			const sessionId = sources.sessionId();
			if (store.getBlob === undefined) {
				throw new SessionBlobError("blobs-unsupported", { sessionId, adapter: store.descriptor.adapter });
			}
			const data = SHA256_HEX.test(hash) ? await store.getBlob(sessionId, hash) : undefined;
			if (data === undefined) throw new SessionBlobError("blob-missing", { sessionId, hash });
			return Buffer.from(data).toString("utf8");
		},
	};
}

import { resolve } from "node:path";
import { loadExtensions } from "../src/core/extensions/loader.ts";
import type { Extension } from "../src/core/extensions/types.ts";

const fixture = resolve(import.meta.dirname, "../../cursor/test/resumed-history-extension.ts");
const loaded = await loadExtensions([fixture], process.cwd());
const source = loaded.extensions[0];
if (!source) throw new Error(`Failed to load trusted Cursor test source: ${loaded.errors[0]?.error ?? "unknown error"}`);

/** Genuine loader-created, allowlisted source capability for deterministic registry tests. */
export const trustedCursorProviderSource: Extension = source;

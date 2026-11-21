/** Atomic's sources import `.js` specifiers that name `.ts` files; this hook resolves them for Node. */
const RESOLVE_TS_SOURCES = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;

/**
 * Node arguments for a child process that imports Atomic's TypeScript sources: Node strips their types, and the hook
 * resolves their `.js` specifiers.
 */
export const NODE_TS_SOURCE_ARGS = ["--import", `data:text/javascript,${encodeURIComponent(RESOLVE_TS_SOURCES)}`];

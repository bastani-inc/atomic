/**
 * Module code that registers a hook resolving the `.js` specifiers of Atomic's sources, which name `.ts` files, for
 * Node. A script that must not run with `--import` (Atomic treats a process that does as running a module loader) puts
 * it first, before it imports any source.
 */
export const NODE_TS_SOURCE_HOOK = `import { registerHooks } from "node:module";
registerHooks({ resolve(specifier, context, nextResolve) {
	try { return nextResolve(specifier, context); }
	catch (error) { if (/^\\.\\.?\\//.test(specifier) && specifier.endsWith(".js")) return nextResolve(specifier.slice(0, -3) + ".ts", context); throw error; }
} });`;

/**
 * Node arguments for a child process that imports Atomic's TypeScript sources: Node strips their types, and the hook
 * resolves their `.js` specifiers.
 */
export const NODE_TS_SOURCE_ARGS = ["--import", `data:text/javascript,${encodeURIComponent(NODE_TS_SOURCE_HOOK)}`];

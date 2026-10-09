import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.js";
import llamaExtension from "./llama/index.js";
import toolSearchExtension from "./tool-search/index.js";

export const defaultBuiltinExtensions: readonly InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true, bundled: true },
	{ name: "codemode", factory: codemodeExtension, builtin: true, replaceable: true, bundled: true },
	{ name: "tool-search", factory: toolSearchExtension, builtin: true, replaceable: true, bundled: true },
];

export function withDefaultBuiltinExtensions(factories: readonly InlineExtension[]): InlineExtension[] {
	const named = new Set(factories.flatMap((input) => (typeof input === "function" ? [] : [input.name])));
	const missing = defaultBuiltinExtensions.filter((input) => typeof input === "function" || !named.has(input.name));
	return [...factories, ...missing];
}

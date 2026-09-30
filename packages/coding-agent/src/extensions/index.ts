import type { InlineExtension } from "../core/extensions/types.ts";
import codemodeExtension from "./codemode/index.js";
import herdrExtension from "./herdr/index.js";
import llamaExtension from "./llama/index.js";
import toolSearchExtension from "./tool-search/index.js";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, builtin: true, bundled: true },
	{ name: "codemode", factory: codemodeExtension, builtin: true, replaceable: true, bundled: true },
	{ name: "tool-search", factory: toolSearchExtension, builtin: true, replaceable: true, bundled: true },
	{ name: "Herdr", factory: herdrExtension, hidden: true, bundled: true },
];

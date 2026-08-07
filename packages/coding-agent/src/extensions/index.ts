import type { InlineExtension } from "../core/extensions/types.ts";
import herdrExtension from "./herdr/index.js";
import llamaExtension from "./llama/index.js";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, bundled: true },
	{ name: "herdr", factory: herdrExtension, hidden: true, bundled: true },
];

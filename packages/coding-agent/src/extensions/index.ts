import type { InlineExtension } from "../core/extensions/types.js";
import llamaExtension from "./llama/index.js";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, bundled: true },
];

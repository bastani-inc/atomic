import type { InlineExtension } from "../core/extensions/types.ts";
import feedbackExtension from "./feedback/index.js";
import llamaExtension from "./llama/index.js";

export const builtInExtensions: InlineExtension[] = [
	{ name: "feedback", factory: feedbackExtension, hidden: true, bundled: true },
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, bundled: true },
];

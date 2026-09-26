import type { InlineExtension } from "../core/extensions/types.ts";
import herdrExtension from "./herdr/index.js";
import llamaExtension from "./llama/index.js";
import webhooksExtension from "./webhooks/index.js";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true, bundled: true },
	{ name: "Herdr", factory: herdrExtension, hidden: true, bundled: true },
	{ name: "Webhooks", factory: webhooksExtension, hidden: true, bundled: true },
];

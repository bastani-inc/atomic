import type { InlineExtension } from "../core/extensions/types.ts";
import { defaultBuiltinExtensions } from "./default-builtins.js";
import herdrExtension from "./herdr/index.js";

export const builtInExtensions: InlineExtension[] = [
	...defaultBuiltinExtensions,
	{ name: "Herdr", factory: herdrExtension, hidden: true, bundled: true },
];

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createToolSearchToolDefinition } from "./tool.js";

export function createToolSearchExtension(): ExtensionFactory {
	return (pi) => pi.registerTool(createToolSearchToolDefinition({ tools: pi }));
}
export default createToolSearchExtension();

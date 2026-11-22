import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createToolSearchToolDefinition } from "./tool.js";

export function createToolSearchExtension(): ExtensionFactory {
	return (atomic) => atomic.registerTool(createToolSearchToolDefinition({ tools: atomic }));
}
export default createToolSearchExtension();

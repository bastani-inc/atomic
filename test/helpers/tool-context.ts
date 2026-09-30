import type { ExtensionContext, ExtensionToolContext } from "@bastani/atomic";

/** Direct tool fixtures have no session registry or nested execution host. */
export function toolContext(context: ExtensionContext): ExtensionToolContext {
	const toolCapabilities: Pick<ExtensionToolContext, "tools" | "executeTool"> = {
		tools: [],
		executeTool: async (name) => ({
			toolCall: { type: "toolCall", id: "fixture/nested", name, arguments: {} },
			result: {
				content: [{ type: "text", text: "Nested tools are not available in this direct-call fixture" }],
				details: {},
			},
			isError: true,
		}),
	};
	return Object.assign(context, toolCapabilities);
}

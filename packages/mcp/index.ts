import { createMcpExtension, type ExtensionAPI } from "@bastani/atomic";

export default function mcpExtension(pi: ExtensionAPI): void | Promise<void> {
	return createMcpExtension()(pi);
}

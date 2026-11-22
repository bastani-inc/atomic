import { createMcpExtension, type ExtensionAPI } from "@bastani/atomic";

export default function mcpExtension(atomic: ExtensionAPI): void | Promise<void> {
	return createMcpExtension()(atomic);
}

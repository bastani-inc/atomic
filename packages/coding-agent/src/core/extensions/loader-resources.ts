import type { McpServerContribution } from "../mcp-servers.ts";
import type { DefaultResourceLoaderInheritanceSnapshot } from "../resource-loader.ts";

/** Package-manifest MCP servers available to this loader's extensions. */
export interface PackageMcpServerSource {
	getMcpServers(): McpServerContribution[];
}

export type ResourceLoaderInheritanceSnapshotProvider = () => DefaultResourceLoaderInheritanceSnapshot;

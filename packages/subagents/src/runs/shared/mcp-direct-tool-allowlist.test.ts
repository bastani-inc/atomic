import { describe, expect, it } from "bun:test";
import {
	computeMcpServerHash,
	resolveMcpDirectToolNamesFromConfig,
	type McpConfig,
	type MetadataCache,
} from "./mcp-direct-tool-allowlist.ts";

describe("resolveMcpDirectToolNamesFromConfig", () => {
	it("filters direct MCP tools that collide with builtin search", () => {
		const server = { command: "echo" };
		const config: McpConfig = {
			mcpServers: { demo: server },
			settings: { toolPrefix: "none" },
		};
		const cache: MetadataCache = {
			version: 1,
			servers: {
				demo: {
					configHash: computeMcpServerHash(server),
					cachedAt: Date.now(),
					tools: [{ name: "search" }, { name: "custom" }],
				},
			},
		};

		expect(resolveMcpDirectToolNamesFromConfig(config, cache, "none", ["demo"])).toEqual(["custom"]);
	});
});

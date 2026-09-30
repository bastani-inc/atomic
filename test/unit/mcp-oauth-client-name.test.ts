import assert from "node:assert/strict";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import { afterEach, test, vi } from "vitest";
import { validateMcpConfig } from "../../packages/mcp/config.js";
import { shutdownOAuth, startAuth } from "../../packages/mcp/mcp-auth-flow.js";
import { McpOAuthProvider } from "../../packages/mcp/mcp-oauth-provider.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const registrations = vi.hoisted(() => [] as string[]);
vi.mock("@modelcontextprotocol/sdk/client/auth.js", async (original) => ({
	...(await original<typeof import("@modelcontextprotocol/sdk/client/auth.js")>()),
	auth: async (provider: OAuthClientProvider) => {
		registrations.push(provider.clientMetadata.client_name!);
		return "AUTHORIZED";
	},
}));
afterEach(async () => {
	await shutdownOAuth();
	vi.unstubAllEnvs();
	registrations.length = 0;
});

test("validates OAuth client name (#10226)", () => {
	const server = (clientName: string | number | null) => ({
		mcpServers: { docs: { url: "https://example.com/mcp", oauth: { clientName } } },
	});
	assert.equal(
		validateMcpConfig(server("Claude Code")).mcpServers.docs?.oauth &&
			(validateMcpConfig(server("Claude Code")).mcpServers.docs!.oauth as { clientName: string }).clientName,
		"Claude Code",
	);
	for (const name of ["", " ", 42, null])
		assert.throws(() => validateMcpConfig(server(name)), /oauth.clientName must be a non-empty string/);
});

test("registers configured OAuth name or Atomic default for both grant types (#10226)", async () => {
	const dir = makeTempDirectory("mcp-client-name-");
	vi.stubEnv("MCP_OAUTH_DIR", dir);
	try {
		for (const grantType of ["authorization_code", "client_credentials"] as const) {
			await startAuth("custom", "https://example.com/mcp", { oauth: { grantType, clientName: "Claude Code" } });
			await startAuth("default", "https://example.com/mcp", { oauth: { grantType } });
			const provider = new McpOAuthProvider(
				"custom",
				"https://example.com/mcp",
				{ grantType, clientName: "Claude Code" },
				{ onRedirect: () => {} },
			);
			assert.equal(provider.clientMetadata.client_name, "Claude Code");
		}
		assert.deepEqual(registrations, ["Claude Code", "atomic", "Claude Code", "atomic"]);
	} finally {
		await shutdownOAuth();
		removeTempDirectory(dir);
	}
});

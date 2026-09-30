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

test("skips only servers with an invalid OAuth client name and keeps the rest (#10226)", () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const server = (clientName: string | number | null) => ({
			url: "https://example.com/mcp",
			oauth: { clientName },
		});
		const config = validateMcpConfig({
			mcpServers: {
				good: server("Claude Code"),
				empty: server(""),
				blank: server(" "),
				number: server(42),
				missing: server(null),
				plain: { url: "https://example.com/plain" },
			},
		});
		assert.deepEqual(Object.keys(config.mcpServers), ["good", "plain"]);
		assert.deepEqual(config.mcpServers.good?.oauth, { clientName: "Claude Code" });
		for (const name of ["empty", "blank", "number", "missing"]) {
			assert.ok(
				warn.mock.calls.some(([message]) =>
					String(message).includes(`"${name}": oauth.clientName must be a non-empty string`),
				),
			);
		}
	} finally {
		warn.mockRestore();
	}
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

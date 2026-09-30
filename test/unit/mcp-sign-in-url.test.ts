import assert from "node:assert/strict";
import type { ExtensionContext } from "@bastani/atomic";
import { hyperlink, Text } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { authenticateServer } from "../../packages/mcp/commands.js";
import { createMcpPanel } from "../../packages/mcp/mcp-panel.js";

const auth = vi.hoisted(() => ({ url: `https://example.com/authorize?state=${"a".repeat(200)}` }));
vi.mock("../../packages/mcp/mcp-auth-flow.js", () => ({
	supportsOAuth: () => true,
	authenticate: async (_name: string, _url: string, _definition: object, onUrl: (url: string) => void) => {
		onUrl(auth.url);
		return "authenticated";
	},
	removeAuth: async () => {},
}));

test("MCP sign-in displays wrapped clickable URL and platform hint (#10186)", async () => {
	const notices: string[] = [];
	const partialContext: Partial<ExtensionContext> = {
		hasUI: true,
		ui: {
			notify: (message: string) => notices.push(message),
			setStatus: () => {},
		} as Partial<ExtensionContext["ui"]> as ExtensionContext["ui"],
	};
	const context = partialContext as ExtensionContext;
	const result = await authenticateServer(
		"docs",
		{ mcpServers: { docs: { url: "https://example.com/mcp" } } },
		context,
	);
	assert.equal(result.ok, true);
	assert.ok(notices[0]?.includes(hyperlink(auth.url, auth.url)));
	const hint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
	assert.ok(notices[0]?.includes(hyperlink(hint, auth.url)));
	const lines = new Text(notices[0]!, 0, 0).render(40);
	assert.ok(lines.length > 4);
	assert.ok(lines.some((line) => line.includes(`\x1b]8;;${auth.url}`)));
});

test("MCP sign-in hyperlink remains visible inside the active overlay (#10186)", () => {
	const panel = createMcpPanel(
		{ mcpServers: { docs: { url: "https://example.com/mcp" } } },
		null,
		new Map(),
		{
			canAuthenticate: () => true,
			authenticate: async (_name, onUrl) => {
				onUrl?.(auth.url);
				return new Promise(() => {});
			},
			reconnect: async () => false,
			getConnectionStatus: () => "needs-auth",
			refreshCacheAfterReconnect: () => null,
		},
		{ requestRender: () => {} },
		() => {},
		{ authOnly: true },
	);
	try {
		panel.handleInput("\r");
		const lines = panel.render(40);
		assert.ok(lines.filter((line) => line.includes(`\x1b]8;;${auth.url}`)).length > 2);
		assert.ok(lines.some((line) => line.includes("click to open")));
	} finally {
		panel.dispose();
	}
});

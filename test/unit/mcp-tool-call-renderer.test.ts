import assert from "node:assert/strict";
import { test } from "vitest";
import { theme as activeTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { McpCallRenderSource } from "../../packages/mcp/tool-call-renderer.js";
import { renderMcpDirectToolCall, renderMcpToolCall } from "../../packages/mcp/tool-call-renderer.js";

const theme = { fg: (_name: string, text: string) => text };
const source: McpCallRenderSource = {
	config: { mcpServers: { "github-mcp": { command: "unused" }, "my-server": { command: "unused" } } },
	toolMetadata: new Map([["github-mcp", [{ name: "create_issue", originalName: "create_issue", description: "" }]]]),
};
const render = (args: Record<string, unknown>, context = source): string =>
	renderMcpToolCall(args, theme, context).render(120).join("\n").trim();

test("pending gateway call identifies explicit, cached, and unambiguous prefix targets", () => {
	assert.equal(render({ server: "github-mcp", tool: "create_issue" }), "MCP github-mcp · create_issue");
	assert.equal(render({ tool: "create-issue" }), "MCP github-mcp · create-issue");
	assert.equal(render({ tool: "my_server_get" }), "MCP my-server · my_server_get");
	assert.equal(
		render(
			{ tool: "github_get" },
			{
				config: { ...source.config!, settings: { toolPrefix: "short" } },
			},
		),
		"MCP github-mcp · github_get",
	);
});

test("gateway operation labels follow dispatch precedence", () => {
	assert.equal(render({ connect: "my-server", server: "ignored" }), "MCP my-server · connect");
	assert.equal(render({ tool: "create_issue", connect: "ignored" }), "MCP github-mcp · create_issue");
	assert.equal(render({ describe: "create_issue" }), "MCP github-mcp · describe create_issue");
	assert.equal(render({ search: "private query", server: "my-server" }), "MCP my-server · search");
	assert.equal(render({ server: "my-server" }), "MCP my-server · tools");
	assert.equal(render({ action: "ui-messages", tool: "create_issue", server: "ignored" }), "MCP · ui-messages");
});

test("incomplete or unresolved arguments never invent server identity or expose tool arguments", () => {
	assert.equal(render({}), "MCP · status");
	assert.equal(render({ tool: 123, server: null }), "MCP · status");
	assert.equal(render({ tool: "unknown", args: '{"token":"secret"}' }), "MCP · unknown");
	assert.equal(
		render(
			{ tool: "my_server_get" },
			{
				config: { ...source.config!, settings: { toolPrefix: "none" } },
			},
		),
		"MCP · my_server_get",
	);
});

test("ambiguous metadata and colliding prefixes leave the server unresolved", () => {
	const tool = { name: "get", originalName: "get", description: "" };
	assert.equal(
		render(
			{ tool: "get" },
			{
				toolMetadata: new Map([
					["one", [tool]],
					["two", [tool]],
				]),
			},
		),
		"MCP · get",
	);
	assert.equal(
		render(
			{ tool: "my_server_get" },
			{
				config: { mcpServers: { "my-server": { command: "unused" }, my_server: { command: "unused" } } },
			},
		),
		"MCP · my_server_get",
	);
});

test("direct call header uses its registered identity, independent of prefix mode", () => {
	assert.equal(
		renderMcpDirectToolCall("github-mcp", "create_issue", theme).render(80).join("\n").trim(),
		"MCP github-mcp · create_issue",
	);
});

test("call labels strip terminal commands and keep names on one line", () => {
	const rendered = render({ server: "my\nserver\x1b[2J", tool: "tool\tname" });
	assert.equal(rendered, "MCP my server · tool name");
});

test("MCP argument previews show ordinary fields and redact credentials", () => {
	const args = { title: "hello", token: "private", nested: { password: "hidden" } };
	const collapsed = renderMcpDirectToolCall("github-mcp", "create_issue", theme, args).render(200).join("\n");
	assert.ok(collapsed.includes('title="hello"'));
	assert.ok(collapsed.includes("[redacted]"));
	assert.ok(!collapsed.includes("private") && !collapsed.includes("hidden"));
	const expanded = renderMcpDirectToolCall("github-mcp", "create_issue", theme, args, true).render(200).join("\n");
	assert.ok(expanded.includes("title: hello"));
	assert.ok(!expanded.includes("private") && !expanded.includes("hidden"));
});

test("registered MCP argument previews work with the runtime theme", () => {
	initTheme("dark");
	const rendered = renderMcpDirectToolCall("github-mcp", "create_issue", activeTheme, {
		title: "hello",
		password: "private",
	})
		.render(200)
		.join("\n");
	assert.match(rendered, /MCP github-mcp/);
	assert.match(rendered, /hello/);
	const gateway = renderMcpToolCall(
		{ server: "github-mcp", tool: "create_issue", args: '{"title":"hello","password":"private"}' },
		activeTheme,
		source,
	)
		.render(200)
		.join("\n");
	assert.match(gateway, /hello/);
	assert.doesNotMatch(gateway, /private/);
	assert.doesNotMatch(rendered, /private/);
});

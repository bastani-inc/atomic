import assert from "node:assert/strict";
import { test } from "vitest";
import { inheritChildSessionOptions } from "../src/core/child-session-options.ts";

const available = ["read", "read_extra", "bash", "subagent", "mcp__docs__search", "read_mcp_resource"];

test("a wildcard parent ceiling admits an exact child tool without widening native MCP access", () => {
	const inherited = inheritChildSessionOptions(
		{ cwd: "/tmp/project", tools: ["re*", "subagent"] },
		{ tools: ["read", "bash", "read_mcp_resource"] },
		available,
	);
	assert.deepEqual(inherited.tools, ["read"]);
});

test("child patterns resolve against the parent ceiling instead of widening it", () => {
	const inherited = inheritChildSessionOptions(
		{ cwd: "/tmp/project", tools: ["read", "subagent", "mcp__docs__search"] },
		{ tools: ["*"] },
		available,
	);
	assert.deepEqual(inherited.tools, ["read", "subagent", "mcp__docs__search"]);
});

test("inherited wildcard tools resolve to available tools and retain exclusions", () => {
	const inherited = inheritChildSessionOptions(
		{ cwd: "/tmp/project", tools: ["re*", "subagent"], excludedTools: ["read_extra"] },
		{},
		available,
	);
	assert.deepEqual(inherited.tools, ["read", "read_extra", "subagent"]);
	assert.deepEqual(inherited.excludedTools, ["read_extra"]);
	assert.deepEqual(
		inheritChildSessionOptions({ cwd: "/tmp/project", noTools: "all", tools: ["*"] }, { tools: ["read"] }, available)
			.tools,
		[],
	);
});

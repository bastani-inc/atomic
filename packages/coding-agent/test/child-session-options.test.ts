import assert from "node:assert/strict";
import { test } from "vitest";
import { inheritChildSessionOptions } from "../src/core/child-session-options.ts";
import { SettingsManager } from "../src/core/settings-manager.js";

const available = ["read", "read_extra", "bash", "subagent", "mcp__docs__search", "read_mcp_resource"];

test("a wildcard parent ceiling admits an exact child tool without widening native MCP access", () => {
	const inherited = inheritChildSessionOptions(
		{ cwd: "/tmp/project", tools: ["re*", "subagent"] },
		{ tools: ["read", "bash", "read_mcp_resource"] },
		available,
	);
	assert.deepEqual(inherited.tools, ["read"]);
});

test("an MCP-scoped parent pattern admits only the exact MCP tool a child requests", () => {
	const withMcp = [...available, "mcp__docs__delete", "mcp__other__search"];
	assert.deepEqual(
		inheritChildSessionOptions(
			{ cwd: "/tmp/project", tools: ["read", "mcp__docs__*"] },
			{ tools: ["mcp__docs__search"] },
			withMcp,
		).tools,
		["mcp__docs__search"],
	);
	assert.deepEqual(
		inheritChildSessionOptions(
			{ cwd: "/tmp/project", tools: ["read", "mcp__docs__*"] },
			{ tools: ["mcp__other__search", "read_mcp_resource"] },
			withMcp,
		).tools,
		[],
	);
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

test("child modifiers resolve default tools before intersecting the parent ceiling", () => {
	assert.deepEqual(
		inheritChildSessionOptions(
			{ cwd: "/tmp/project", tools: ["read", "bash", "subagent"] },
			{ tools: ["-bash"] },
			available,
		).tools,
		["read", "subagent"],
	);
	assert.deepEqual(
		inheritChildSessionOptions(
			{ cwd: "/tmp/project", tools: ["read", "read_extra", "mcp__docs__search"] },
			{ tools: ["+read_extra", "+bash", "+mcp__docs__search", "-read"] },
			available,
		).tools,
		["read_extra", "mcp__docs__search"],
	);
});

test("child modifiers cannot override total tool suppression", () => {
	assert.deepEqual(
		inheritChildSessionOptions(
			{ cwd: "/tmp/project", tools: ["read", "bash"], noTools: "all" },
			{ tools: ["+read"] },
			available,
		).tools,
		[],
	);
});

test("child modifiers use inherited settings or child settings without widening the ceiling", () => {
	const parent = {
		cwd: "/tmp/project",
		tools: ["read", "bash", "subagent", "read_extra"],
		settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "bash"] }),
	};
	assert.deepEqual(inheritChildSessionOptions(parent, { tools: ["-bash"] }, available).tools, [
		"read",
		"read_extra",
		"subagent",
	]);
	assert.deepEqual(
		inheritChildSessionOptions(
			parent,
			{
				tools: ["-read", "+read_extra"],
				settingsManager: SettingsManager.inMemory({ defaultTools: ["read", "subagent"] }),
			},
			available,
		).tools,
		["read_extra", "subagent"],
	);
});

test("child tool modifier validation survives parent intersection", () => {
	for (const tools of [["read", "-bash"], ["+re*"]]) {
		assert.throws(
			() => inheritChildSessionOptions({ cwd: "/tmp/project", tools: ["read"] }, { tools }, available),
			/Invalid tools option/,
		);
	}
});

import assert from "node:assert/strict";
import { join } from "node:path";
import { test, vi } from "vitest";
import { McpServerRegistry } from "../../packages/coding-agent/src/core/extensions/mcp-server-registry.js";
import { loadMcpConfig, validateMcpConfig } from "../../packages/mcp/config.js";
import { resolveDirectTools } from "../../packages/mcp/direct-tools.js";
import { computeServerHash, type MetadataCache, reconstructToolMetadata } from "../../packages/mcp/metadata-cache.js";
import { buildToolMetadata, findToolByName } from "../../packages/mcp/tool-metadata.js";
import { assignToolNames } from "../../packages/mcp/tool-names.js";
import { isToolExcluded, type McpConfig } from "../../packages/mcp/types.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

for (const reverse of [false, true])
	test(`routes dashed and underscored tool names consistently, reverse=${reverse} (#10239)`, () => {
		const tools = [
			{ name: "read-file", description: "dashed" },
			{ name: "read_file", description: "underscored" },
		];
		if (reverse) tools.reverse();
		const config: McpConfig = { mcpServers: { "my-server": { command: "fixture", directTools: true } } };
		const definition = config.mcpServers["my-server"]!;
		const cache: MetadataCache = {
			version: 1,
			servers: {
				"my-server": { tools, resources: [], cachedAt: Date.now(), configHash: computeServerHash(definition) },
			},
		};
		const live = buildToolMetadata(tools, [], definition, "my-server", "server").metadata;
		const cached = reconstructToolMetadata("my-server", cache.servers["my-server"]!, "server", definition);
		assert.deepEqual(live, cached);
		const direct = resolveDirectTools(config, cache, "server");
		assert.deepEqual(
			direct.map((spec) => [spec.prefixedName, spec.originalName]),
			live.map((tool) => [tool.name, tool.originalName]),
		);
		for (const tool of live) {
			assert.match(tool.name, /^my_server_read_file_[a-f0-9]{8}$/);
			assert.equal(findToolByName(live, tool.name)?.originalName, tool.originalName);
		}
		assert.equal(findToolByName(live, "my_server_read_file"), undefined);
		const forward = assignToolNames(["read-file", "read_file"], "my-server", "server");
		assert.equal(live.find((tool) => tool.originalName === "read-file")?.name, forward.get("read-file"));
	});

test("creates bounded JavaScript-safe MCP tool identifiers (#10239)", () => {
	const names = assignToolNames(["get.item/v2", "x".repeat(100), "9tool"], "my-server", "none");
	assert.equal(names.get("get.item/v2"), "get_item_v2");
	assert.equal(names.get("9tool"), "_9tool");
	assert.equal(names.get("x".repeat(100))?.length, 64);
});

test("rejects normalized server collisions and lets config override contributed aliases (#10239)", async () => {
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	const root = makeTempDirectory("mcp-identifiers-");
	try {
		const config = validateMcpConfig({
			mcpServers: { "work-files": { command: "a" }, work_files: { command: "b" } },
		});
		assert.deepEqual(Object.keys(config.mcpServers), ["work-files"]);
		assert.ok(
			warn.mock.calls.some(([message]) => String(message).includes('"work_files" conflicts with "work-files"')),
		);
		const registry = new McpServerRegistry();
		const sourceInfo = { path: "/fixture.ts", source: "fixture", scope: "user", origin: "top-level" } as const;
		registry.register({ name: "work-files", config: { command: "a" }, origin: "extension", sourceInfo });
		assert.throws(
			() => registry.register({ name: "work_files", config: { command: "b" }, origin: "extension", sourceInfo }),
			/conflicts with registered server/,
		);
		const path = join(root, "mcp.json");
		await writeFileEnsuringDir(path, JSON.stringify({ mcpServers: { work_files: { command: "override" } } }));
		const merged = loadMcpConfig(path, root, registry.list());
		assert.equal(merged.mcpServers["work-files"], undefined);
		assert.equal(merged.mcpServers.work_files?.command, "override");
	} finally {
		warn.mockRestore();
		removeTempDirectory(root);
	}
});

test("MCP name assignment retains malformed metadata guards (#10239)", () => {
	const tools = [{ name: "valid" }, null] as never;
	const resources = [{ uri: "missing-name" }, null] as never;
	const live = buildToolMetadata(tools, resources, {}, "docs", "server");
	assert.deepEqual(live.failedTools, ["(unnamed)"]);
	assert.deepEqual(
		live.metadata.map((tool) => tool.name),
		["docs_valid"],
	);
	const cached = reconstructToolMetadata(
		"docs",
		{ configHash: "", cachedAt: Date.now(), tools, resources },
		"server",
		{},
	);
	assert.deepEqual(
		cached.map((tool) => tool.name),
		["docs_valid"],
	);
});

test("existing exclusions keep matching tools whose names contain punctuation (#10239)", () => {
	for (const excluded of ["my_server_get.item", "my_server_get_item", "get.item", "my-server_get.item"]) {
		assert.equal(isToolExcluded("get.item", "my-server", "server", [excluded]), true, excluded);
	}
	assert.equal(isToolExcluded("get.item", "my-server", "server", ["my_server_get_other"]), false);
	const metadata = buildToolMetadata(
		[{ name: "get.item", description: "punctuated" }],
		[],
		{ command: "fixture", excludeTools: ["my_server_get.item"] },
		"my-server",
		"server",
	).metadata;
	assert.deepEqual(metadata, []);
});

test("excluding a punctuated raw tool name keeps a distinct underscored tool (#10239)", () => {
	assert.equal(isToolExcluded("get_item", "my-server", "server", ["get.item"]), false);
	assert.equal(isToolExcluded("get.item", "my-server", "server", ["get.item"]), true);
	const metadata = buildToolMetadata(
		[
			{ name: "get.item", description: "punctuated" },
			{ name: "get_item", description: "underscored" },
		],
		[],
		{ command: "fixture", excludeTools: ["get.item"] },
		"my-server",
		"server",
	).metadata;
	assert.deepEqual(
		metadata.map((tool) => tool.originalName),
		["get_item"],
	);
});

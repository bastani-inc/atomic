import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveMcpDirectToolNames } from "../../packages/subagents/src/runs/shared/mcp-direct-tool-allowlist.js";

test("resolves native child selections from live tool identities", () => {
	const liveTools = [
		{ name: "mcp__github__search_code", server: "github", tool: "search_code" },
		{ name: "mcp__github__delete_repo", server: "github", tool: "delete_repo" },
		{ name: "mcp__chrome_devtools__click", server: "chrome-devtools", tool: "click" },
	];
	assert.deepEqual(resolveMcpDirectToolNames(["github/search_code", "chrome-devtools"], liveTools), [
		"mcp__github__search_code",
		"mcp__chrome_devtools__click",
	]);
	assert.deepEqual(resolveMcpDirectToolNames([], liveTools), []);
	assert.deepEqual(resolveMcpDirectToolNames(undefined, liveTools), []);
});

test("native selections preserve assigned collision names without matching a sanitized sibling", () => {
	const liveTools = [
		{ name: "mcp__demo__read_file_a73b5840", server: "demo", tool: "read-file" },
		{ name: "mcp__demo__read_file_e9e5a243", server: "demo", tool: "read_file" },
		{ name: "mcp__demo__read_file_a73b5840", server: "demo", tool: "read-file" },
	];
	assert.deepEqual(resolveMcpDirectToolNames(["demo/read-file", "missing"], liveTools), [
		"mcp__demo__read_file_a73b5840",
	]);
	assert.deepEqual(resolveMcpDirectToolNames(["demo/"], liveTools), [
		"mcp__demo__read_file_a73b5840",
		"mcp__demo__read_file_e9e5a243",
	]);
});

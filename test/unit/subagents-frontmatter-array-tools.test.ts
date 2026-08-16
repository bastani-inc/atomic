/**
 * Pi 0.84.2 parity audit (upstream d268454e, "accept array-form `tools` in
 * the subagent example", #7598): agent frontmatter must accept YAML
 * array-form `tools` — flow (`tools: [read, bash]`) and block sequences —
 * as well as the comma-separated string, and both spellings must produce
 * the same tool set.
 *
 * Atomic's `@bastani/subagents` parses frontmatter with a line-based reader
 * rather than a YAML library, so before this fix a flow form arrived as the
 * literal string `"[read, bash]"` and comma-split into garbage tool names
 * (`["[read", "bash]"]`) that reached the child as a bogus allowlist. The
 * parser now yields sequences as arrays and the loader normalizes either
 * spelling; scalar fields narrow to strings, so a sequence where a scalar
 * belongs is ignored rather than stringified (upstream's own `typeof`
 * narrowing).
 *
 * These tests run the real `loadAgentsFromDir` against agent files on disk.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import { loadAgentsFromDir } from "../../packages/subagents/src/agents/agent-loaders.ts";
import { parseFrontmatter } from "../../packages/subagents/src/agents/frontmatter.ts";

const roots: string[] = [];

function writeAgents(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-frontmatter-"));
	roots.push(dir);
	for (const [fileName, content] of Object.entries(files)) {
		writeFileSync(join(dir, fileName), content, "utf-8");
	}
	return dir;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function agentFile(frontmatterTools: string, extra = ""): string {
	return `---\nname: probe\ndescription: probe agent\n${frontmatterTools}${extra}---\n\nDo the thing.\n`;
}

describe("array-form tools frontmatter parity", () => {
	test("flow, block, and comma-separated tools produce the same tool set", () => {
		const dir = writeAgents({
			"comma.md": agentFile("tools: read, bash\n"),
			"flow.md": agentFile("tools: [read, bash]\n"),
			"block.md": agentFile("tools:\n  - read\n  - bash\n"),
		});

		const agents = loadAgentsFromDir(dir, "user");
		assert.equal(agents.length, 3);

		const toolSets = agents.map((agent) => agent.tools);
		for (const tools of toolSets) {
			assert.deepEqual(tools, ["read", "bash"]);
		}
		// No spelling splits out MCP direct tools when none are declared.
		assert.deepEqual(
			agents.map((agent) => agent.mcpDirectTools),
			[undefined, undefined, undefined],
		);
	});

	test("array-form tools split mcp: entries exactly like the comma form", () => {
		const dir = writeAgents({
			"comma.md": agentFile("tools: read, mcp:chrome-devtools\n"),
			"flow.md": agentFile("tools: [read, mcp:chrome-devtools]\n"),
			"block.md": agentFile("tools:\n  - read\n  - mcp:chrome-devtools\n"),
		});

		for (const agent of loadAgentsFromDir(dir, "user")) {
			assert.deepEqual(agent.tools, ["read"]);
			assert.deepEqual(agent.mcpDirectTools, ["chrome-devtools"]);
		}
	});

	test("an empty flow sequence means no tool narrowing, like an omitted or empty list", () => {
		const dir = writeAgents({
			"empty-flow.md": agentFile("tools: []\n"),
			"empty-comma.md": agentFile("tools:\n"),
		});

		for (const agent of loadAgentsFromDir(dir, "user")) {
			assert.equal(agent.tools, undefined);
			assert.equal(agent.mcpDirectTools, undefined);
		}
	});

	test("quoted flow items lose their quotes like quoted scalars do", () => {
		const dir = writeAgents({
			"quoted.md": agentFile("tools: [\"read\", 'bash']\n"),
		});

		const [agent] = loadAgentsFromDir(dir, "user");
		assert.deepEqual(agent?.tools, ["read", "bash"]);
	});

	test("a sequence where a scalar belongs is ignored, never stringified", () => {
		const dir = writeAgents({
			"array-model.md": agentFile("", "model: [anthropic/claude-fable-5]\n"),
		});

		const [agent] = loadAgentsFromDir(dir, "user");
		assert.equal(agent?.model, undefined);
	});

	test("a file whose name is a sequence is skipped whole", () => {
		const dir = writeAgents({
			"bad-name.md": agentFile("", "").replace("name: probe\n", "name:\n  - probe\n"),
			"good.md": agentFile("tools: read\n"),
		});

		const agents = loadAgentsFromDir(dir, "user");
		assert.deepEqual(
			agents.map((agent) => agent.name),
			["probe"],
		);
	});

	test("parseFrontmatter keeps scalar fields as strings alongside sequences", () => {
		const { frontmatter, body } = parseFrontmatter(
			["---", "name: custom", "tools: [read, bash]", "model: provider:with-colon/model:off", "---", "body"].join(
				"\n",
			),
		);

		assert.equal(frontmatter.name, "custom");
		assert.deepEqual(frontmatter.tools, ["read", "bash"]);
		// A scalar keeps every later colon; only the first splits key from value.
		assert.equal(frontmatter.model, "provider:with-colon/model:off");
		assert.equal(body, "body");
	});
});

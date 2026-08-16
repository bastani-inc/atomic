/**
 * Pi 0.84.2 parity audit (upstream d268454e, "accept array-form `tools` in
 * the subagent example", #7598): agent frontmatter must accept YAML
 * array-form `tools` — flow (`tools: [read, bash]`, single- or multi-line)
 * and block sequences (`tools:` followed by `- read` lines at any
 * indentation) — as well as the comma-separated string, and every spelling
 * must produce the same tool set.
 *
 * Upstream's fix parses agent frontmatter with a real YAML library. Atomic's
 * first cut hand-rolled a partial sequence reader, which produced garbage
 * for legal YAML it did not model: a multi-line flow sequence parsed to the
 * one-element allowlist `["["]` that reached the child, and a zero-indent
 * block sequence was dropped entirely. Frontmatter now delegates to the
 * yaml-backed `parseFrontmatter` exported by `@bastani/atomic`, so every
 * legal YAML spelling parses identically.
 *
 * The real parser also yields true booleans and numbers for the unquoted
 * spellings `serializeAgent` itself writes (`interactive: true`,
 * `maxSubagentDepth: 3`); the loader accepts those alongside the legacy
 * quoted strings, an invalid-YAML file reads as no frontmatter so one bad
 * file cannot take down the rest of the directory, and sequence-valued
 * custom fields survive an agent update by round-tripping through
 * `serializeAgent` as flow sequences.
 *
 * These tests run the real `loadAgentsFromDir` against agent files on disk.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import { loadAgentsFromDir } from "../../packages/subagents/src/agents/agent-loaders.ts";
import { serializeAgent } from "../../packages/subagents/src/agents/agent-serializer.ts";
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
	test("every legal YAML array spelling produces the same tool set as the comma form", () => {
		const dir = writeAgents({
			"comma.md": agentFile("tools: read, bash\n"),
			"flow.md": agentFile("tools: [read, bash]\n"),
			// A multi-line flow sequence parsed to the garbage one-element
			// allowlist ["["] under the hand-rolled reader.
			"multiline-flow.md": agentFile("tools: [\n  read,\n  bash\n]\n"),
			// A zero-indent block sequence was dropped entirely (tools read as
			// undefined) because the reader required indented items.
			"zero-indent-block.md": agentFile("tools:\n- read\n- bash\n"),
			"indented-block.md": agentFile("tools:\n  - read\n  - bash\n"),
		});

		const agents = loadAgentsFromDir(dir, "user");
		assert.equal(agents.length, 5);

		const toolSets = agents.map((agent) => agent.tools);
		for (const tools of toolSets) {
			assert.deepEqual(tools, ["read", "bash"]);
		}
		// No spelling splits out MCP direct tools when none are declared.
		assert.deepEqual(
			agents.map((agent) => agent.mcpDirectTools),
			[undefined, undefined, undefined, undefined, undefined],
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

	test("unquoted YAML booleans and numbers load, matching serializeAgent's own spellings", () => {
		const dir = writeAgents({
			"scalar-types.md": agentFile(
				"",
				"interactive: true\ninheritProjectContext: false\ninheritSkills: true\ndefaultProgress: true\nmaxSubagentDepth: 3\n",
			),
		});

		const [agent] = loadAgentsFromDir(dir, "user");
		assert.equal(agent?.interactive, true);
		assert.equal(agent?.inheritProjectContext, false);
		assert.equal(agent?.inheritSkills, true);
		assert.equal(agent?.defaultProgress, true);
		assert.equal(agent?.maxSubagentDepth, 3);
	});

	test("quoted boolean and number strings from the line-reader era stay accepted", () => {
		const dir = writeAgents({
			"legacy-strings.md": agentFile(
				"",
				'interactive: "true"\ninheritProjectContext: "false"\nmaxSubagentDepth: "2"\n',
			),
		});

		const [agent] = loadAgentsFromDir(dir, "user");
		assert.equal(agent?.interactive, true);
		assert.equal(agent?.inheritProjectContext, false);
		assert.equal(agent?.maxSubagentDepth, 2);
	});

	test("one file with invalid YAML frontmatter does not take down the directory", () => {
		const dir = writeAgents({
			// A colon-space inside a plain scalar is invalid YAML; the real
			// parser throws, and the file must read as frontmatter-less
			// rather than killing the scan that loads its neighbors.
			"bad-yaml.md": "---\nname: bad\ndescription: Deploy: fast\ntools: read\n---\n\nbody\n",
			"good.md": agentFile("tools: read\n"),
		});

		const agents = loadAgentsFromDir(dir, "user");
		assert.deepEqual(
			agents.map((agent) => agent.name),
			["probe"],
		);
	});

	test("a sequence-valued custom field survives an agent update round-trip", () => {
		const dir = writeAgents({
			"custom.md": agentFile("", "custom: [a, b]\n"),
		});

		const [loaded] = loadAgentsFromDir(dir, "user");
		assert.deepEqual(loaded?.extraFields?.custom, ["a", "b"]);

		// agent-management rewrites the file from the loaded config via
		// serializeAgent, which renders extra fields through the yaml
		// emitter as block collections; the sequence must come back out,
		// not be deleted.
		const rewritten = serializeAgent(loaded!);
		assert.match(rewritten, /^custom:\n {2}- a\n {2}- b$/m);

		const roundTripDir = writeAgents({ "custom.md": rewritten });
		const [reloaded] = loadAgentsFromDir(roundTripDir, "user");
		assert.deepEqual(reloaded?.extraFields?.custom, ["a", "b"]);
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

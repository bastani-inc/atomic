/**
 * Review repair for the L16 serializer: `serializeExtraFieldValue` used to
 * hand-join sequence values into unquoted flow sequences, which corrupts
 * any item the YAML grammar cannot hold bare. The destructive case:
 * `custom: ["a #b", c]` serialized to `custom: [a #b, c]`, where `#` opens
 * a comment and leaves an unterminated flow sequence — the rewritten agent
 * file then fails YAML parse, so the agent silently disappears from every
 * later scan. Other shapes were lossy rather than destructive: `["a, b"]`
 * split into two items, `["[x]"]` and `["a: b"]` collapsed, `""` became
 * null, and the string `"true"` became a boolean.
 *
 * serializeAgent now renders extra fields through the yaml package's
 * `stringify`, which quotes exactly the scalars that need it. These tests
 * round-trip every probed shape through real files on disk — load, rewrite
 * the way agent-management does, then re-scan — and require the values to
 * come back identical and the agent to still be discoverable.
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, test } from "vitest";
import { loadAgentsFromDir } from "../../packages/subagents/src/agents/agent-loaders.ts";
import { serializeAgent } from "../../packages/subagents/src/agents/agent-serializer.ts";
import { type FrontmatterValue, parseFrontmatter } from "../../packages/subagents/src/agents/frontmatter.ts";

const roots: string[] = [];

function writeAgents(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "subagent-extra-fields-"));
	roots.push(dir);
	for (const [fileName, content] of Object.entries(files)) {
		writeFileSync(join(dir, fileName), content, "utf-8");
	}
	return dir;
}

afterAll(() => {
	for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function agentFile(customYaml: string): string {
	return `---\nname: probe\ndescription: probe agent\ntools: read\n${customYaml}---\n\nDo the thing.\n`;
}

const PROBED_SHAPES: Array<{ label: string; yaml: string; expected: FrontmatterValue }> = [
	// Destructive under the old emitter: the bare `#` opened a comment,
	// leaving an unterminated flow sequence that killed the whole file.
	{ label: "items containing a comment character", yaml: 'custom: ["a #b", c]\n', expected: ["a #b", "c"] },
	// Lossy under the old emitter: the comma split one item into two.
	{ label: "an item containing a comma", yaml: 'custom: ["a, b", c]\n', expected: ["a, b", "c"] },
	// Lossy: a bare `[x]` item parsed as a nested flow sequence and was
	// dropped by the string-only narrowing, collapsing the list to [].
	{ label: "an item that looks like a flow opener", yaml: 'custom: ["[x]"]\n', expected: ["[x]"] },
	// Lossy: a bare `a: b` item parsed as a nested mapping and was dropped.
	{ label: "an item containing a colon-space", yaml: 'custom: ["a: b"]\n', expected: ["a: b"] },
	// Type-changing: bare spellings re-parse as null / boolean, not strings.
	{ label: "the empty string", yaml: 'custom: ""\n', expected: "" },
	{ label: "the string true", yaml: 'custom: "true"\n', expected: "true" },
	// Typed scalars must keep their types, not stringify.
	{ label: "a number", yaml: "custom: 3\n", expected: 3 },
	{ label: "a boolean", yaml: "custom: true\n", expected: true },
	{ label: "a null", yaml: "custom: null\n", expected: null },
	// The empty sequence round-trips as itself.
	{ label: "an empty sequence", yaml: "custom: []\n", expected: [] },
];

describe("extra-field YAML round-trip safety", () => {
	for (const { label, yaml, expected } of PROBED_SHAPES) {
		test(`${label} survives load → serializeAgent → load with identical values`, () => {
			const dir = writeAgents({ "probe.md": agentFile(yaml) });

			const [loaded] = loadAgentsFromDir(dir, "user");
			assert.ok(loaded, "agent must load before the round-trip");
			assert.deepEqual(loaded.extraFields?.custom, expected);

			// agent-management overwrites the file in place with exactly
			// this call; the output must be parseable YAML, or the agent
			// vanishes from every later scan of the directory.
			const rewritten = serializeAgent(loaded);
			assert.equal(parseFrontmatter(rewritten).parseError, undefined);

			const roundTripDir = writeAgents({ "probe.md": rewritten });
			const [reloaded] = loadAgentsFromDir(roundTripDir, "user");
			assert.ok(reloaded, "agent must still be discoverable after the rewrite");
			assert.equal(reloaded.name, "probe");
			assert.deepEqual(reloaded.extraFields?.custom, expected);
		});
	}

	test("the comment-character shape rewrites to quoted YAML, not an unterminated flow sequence", () => {
		const dir = writeAgents({ "probe.md": agentFile('custom: ["a #b", c]\n') });
		const [loaded] = loadAgentsFromDir(dir, "user");

		const rewritten = serializeAgent(loaded!);
		// The old emitter produced `custom: [a #b, c]` here. Every item the
		// grammar cannot hold bare must arrive quoted.
		assert.doesNotMatch(rewritten, /^custom: \[a #b, c\]$/m);
		assert.match(rewritten, /"a #b"/);
	});
});

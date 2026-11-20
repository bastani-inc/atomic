/**
 * #5991 acceptance: a subagent definition a package ships through its `agents` manifest field runs, when a codemode
 * script launches it, with every setting the package pinned: its model, its fallback chain at the thinking level each
 * entry pins, and its `tools:` allowlist, including the `mcp:<server>` entry. The fixture agent is
 * `test/fixtures/package-agents/review-kit/agents/reviewer.md`; `package-agents-fixture.ts` documents the profile.
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { afterEach, test } from "vitest";
import {
	createPackageAgentProfile,
	MCP_LOOKUP_TEXT,
	PACKAGE_AGENT,
	PACKAGE_AGENT_ROLE,
	type PackageAgentProfile,
	PRIMARY_MODEL,
	type Reply,
	SECONDARY_MODEL,
	SELECTED_MCP_SERVER,
	SELECTED_MCP_TOOL,
	STRAY_MCP_TOOL,
	TERTIARY_MODEL,
	UNAVAILABLE,
} from "./package-agents-fixture.js";

/** Each case opens a real SDK session that loads the shipped subagents and MCP packages, and real child sessions. */
const PACKAGE_AGENT_SESSION_TIMEOUT_MS = 120_000;

let profile: PackageAgentProfile | undefined;

afterEach(async () => {
	await profile?.cleanup();
	profile = undefined;
});

/** A profile whose global settings install the fixture package, as `atomic install <path>` does. */
async function installedProfile(): Promise<PackageAgentProfile> {
	profile = await createPackageAgentProfile();
	profile.writeGlobalSettings({ packages: [profile.packageDir] });
	return profile;
}

test(
	"a package agent launched from codemode runs its pinned model at its pinned thinking level (#5991)",
	async () => {
		const p = await installedProfile();
		p.respondAsChild = () => ({ text: "REVIEW VERDICT: approved on the pinned model" });
		const session = await p.openSession();

		const outcome = await p.launch(session, PACKAGE_AGENT);

		assert.equal(outcome.refused, undefined, `the package agent is launchable: ${outcome.refused}`);
		assert.equal(outcome.status, "completed");
		assert.equal(outcome.output, "REVIEW VERDICT: approved on the pinned model");
		const children = p.childRequests();
		assert.deepEqual(
			children.map((request) => `${request.model}:${request.reasoning}`),
			[`${PRIMARY_MODEL}:high`],
			"only the agent's pinned model, at its pinned level",
		);
		assert.match(children[0]!.systemPrompt, new RegExp(PACKAGE_AGENT_ROLE), "the package agent's own prompt");
		assert.match(children[0]!.task, /Review the change/);
	},
	PACKAGE_AGENT_SESSION_TIMEOUT_MS,
);

test(
	"a package agent whose pinned model fails falls back through its chain at each entry's pinned thinking level (#5991)",
	async () => {
		const p = await installedProfile();
		p.respondAsChild = (request) =>
			request.model === TERTIARY_MODEL
				? { text: "REVIEW VERDICT: approved on the last fallback" }
				: { error: UNAVAILABLE };
		const session = await p.openSession();

		const outcome = await p.launch(session, PACKAGE_AGENT);

		assert.equal(outcome.refused, undefined, `the package agent is launchable: ${outcome.refused}`);
		assert.equal(outcome.status, "completed");
		assert.equal(outcome.output, "REVIEW VERDICT: approved on the last fallback");
		const children = p.childRequests();
		assert.deepEqual(
			children.map((request) => `${request.model}:${request.reasoning}`),
			[`${PRIMARY_MODEL}:high`, `${SECONDARY_MODEL}:low`, `${TERTIARY_MODEL}:minimal`],
			"the pinned model, then each fallback in order at the level the package pinned for it; never the parent's model",
		);
		for (const request of children) assert.match(request.systemPrompt, new RegExp(PACKAGE_AGENT_ROLE));
	},
	PACKAGE_AGENT_SESSION_TIMEOUT_MS,
);

test(
	"a package agent's tools allowlist is enforced, and its mcp:<server> entry reaches that server's tools (#5991)",
	async () => {
		const p = await installedProfile();
		// The child calls the selected MCP tool, a tool of the server its allowlist leaves out, and bash, all at once.
		const toolTurn: Reply = {
			calls: [
				{ name: SELECTED_MCP_TOOL, arguments: {} },
				{ name: STRAY_MCP_TOOL, arguments: {} },
				{ name: "bash", arguments: { command: `echo ran > "${p.bashMarker}"` } },
			],
		};
		p.respondAsChild = (request) =>
			request.toolResults.length === 0 ? toolTurn : { text: "REVIEW VERDICT: done with the kit's tools" };
		const session = await p.openSession();

		const outcome = await p.launch(session, PACKAGE_AGENT);

		assert.equal(outcome.refused, undefined, `the package agent is launchable: ${outcome.refused}`);
		assert.equal(outcome.status, "completed");
		// The parent's model is offered both MCP servers' tools and bash: only the package agent's allowlist narrows them.
		const parentTools = p.parentRequests()[0]!.tools;
		for (const name of [SELECTED_MCP_TOOL, STRAY_MCP_TOOL, "bash", "read"])
			assert.ok(parentTools.includes(name), `the parent offers ${name}: ${parentTools.join(", ")}`);
		const children = p.childRequests();
		assert.equal(children.length, 2, "a tool turn, then the answer");
		for (const request of children)
			assert.deepEqual(
				[...request.tools].sort(),
				[SELECTED_MCP_TOOL, "read"].sort(),
				"exactly the allowlist: read, and the selected MCP server's tool",
			);
		const results = new Map(children[1]!.toolResults.map((result) => [result.name, result]));
		assert.deepEqual(results.get(SELECTED_MCP_TOOL), {
			name: SELECTED_MCP_TOOL,
			text: MCP_LOOKUP_TEXT,
			isError: false,
		});
		assert.equal(results.get(STRAY_MCP_TOOL)?.isError, true, "a server outside the allowlist is unavailable");
		assert.equal(results.get("bash")?.isError, true, "a builtin tool outside the allowlist is unavailable");
		assert.deepEqual(p.mcpCalls, [`${SELECTED_MCP_SERVER}/lookup`], "only the selected server was called");
		assert.equal(existsSync(p.bashMarker), false, "bash never ran");
	},
	PACKAGE_AGENT_SESSION_TIMEOUT_MS,
);

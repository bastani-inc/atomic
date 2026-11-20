/**
 * #5991 acceptance: where a package's `agents` show up and where they do not. A package agent is listed and described
 * under `<package namespace>.<name>` with the package it came from, follows install, uninstall and `/reload`, yields to
 * a user agent of the same full name, is withheld from an untrusted project, and cannot be changed through the
 * subagent tool's management actions. The fixture agent is `test/fixtures/package-agents/review-kit/agents/reviewer.md`;
 * `package-agents-fixture.ts` documents the profile.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
	createPackageAgentProfile,
	type ListedAgent,
	PACKAGE_AGENT,
	PACKAGE_NAMESPACE,
	type PackageAgentProfile,
	PRIMARY_MODEL,
	USER_MODEL,
} from "./package-agents-fixture.js";

/** Each case opens real SDK sessions that load the shipped subagents and MCP packages, and reloads them. */
const PACKAGE_AGENT_SESSION_TIMEOUT_MS = 120_000;

let profile: PackageAgentProfile | undefined;

afterEach(async () => {
	await profile?.cleanup();
	profile = undefined;
});

function named(agents: readonly ListedAgent[], name: string): ListedAgent[] {
	return agents.filter((agent) => agent.name === name);
}

function packageAgentOf(agents: readonly ListedAgent[], name = PACKAGE_AGENT): ListedAgent {
	const matches = named(agents, name);
	assert.equal(matches.length, 1, `${name} is listed once: ${JSON.stringify(agents.map((agent) => agent.name))}`);
	return matches[0]!;
}

test(
	"a package's agent is listed and described as <namespace>.<name> with the package it came from (#5991)",
	async () => {
		profile = await createPackageAgentProfile();
		const p = profile;
		p.writeGlobalSettings({ packages: [p.packageDir] });
		const session = await p.openSession();

		const listed = packageAgentOf(await p.listAgents(session));
		assert.equal(listed.scope, "package");
		assert.match(listed.package ?? "", /review-kit/, "the list names the source package");
		assert.equal(listed.description, "Reviews a change with the kit's pinned models and tools");
		assert.equal(listed.model, `${PRIMARY_MODEL}:high`);
		assert.equal(
			named(await p.listAgents(session), "reviewer").length,
			0,
			"never under its bare name, where it could collide with a user or project agent",
		);

		const list = await p.callSubagent(session, { action: "list" });
		assert.equal(list.isError, false, list.text);
		const line = list.text.split("\n").find((entry) => entry.startsWith(`- ${PACKAGE_AGENT} `));
		assert.match(line ?? "", /\(package [^)]*review-kit[^)]*\)/, list.text);

		const got = await p.callSubagent(session, { action: "get", agent: PACKAGE_AGENT });
		assert.equal(got.isError, false, got.text);
		assert.match(got.text, new RegExp(`^Agent: ${PACKAGE_AGENT.replaceAll(".", "\\.")} \\(package\\)`, "m"));
		assert.match(got.text, /^Local name: reviewer$/m);
		assert.match(got.text, new RegExp(`^Package: ${PACKAGE_NAMESPACE.replaceAll(".", "\\.")}$`, "m"));
		assert.match(got.text, /^Package source: .*review-kit/m);
		assert.match(got.text, /^Model: kit-primary\/argon:high$/m);
		assert.match(got.text, /^Fallback models: kit-secondary\/boron:low, kit-tertiary\/carbon:minimal$/m);
		assert.match(got.text, /^Tools: read, mcp:kitdocs$/m);
	},
	PACKAGE_AGENT_SESSION_TIMEOUT_MS,
);

test(
	"/reload offers the agent of a package installed after the session started (#5991)",
	async () => {
		profile = await createPackageAgentProfile();
		const p = profile;
		const session = await p.openSession();
		assert.deepEqual(named(await p.listAgents(session), PACKAGE_AGENT), [], "not offered before the install");

		await p.packageManager(session).installAndPersist(p.packageDir);
		await session.reload();

		assert.equal(packageAgentOf(await p.listAgents(session)).scope, "package");
	},
	PACKAGE_AGENT_SESSION_TIMEOUT_MS,
);

test(
	"uninstalling the package removes its agent from the list and from launch (#5991)",
	async () => {
		profile = await createPackageAgentProfile();
		const p = profile;
		const session = await p.openSession();
		const packages = p.packageManager(session);
		await packages.installAndPersist(p.packageDir);
		await session.reload();
		assert.equal(packageAgentOf(await p.listAgents(session)).scope, "package", "offered while installed");

		assert.equal(await packages.removeAndPersist(p.packageDir), true);
		await session.reload();

		assert.deepEqual(named(await p.listAgents(session), PACKAGE_AGENT), [], "gone after uninstall");
		const outcome = await p.launch(session, PACKAGE_AGENT);
		assert.match(outcome.refused ?? "", new RegExp(PACKAGE_AGENT.replaceAll(".", "\\.")), JSON.stringify(outcome));
		assert.deepEqual(p.childRequests(), [], "no child ran");
		assert.equal(
			existsSync(join(p.packageDir, "agents", "reviewer.md")),
			true,
			"uninstall leaves the package itself",
		);
	},
	PACKAGE_AGENT_SESSION_TIMEOUT_MS,
);

test(
	"a user agent with the package agent's full name overrides it (#5991)",
	async () => {
		profile = await createPackageAgentProfile();
		const p = profile;
		p.writeGlobalSettings({ packages: [p.packageDir] });
		const session = await p.openSession();
		assert.equal(
			packageAgentOf(await p.listAgents(session)).scope,
			"package",
			"the package agent before the override",
		);

		p.writeUserAgent(
			"my-reviewer.md",
			[
				"---",
				"name: reviewer",
				`package: ${PACKAGE_NAMESPACE}`,
				"description: My own reviewer",
				`model: ${USER_MODEL}:medium`,
				"tools: read",
				"---",
				"USER OVERRIDE ROLE",
			].join("\n"),
		);
		await session.reload();

		// The overridden package agent cannot run under its name any more, so `list` offers only the user's definition.
		assert.deepEqual(
			named(await p.listAgents(session), PACKAGE_AGENT).map((agent) => `${agent.scope}: ${agent.description}`),
			["user: My own reviewer"],
		);
		p.respondAsChild = () => ({ text: "user reviewer done" });
		const outcome = await p.launch(session, PACKAGE_AGENT);
		assert.equal(outcome.status, "completed", JSON.stringify(outcome));
		assert.deepEqual(
			p.childRequests().map((request) => `${request.model}:${request.reasoning}`),
			[`${USER_MODEL}:medium`],
			"the user agent's model, never the package's",
		);
		assert.match(p.childRequests()[0]!.systemPrompt, /USER OVERRIDE ROLE/);
	},
	PACKAGE_AGENT_SESSION_TIMEOUT_MS,
);

test(
	"an untrusted project's package agents are not offered, while a trusted one's and a global package's are (#5991)",
	async () => {
		profile = await createPackageAgentProfile();
		const p = profile;
		const globalKit = p.copyPackageAs("@acme/global-kit", "global-kit");
		const globalAgent = "acme.global-kit.reviewer";
		p.writeGlobalSettings({ packages: [globalKit] });
		p.writeProjectSettings({ packages: [p.packageDir] });

		const trusted = await p.openSession({ projectTrusted: true });
		const trustedAgents = await p.listAgents(trusted);
		assert.equal(packageAgentOf(trustedAgents).scope, "package", "a trusted project's package agent is offered");
		assert.equal(packageAgentOf(trustedAgents, globalAgent).scope, "package");

		const untrusted = await p.openSession({ projectTrusted: false });
		const untrustedAgents = await p.listAgents(untrusted);
		assert.deepEqual(named(untrustedAgents, PACKAGE_AGENT), [], "an untrusted project's package agent is withheld");
		assert.equal(packageAgentOf(untrustedAgents, globalAgent).scope, "package", "a global package's agent is not");
		const outcome = await p.launch(untrusted, PACKAGE_AGENT);
		assert.match(outcome.refused ?? "", new RegExp(PACKAGE_AGENT.replaceAll(".", "\\.")), JSON.stringify(outcome));

		// Trust withdrawn from a session that loaded the project's packages withholds their agents before any reload.
		trusted.settingsManager.setProjectTrusted(false);
		const withdrawnAgents = await p.listAgents(trusted);
		assert.deepEqual(named(withdrawnAgents, PACKAGE_AGENT), [], "withheld once the project is no longer trusted");
		assert.equal(packageAgentOf(withdrawnAgents, globalAgent).scope, "package");
		const withdrawn = await p.launch(trusted, PACKAGE_AGENT);
		assert.match(
			withdrawn.refused ?? "",
			new RegExp(PACKAGE_AGENT.replaceAll(".", "\\.")),
			JSON.stringify(withdrawn),
		);
		assert.deepEqual(p.childRequests(), [], "no child ran");
	},
	PACKAGE_AGENT_SESSION_TIMEOUT_MS,
);

test(
	"create, update and delete never modify a package agent (#5991)",
	async () => {
		profile = await createPackageAgentProfile();
		const p = profile;
		p.writeGlobalSettings({ packages: [p.packageDir] });
		const definition = join(p.packageDir, "agents", "reviewer.md");
		const original = readFileSync(definition, "utf8");
		const session = await p.openSession();
		assert.equal(packageAgentOf(await p.listAgents(session)).scope, "package");

		const updated = await p.callSubagent(session, {
			action: "update",
			agent: PACKAGE_AGENT,
			config: { description: "Hijacked", model: `${USER_MODEL}:high` },
		});
		assert.equal(updated.isError, true, updated.text);
		assert.match(updated.text, /provided by package .*review-kit.* cannot be modified/, updated.text);

		const deleted = await p.callSubagent(session, { action: "delete", agent: PACKAGE_AGENT });
		assert.equal(deleted.isError, true, deleted.text);
		assert.match(deleted.text, /provided by package .*review-kit.* cannot be modified/, deleted.text);

		const created = await p.callSubagent(session, {
			action: "create",
			config: { name: "reviewer", package: PACKAGE_NAMESPACE, description: "Shadow", scope: "user" },
		});
		assert.equal(created.isError, false, created.text);
		assert.match(created.text, new RegExp(`shadows the package agent '${PACKAGE_AGENT.replaceAll(".", "\\.")}'`));
		assert.equal(existsSync(join(p.agentDir, "agents", `${PACKAGE_AGENT}.md`)), true, "created in user scope");

		assert.equal(readFileSync(definition, "utf8"), original, "the package's definition is untouched");
		assert.equal(existsSync(definition), true);
	},
	PACKAGE_AGENT_SESSION_TIMEOUT_MS,
);

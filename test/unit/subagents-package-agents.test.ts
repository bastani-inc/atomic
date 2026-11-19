import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { DefaultPackageManager } from "../../packages/coding-agent/src/core/package-manager.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import { handleList, handleManagementAction } from "../../packages/subagents/src/agents/agent-management.js";
import {
	contextAgentDiscoveryOptions,
	discoverAgents,
	discoverAgentsAll,
} from "../../packages/subagents/src/agents/agents.js";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	ATOMIC_CODING_AGENT_DIR: process.env.ATOMIC_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
	ATOMIC_OFFLINE: process.env.ATOMIC_OFFLINE,
};
const roots: string[] = [];

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

function agentFile(fields: Record<string, string>, prompt = "Agent prompt."): string {
	return ["---", ...Object.entries(fields).map(([key, value]) => `${key}: ${value}`), "---", prompt].join("\n");
}

interface Fixture {
	root: string;
	project: string;
	agentDir: string;
	/** A package that ships two agents through `"atomic": { "agents": ["./agents"] }`. */
	reviewKit: string;
}

function makeFixture(): Fixture {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-package-agents-")));
	roots.push(root);
	const home = join(root, "home");
	const agentDir = join(home, ".atomic", "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	process.env.ATOMIC_OFFLINE = "1";
	delete process.env.PI_CODING_AGENT_DIR;
	const project = join(root, "project");
	mkdirSync(join(project, ".atomic"), { recursive: true });
	const reviewKit = join(root, "packages", "review-kit");
	write(
		join(reviewKit, "package.json"),
		JSON.stringify({ name: "@acme/review-kit", atomic: { agents: ["./agents"] } }),
	);
	write(
		join(reviewKit, "agents", "reviewer.md"),
		agentFile({
			name: "reviewer",
			description: "Reviews diffs",
			model: "acme-provider/strong-model:high",
			fallbackModels: "acme-provider/backup-model:low",
			tools: "read, mcp:docs",
		}),
	);
	write(
		join(reviewKit, "agents", "nested", "linter.md"),
		agentFile({ name: "linter", description: "Lints code", package: "someone-else" }),
	);
	return { root, project, agentDir, reviewKit };
}

function writeSettings(path: string, settings: object): void {
	write(path, JSON.stringify(settings));
}

async function loadResources(
	fixture: Fixture,
	options: { projectTrusted?: boolean; additionalExtensionPaths?: string[] } = {},
): Promise<DefaultResourceLoader> {
	const settingsManager = SettingsManager.create(fixture.project, fixture.agentDir, {
		projectTrusted: options.projectTrusted ?? true,
	});
	const loader = new DefaultResourceLoader({
		cwd: fixture.project,
		agentDir: fixture.agentDir,
		settingsManager,
		additionalExtensionPaths: options.additionalExtensionPaths,
		noExtensions: true,
	});
	await loader.reload();
	return loader;
}

function managementContext(fixture: Fixture, loader: DefaultResourceLoader, projectTrusted = true) {
	return {
		cwd: fixture.project,
		modelRegistry: { getAvailable: () => [] },
		isProjectTrusted: () => projectTrusted,
		getPackageAgents: () => loader.getPackageAgents(),
	} as unknown as Parameters<typeof handleList>[1];
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

describe("agents shipped by installed packages (#5991)", () => {
	test("a package's manifest agents are listed as <namespace>.<name> with the package they come from (#5991)", async () => {
		const fixture = makeFixture();
		writeSettings(join(fixture.agentDir, "settings.json"), { packages: [fixture.reviewKit] });
		const loader = await loadResources(fixture);
		const ctx = managementContext(fixture, loader);

		const listed = text(await handleList({ action: "list" }, ctx));
		assert.match(
			listed,
			new RegExp(`- acme\\.review-kit\\.reviewer \\(package ${escapeRegExp(fixture.reviewKit)}\\): Reviews diffs`),
		);
		// The installed package's namespace replaces an agent's own `package:` frontmatter.
		assert.match(listed, /- acme\.review-kit\.linter \(package /);
		assert.doesNotMatch(listed, /someone-else/);

		const { agents } = await discoverAgents(fixture.project, "both", contextAgentDiscoveryOptions(ctx));
		const reviewer = agents.find((agent) => agent.name === "acme.review-kit.reviewer");
		assert.ok(reviewer);
		assert.equal(reviewer.model, "acme-provider/strong-model:high");
		assert.deepEqual(reviewer.fallbackModels, ["acme-provider/backup-model:low"]);
		assert.deepEqual(reviewer.tools, ["read"]);
		assert.deepEqual(reviewer.mcpDirectTools, ["docs"]);

		const got = text(await handleManagementAction("get", { agent: "acme.review-kit.reviewer" }, ctx));
		assert.match(got, /^Agent: acme\.review-kit\.reviewer \(package\)$/m);
		assert.match(got, /^Local name: reviewer$/m);
		assert.match(got, /^Package: acme\.review-kit$/m);
		assert.match(got, new RegExp(`^Package source: ${escapeRegExp(fixture.reviewKit)} \\(global\\)$`, "m"));
	});

	test("update and delete refuse a package agent and leave its file alone (#5991)", async () => {
		const fixture = makeFixture();
		writeSettings(join(fixture.agentDir, "settings.json"), { packages: [fixture.reviewKit] });
		const ctx = managementContext(fixture, await loadResources(fixture));
		const refusal = `Agent 'acme.review-kit.reviewer' is provided by package ${fixture.reviewKit} and cannot be modified. Create an agent with the same full name in user or project scope to override it.`;

		for (const params of [
			{ agent: "acme.review-kit.reviewer", config: { description: "changed" } },
			{ agent: "acme.review-kit.reviewer", agentScope: "user", config: { description: "changed" } },
		]) {
			const updated = await handleManagementAction("update", params, ctx);
			assert.equal(updated.isError, true);
			assert.equal(text(updated), refusal);
		}
		const deleted = await handleManagementAction("delete", { agent: "acme.review-kit.reviewer" }, ctx);
		assert.equal(deleted.isError, true);
		assert.equal(text(deleted), refusal);
		const { agents } = await discoverAgents(fixture.project, "both", contextAgentDiscoveryOptions(ctx));
		assert.equal(agents.find((agent) => agent.name === "acme.review-kit.reviewer")?.description, "Reviews diffs");
	});

	test("a user agent with the same full name overrides the package agent (#5991)", async () => {
		const fixture = makeFixture();
		writeSettings(join(fixture.agentDir, "settings.json"), { packages: [fixture.reviewKit] });
		const ctx = managementContext(fixture, await loadResources(fixture));

		const created = await handleManagementAction(
			"create",
			{ config: { name: "reviewer", package: "acme.review-kit", description: "My reviewer", scope: "user" } },
			ctx,
		);
		assert.equal(created.isError, false, text(created));
		assert.match(
			text(created),
			new RegExp(
				`Note: this shadows the package agent 'acme\\.review-kit\\.reviewer' from ${escapeRegExp(fixture.reviewKit)}\\.`,
			),
		);

		const { agents } = await discoverAgents(fixture.project, "both", contextAgentDiscoveryOptions(ctx));
		const reviewers = agents.filter((agent) => agent.name === "acme.review-kit.reviewer");
		assert.equal(reviewers.length, 1);
		assert.equal(reviewers[0]!.source, "user");
		assert.equal(reviewers[0]!.description, "My reviewer");

		// The override is the user's own agent: update changes it, not the package's file.
		const updated = await handleManagementAction(
			"update",
			{ agent: "acme.review-kit.reviewer", config: { description: "Still mine" } },
			ctx,
		);
		assert.equal(updated.isError, false, text(updated));
		const all = await discoverAgentsAll(fixture.project, contextAgentDiscoveryOptions(ctx));
		assert.equal(all.user.find((agent) => agent.name === "acme.review-kit.reviewer")?.description, "Still mine");
		assert.equal(
			all.package.find((agent) => agent.name === "acme.review-kit.reviewer")?.description,
			"Reviews diffs",
		);
	});

	test("an untrusted project's package agents are not offered (#5991)", async () => {
		const fixture = makeFixture();
		writeSettings(join(fixture.project, ".atomic", "settings.json"), { packages: [fixture.reviewKit] });

		const trustedLoader = await loadResources(fixture, { projectTrusted: true });
		assert.deepEqual(
			trustedLoader.getPackageAgents().map((file) => file.scope),
			["project", "project"],
		);
		const untrustedLoader = await loadResources(fixture, { projectTrusted: false });
		assert.deepEqual(untrustedLoader.getPackageAgents(), []);
		const untrusted = managementContext(fixture, untrustedLoader, false);
		assert.doesNotMatch(text(await handleList({ action: "list" }, untrusted)), /acme\.review-kit/);

		// Discovery itself never offers a project-installed package's agent while the project is untrusted.
		const stale = managementContext(fixture, trustedLoader, false);
		const { agents } = await discoverAgents(fixture.project, "both", contextAgentDiscoveryOptions(stale));
		assert.equal(
			agents.some((agent) => agent.name.startsWith("acme.review-kit.")),
			false,
		);
		assert.doesNotMatch(text(await handleList({ action: "list" }, stale)), /acme\.review-kit/);
	});

	test("removing the package removes its agents on reload (#5991)", async () => {
		const fixture = makeFixture();
		const settingsPath = join(fixture.agentDir, "settings.json");
		writeSettings(settingsPath, { packages: [fixture.reviewKit] });
		const loader = await loadResources(fixture);
		const ctx = managementContext(fixture, loader);
		assert.match(text(await handleList({ action: "list" }, ctx)), /acme\.review-kit\.reviewer/);

		writeSettings(settingsPath, { packages: [] });
		await loader.reload();

		assert.doesNotMatch(text(await handleList({ action: "list" }, ctx)), /acme\.review-kit/);
		const got = await handleManagementAction("get", { agent: "acme.review-kit.reviewer" }, ctx);
		assert.equal(got.isError, true);
		assert.match(text(got), /^Agent 'acme\.review-kit\.reviewer' not found\./);
	});

	test("package filters select which agents a package offers, and -e packages are offered too (#5991)", async () => {
		const fixture = makeFixture();
		writeSettings(join(fixture.agentDir, "settings.json"), {
			packages: [{ source: fixture.reviewKit, agents: ["!agents/nested/**"] }],
		});
		const filtered = await loadResources(fixture);
		assert.deepEqual(
			filtered.getPackageAgents().map((file) => file.path),
			[join(fixture.reviewKit, "agents", "reviewer.md")],
		);

		writeSettings(join(fixture.agentDir, "settings.json"), {});
		const temporary = await loadResources(fixture, { additionalExtensionPaths: [fixture.reviewKit] });
		assert.deepEqual(
			temporary.getPackageAgents().map((file) => [file.scope, file.packageName]),
			[
				["temporary", "@acme/review-kit"],
				["temporary", "@acme/review-kit"],
			],
		);
	});

	test("only a manifest's agents field ships agents; an agents directory alone does not (#5991)", async () => {
		const fixture = makeFixture();
		const plain = join(fixture.root, "packages", "plain");
		write(join(plain, "package.json"), JSON.stringify({ name: "plain", atomic: { skills: [] } }));
		write(join(plain, "agents", "helper.md"), agentFile({ name: "helper", description: "Helps" }));
		const extensionDir = join(fixture.root, "packages", "extension-dir");
		write(join(extensionDir, "index.ts"), "export default function () {}\n");
		write(join(extensionDir, "agents", "helper.md"), agentFile({ name: "helper", description: "Helps" }));
		const packageManager = new DefaultPackageManager({
			cwd: fixture.project,
			agentDir: fixture.agentDir,
			settingsManager: SettingsManager.inMemory({ packages: [plain, extensionDir] }),
		});

		const resolved = await packageManager.resolve();

		assert.deepEqual(resolved.agents, []);
		// A manifest-less directory package still loads its index.ts as an extension, as before.
		assert.deepEqual(
			resolved.extensions.map((resource) => resource.path),
			[extensionDir],
		);
	});
});

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

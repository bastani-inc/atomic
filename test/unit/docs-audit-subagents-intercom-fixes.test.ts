import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import type net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Api, getModel, type Model } from "@bastani/atomic-ai/compat";
import { afterEach, describe, test } from "vitest";
import {
	AuthStorage,
	ModelRegistry,
	ModelRuntime,
	resolveModelScopeFromModels,
} from "../../packages/coding-agent/src/index.js";
import { handleBrokerPresence } from "../../packages/intercom/broker/presence-handler.js";
import type { BrokerConnectedSession } from "../../packages/intercom/broker/send-handler.js";
import type { BrokerMessage } from "../../packages/intercom/types.js";
import { discoverAgents, discoverAgentsAll } from "../../packages/subagents/src/agents/agent-discovery.js";
import { loadAgentsFromDir } from "../../packages/subagents/src/agents/agent-loaders.js";
import {
	handleManagementAction,
	type ManagementContext,
} from "../../packages/subagents/src/agents/agent-management.js";
import {
	type ModelScopeContext,
	resolveSessionModelScope,
} from "../../packages/subagents/src/runs/shared/model-scope.js";

const cleanups: Array<() => void> = [];
const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	ATOMIC_CODING_AGENT_DIR: process.env.ATOMIC_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function makeModel(provider: string, id: string): Model<Api> {
	const base = getModel("anthropic", "claude-sonnet-4-5")!;
	return { ...base, provider, id, name: `${provider}/${id}` };
}

function makeModelScopeContext(available: readonly Model<Api>[]): ModelScopeContext {
	return {
		scopedModels: [],
		modelRegistry: {
			getAvailable: () => [...available],
		} as ModelScopeContext["modelRegistry"],
	};
}

describe("subagent model-scope parity with main session", () => {
	const sonnet45 = makeModel("anthropic", "claude-sonnet-4-5");
	const sonnet46 = makeModel("anthropic", "claude-sonnet-4-6");
	const haiku45 = makeModel("anthropic", "claude-haiku-4-5");
	const bracketed = makeModel("anthropic", "bracketed-model[1m]");
	const azureGpt = makeModel("azure", "gpt-5");
	const catalog = [sonnet45, sonnet46, haiku45, bracketed, azureGpt];

	test("resolves [...] character-class globs and thinking suffixes identically to resolveModelScopeFromModels", () => {
		const patterns = ["anthropic/claude-sonnet-4-[45]:high", "anthropic/claude-[h]*-4-5"];
		const scope = resolveSessionModelScope(makeModelScopeContext(catalog), { enabledModels: patterns });
		const expected = resolveModelScopeFromModels(patterns, catalog).scopedModels;

		assert.ok(scope);
		assert.deepEqual(scope.allowedFullIds, ["anthropic/claude-sonnet-4-5", "anthropic/claude-haiku-4-5"]);
		assert.deepEqual(
			scope.scopedModels.map((entry) => ({
				id: `${entry.model.provider}/${entry.model.id}`,
				thinkingLevel: entry.thinkingLevel,
			})),
			expected.map((entry) => ({
				id: `${entry.model.provider}/${entry.model.id}`,
				thinkingLevel: entry.thinkingLevel,
			})),
		);
		assert.equal(scope.scopedModels[0]?.thinkingLevel, "high");
	});

	test("matches literal bracketed model IDs before globbing, with and without thinking suffix", () => {
		const withoutSuffix = resolveSessionModelScope(makeModelScopeContext(catalog), {
			enabledModels: ["bracketed-model[1m]"],
		});
		assert.deepEqual(withoutSuffix?.allowedFullIds, ["anthropic/bracketed-model[1m]"]);
		assert.equal(withoutSuffix?.scopedModels[0]?.thinkingLevel, undefined);

		const withSuffix = resolveSessionModelScope(makeModelScopeContext(catalog), {
			enabledModels: ["anthropic/bracketed-model[1m]:high"],
		});
		assert.deepEqual(withSuffix?.allowedFullIds, ["anthropic/bracketed-model[1m]"]);
		assert.equal(withSuffix?.scopedModels[0]?.thinkingLevel, "high");
	});

	test("normalizes legacy Azure provider references in enabledModels patterns", () => {
		const scope = resolveSessionModelScope(makeModelScopeContext(catalog), {
			enabledModels: ["azure-openai-responses/gpt-5"],
		});
		assert.deepEqual(scope?.allowedFullIds, ["azure/gpt-5"]);
	});
});

describe("agent frontmatter YAML sequences for list fields", () => {
	function writeAgentFiles(files: Record<string, string>): string {
		const dir = makeTempDir("atomic-frontmatter-lists-");
		for (const [fileName, content] of Object.entries(files)) {
			writeFileSync(join(dir, fileName), content, "utf-8");
		}
		return dir;
	}

	test("accepts YAML flow and block sequences alongside comma-separated strings for all list fields", async () => {
		const dir = writeAgentFiles({
			"comma.md": [
				"---",
				"name: comma",
				"description: comma agent",
				"fallbackModels: openai/gpt-5-mini, anthropic/claude-haiku-4-5",
				"fallbackThinkingLevels: low, high",
				"skills: tdd, tmux",
				"defaultReads: README.md, AGENTS.md",
				"extensions: /ext/a.ts, /ext/b.ts",
				"---",
				"body",
			].join("\n"),
			"flow.md": [
				"---",
				"name: flow",
				"description: flow agent",
				"fallbackModels: [openai/gpt-5-mini, anthropic/claude-haiku-4-5]",
				"fallbackThinkingLevels: [low, high]",
				"skills: [tdd, tmux]",
				"defaultReads: [README.md, AGENTS.md]",
				"extensions: [/ext/a.ts, /ext/b.ts]",
				"---",
				"body",
			].join("\n"),
			"block.md": [
				"---",
				"name: block",
				"description: block agent",
				"fallbackModels:",
				"  - openai/gpt-5-mini",
				"  - anthropic/claude-haiku-4-5",
				"fallbackThinkingLevels:",
				"  - low",
				"  - high",
				"skill:",
				"  - tdd",
				"  - tmux",
				"defaultReads:",
				"  - README.md",
				"  - AGENTS.md",
				"extensions:",
				"  - /ext/a.ts",
				"  - /ext/b.ts",
				"---",
				"body",
			].join("\n"),
		});

		const agents = await loadAgentsFromDir(dir, "user");
		assert.equal(agents.length, 3);
		for (const agent of agents) {
			assert.deepEqual(agent.fallbackModels, ["openai/gpt-5-mini", "anthropic/claude-haiku-4-5"], agent.name);
			assert.deepEqual(agent.fallbackThinkingLevels, ["low", "high"], agent.name);
			assert.deepEqual(agent.skills, ["tdd", "tmux"], agent.name);
			assert.deepEqual(agent.defaultReads, ["README.md", "AGENTS.md"], agent.name);
			assert.deepEqual(agent.extensions, ["/ext/a.ts", "/ext/b.ts"], agent.name);
		}
	});

	test("falls back from empty skill array to skills array and preserves empty extensions semantics", async () => {
		const dir = writeAgentFiles({
			"empty-extensions-array.md": [
				"---",
				"name: ext-array",
				"description: ext array agent",
				"skill: []",
				"skills: [agent-browser]",
				"fallbackModels: []",
				"fallbackThinkingLevels: []",
				"defaultReads: []",
				"extensions: []",
				"---",
				"body",
			].join("\n"),
			"empty-extensions-bare.md": [
				"---",
				"name: ext-bare",
				"description: ext bare agent",
				"extensions:",
				"---",
				"body",
			].join("\n"),
			"empty-extensions-string.md": [
				"---",
				"name: ext-string",
				"description: ext string agent",
				'extensions: ""',
				"---",
				"body",
			].join("\n"),
			"omitted-extensions.md": ["---", "name: ext-omitted", "description: ext omitted agent", "---", "body"].join(
				"\n",
			),
		});

		const agents = new Map((await loadAgentsFromDir(dir, "user")).map((agent) => [agent.name, agent]));
		const extArray = agents.get("ext-array");
		assert.ok(extArray);
		assert.deepEqual(extArray.skills, ["agent-browser"]);
		assert.equal(extArray.fallbackModels, undefined);
		assert.equal(extArray.fallbackThinkingLevels, undefined);
		assert.equal(extArray.defaultReads, undefined);
		assert.deepEqual(extArray.extensions, []);

		assert.deepEqual(agents.get("ext-bare")?.extensions, []);
		assert.deepEqual(agents.get("ext-string")?.extensions, []);
		assert.equal(agents.get("ext-omitted")?.extensions, undefined);
	});
});

describe("discoverAgentsAll user agent precedence and deduplication", () => {
	function makeIsolatedHome(): { home: string; project: string } {
		const root = realpathSync(makeTempDir("atomic-discover-all-user-"));
		const home = join(root, "home");
		const project = join(root, "project");
		mkdirSync(home, { recursive: true });
		mkdirSync(join(project, ".atomic"), { recursive: true });
		process.env.HOME = home;
		process.env.USERPROFILE = home;
		delete process.env.ATOMIC_CODING_AGENT_DIR;
		delete process.env.PI_CODING_AGENT_DIR;
		return { home, project };
	}

	function writeAgent(dir: string, name: string, description: string): string {
		const file = join(dir, `${name}.md`);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(
			file,
			["---", `name: ${name}`, `description: ${description}`, "---", `${description} prompt.`].join("\n"),
			"utf-8",
		);
		return file;
	}

	async function makeManagementCtx(cwd: string): Promise<ManagementContext> {
		const runtime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
		return {
			cwd,
			modelRegistry: new ModelRegistry(runtime),
			isProjectTrusted: () => true,
		};
	}

	test("deduplicates user agents with ~/.pi/agent/agents < ~/.agents < ~/.atomic/agent/agents precedence", async () => {
		const { home, project } = makeIsolatedHome();
		const piFile = writeAgent(join(home, ".pi", "agent", "agents"), "helper", "Pi helper");
		const sharedFile = writeAgent(join(home, ".agents"), "helper", "Shared helper");
		const atomicFile = writeAgent(join(home, ".atomic", "agent", "agents"), "helper", "Atomic helper");
		writeAgent(join(home, ".pi", "agent", "agents"), "legacy-only", "Pi legacy");

		const discoveredAll = await discoverAgentsAll(project, { projectTrusted: true });
		const discovered = await discoverAgents(project, "user", { projectTrusted: true });
		const helperEntries = discoveredAll.user.filter((agent) => agent.name === "helper");

		assert.equal(helperEntries.length, 1);
		assert.equal(helperEntries[0]?.description, "Atomic helper");
		assert.equal(helperEntries[0]?.filePath, atomicFile);
		assert.equal(helperEntries[0]?.filePath, discovered.agents.find((agent) => agent.name === "helper")?.filePath);
		assert.equal(discoveredAll.user.find((agent) => agent.name === "legacy-only")?.description, "Pi legacy");
		assert.notEqual(helperEntries[0]?.filePath, piFile);
		assert.notEqual(helperEntries[0]?.filePath, sharedFile);
	});

	test("prefers ~/.agents over ~/.pi/agent/agents when ~/.atomic/agent/agents does not define the agent", async () => {
		const { home, project } = makeIsolatedHome();
		writeAgent(join(home, ".pi", "agent", "agents"), "helper", "Pi helper");
		const sharedFile = writeAgent(join(home, ".agents"), "helper", "Shared helper");

		const discoveredAll = await discoverAgentsAll(project, { projectTrusted: true });
		const helperEntries = discoveredAll.user.filter((agent) => agent.name === "helper");

		assert.equal(helperEntries.length, 1);
		assert.equal(helperEntries[0]?.description, "Shared helper");
		assert.equal(helperEntries[0]?.filePath, sharedFile);
	});

	test("management list, update, and delete target the winning user agent without duplicate errors", async () => {
		const { home, project } = makeIsolatedHome();
		const piFile = writeAgent(join(home, ".pi", "agent", "agents"), "helper", "Pi helper");
		const sharedFile = writeAgent(join(home, ".agents"), "helper", "Shared helper");
		const atomicFile = writeAgent(join(home, ".atomic", "agent", "agents"), "helper", "Atomic helper");
		const ctx = await makeManagementCtx(project);

		const listed = await handleManagementAction("list", { agentScope: "user" }, ctx);
		assert.notEqual(listed.isError, true);
		const listedText = listed.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
		const helperLines = listedText.split("\n").filter((line) => line.startsWith("- helper ("));
		assert.deepEqual(helperLines, ["- helper (user): Atomic helper"]);

		const updated = await handleManagementAction(
			"update",
			{ agent: "helper", agentScope: "user", config: { description: "Updated atomic helper" } },
			ctx,
		);
		assert.notEqual(updated.isError, true, updated.content[0]?.type === "text" ? updated.content[0].text : "");
		assert.match(readFileSync(atomicFile, "utf-8"), /description: Updated atomic helper/);
		assert.match(readFileSync(sharedFile, "utf-8"), /description: Shared helper/);
		assert.match(readFileSync(piFile, "utf-8"), /description: Pi helper/);

		const deleted = await handleManagementAction("delete", { agent: "helper", agentScope: "user" }, ctx);
		assert.notEqual(deleted.isError, true, deleted.content[0]?.type === "text" ? deleted.content[0].text : "");
		assert.equal(existsSync(atomicFile), false);
		assert.equal(existsSync(sharedFile), true);
		assert.equal(existsSync(piFile), true);
	});
});

describe("intercom targeted leave_group fallback to registrationGroup", () => {
	function makeBrokerFixture(definitions: Array<{ id: string; groups: string[]; registrationGroup?: string }>): {
		sessions: Map<string, BrokerConnectedSession>;
		sockets: Record<string, net.Socket>;
		writes: Array<{ socket: net.Socket; message: BrokerMessage }>;
		presence(id: string, message: { type: string; group?: string; requestId?: string }): void;
	} {
		const sessions = new Map<string, BrokerConnectedSession>();
		const sockets: Record<string, net.Socket> = {};
		for (const def of definitions) {
			const socket = {} as net.Socket;
			sockets[def.id] = socket;
			sessions.set(def.id, {
				socket,
				info: {
					id: def.id,
					name: def.id,
					cwd: "/tmp",
					model: "test",
					pid: 1,
					startedAt: 1,
					lastActivity: 1,
					groups: [...def.groups],
					group: def.groups[0],
				},
				registrationGroup: def.registrationGroup,
			});
		}
		const writes: Array<{ socket: net.Socket; message: BrokerMessage }> = [];
		const write = (socket: net.Socket, message: BrokerMessage): void => {
			writes.push({ socket, message });
		};
		return {
			sessions,
			sockets,
			writes,
			presence: (id, message) => handleBrokerPresence(sockets[id]!, message, id, sessions, write),
		};
	}

	test("leaving a session's last project group stays in registrationGroup instead of moving to default", () => {
		const h = makeBrokerFixture([
			{ id: "member", groups: ["project:acme/app"], registrationGroup: "project:acme/app" },
			{ id: "project-peer", groups: ["project:acme/app"], registrationGroup: "project:acme/app" },
			{ id: "default-peer", groups: ["default"], registrationGroup: "default" },
		]);

		h.presence("member", { type: "leave_group", group: "project:acme/app", requestId: "leave-last" });

		assert.deepEqual(h.sessions.get("member")?.info.groups, ["project:acme/app"]);
		assert.equal(h.sessions.get("member")?.info.group, "project:acme/app");
		const ack = h.writes.find(
			({ socket, message }) => socket === h.sockets.member && message.type === "membership_ack",
		);
		assert.ok(ack && ack.message.type === "membership_ack");
		assert.deepEqual(ack.message.groups, ["project:acme/app"]);
		assert.equal(
			h.writes.some(
				({ socket, message }) => socket === h.sockets["default-peer"] && message.type === "session_joined",
			),
			false,
		);
		assert.equal(
			h.writes.some(
				({ socket, message }) => socket === h.sockets["project-peer"] && message.type === "session_left",
			),
			false,
		);
	});

	test("leaving the last non-home membership returns to registrationGroup rather than default", () => {
		const h = makeBrokerFixture([
			{ id: "member", groups: ["project:acme/app", "reviewers"], registrationGroup: "project:acme/app" },
			{ id: "project-peer", groups: ["project:acme/app"], registrationGroup: "project:acme/app" },
			{ id: "default-peer", groups: ["default"], registrationGroup: "default" },
		]);

		h.presence("member", { type: "leave_group", group: "project:acme/app", requestId: "leave-home-first" });
		assert.deepEqual(h.sessions.get("member")?.info.groups, ["reviewers"]);

		h.writes.length = 0;
		h.presence("member", { type: "leave_group", group: "reviewers", requestId: "leave-final" });
		assert.deepEqual(h.sessions.get("member")?.info.groups, ["project:acme/app"]);
		assert.equal(h.sessions.get("member")?.info.group, "project:acme/app");
		assert.equal(
			h.writes.some(
				({ socket, message }) => socket === h.sockets["project-peer"] && message.type === "session_joined",
			),
			true,
		);
		assert.equal(
			h.writes.some(
				({ socket, message }) => socket === h.sockets["default-peer"] && message.type === "session_joined",
			),
			false,
		);
	});

	test("leaving the last group falls back to default when registrationGroup is unset", () => {
		const h = makeBrokerFixture([{ id: "member", groups: ["team-a"] }]);

		h.presence("member", { type: "leave_group", group: "team-a", requestId: "leave-default" });

		assert.deepEqual(h.sessions.get("member")?.info.groups, ["default"]);
		assert.equal(h.sessions.get("member")?.info.group, "default");
	});
});

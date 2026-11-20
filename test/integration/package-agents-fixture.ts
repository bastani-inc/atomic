/**
 * An isolated profile for the #5991 acceptance tests: a temporary home and agent directory, a copy of the
 * `review-kit` fixture package (`test/fixtures/package-agents/review-kit`, whose manifest ships `agents: ["./agents"]`),
 * scripted model providers, and a loopback MCP server. Sessions are real SDK sessions with the shipped subagents and
 * MCP packages, driven by a scripted parent model through its `codemode` and `subagent` tools. No credential, network
 * provider or user file is read: the providers are registered on an in-memory runtime, and `HOME` and the agent
 * directory point into the profile.
 */

import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getCurrentTools, getSystemMessageText, type JsonObject, type JsonValue } from "@bastani/atomic-ai";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@bastani/atomic-ai/compat";
import { vi } from "vitest";
import { LATEST_PROTOCOL_VERSION } from "../../packages/coding-agent/src/extensions/mcp/client/index.js";
import {
	type AgentSession,
	AuthStorage,
	createAgentSession,
	DefaultPackageManager,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { linkSharedTranspileCache } from "../../packages/coding-agent/test/helpers/shared-transpile-cache.js";
import { closeServers, listen, readBody } from "../../packages/coding-agent/test/mcp-client/helpers.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const FIXTURE_PACKAGE = fileURLToPath(new URL("../fixtures/package-agents/review-kit", import.meta.url));

/** `@acme/review-kit`'s namespace, and its `reviewer` agent's full runtime name. */
export const PACKAGE_NAMESPACE = "acme.review-kit";
export const PACKAGE_AGENT = `${PACKAGE_NAMESPACE}.reviewer`;
/** The fixture agent's role prompt. */
export const PACKAGE_AGENT_ROLE = "REVIEW-KIT ROLE";

export const PARENT_MODEL = "kit-parent/director";
/** The fixture agent's pinned model and its fallback chain, with their pinned thinking levels. */
export const PRIMARY_MODEL = "kit-primary/argon";
export const SECONDARY_MODEL = "kit-secondary/boron";
export const TERTIARY_MODEL = "kit-tertiary/carbon";
/** The model a user agent overriding the package agent pins. */
export const USER_MODEL = "kit-user/delta";

export const UNAVAILABLE = "503 Service Unavailable: the model is overloaded";

/** The MCP server the fixture agent's `tools:` selects (`mcp:kitdocs`), and one it does not. */
export const SELECTED_MCP_SERVER = "kitdocs";
export const STRAY_MCP_SERVER = "stray";
export const SELECTED_MCP_TOOL = `mcp__${SELECTED_MCP_SERVER}__lookup`;
export const STRAY_MCP_TOOL = `mcp__${STRAY_MCP_SERVER}__wipe`;
export const MCP_LOOKUP_TEXT = "kit docs: approve only reviewed changes";

export interface ToolResultSeen {
	readonly name: string;
	readonly text: string;
	readonly isError: boolean;
}

/** One request a scripted provider received. */
export interface ProviderRequest {
	/** `provider/id`. */
	readonly model: string;
	/** The thinking level the session asked the provider for. */
	readonly reasoning: string | undefined;
	readonly tools: readonly string[];
	readonly systemPrompt: string;
	/** The first user message's text: the task a child was given. */
	readonly task: string;
	readonly toolResults: readonly ToolResultSeen[];
}

export interface ScriptedCall {
	readonly name: string;
	readonly arguments: JsonObject;
}

export type Reply =
	| { readonly text: string }
	| { readonly calls: readonly ScriptedCall[] }
	| { readonly error: string };

/** One entry of a codemode `subagent({ action: "list" })` result. */
export interface ListedAgent {
	readonly name: string;
	readonly description: string;
	readonly scope: string;
	readonly model?: string;
	readonly package?: string;
}

/**
 * A codemode script that launches `agent` on `task` and waits for it to settle. A launch the subagent tool rejects
 * outright (an agent it does not know) throws in the script; the script reports that as its refusal.
 */
export function launchAndWaitScript(agent: string, task: string): string {
	return `let launched;
try {
	launched = await tools.subagent({ agent: ${JSON.stringify(agent)}, task: ${JSON.stringify(task)} });
} catch (error) {
	return { rejected: String(error && error.message ? error.message : error) };
}
const task = launched.tasks[0];
if (task.state === "refused") return { launched };
return { launched, waited: await tools.subagent({ action: "wait", id: task.taskId, budgetMs: 90000 }) };`;
}

export interface LaunchOutcome {
	/** Why the launch was refused or rejected, when it was. */
	readonly refused?: string;
	/** The settled child's status and output. */
	readonly status?: string;
	readonly output?: string;
}

export function launchOutcome(value: JsonValue): LaunchOutcome {
	const result = value as {
		rejected?: string;
		launched?: { tasks: { state: string; reason?: string }[] };
		waited?: { outcome: string; result?: { status: string; output?: string; reason?: string } };
	};
	if (result.rejected !== undefined) return { refused: result.rejected };
	const task = result.launched!.tasks[0]!;
	if (task.state === "refused") return { refused: task.reason ?? "refused" };
	assert.equal(result.waited?.outcome, "settled", JSON.stringify(result));
	return {
		status: result.waited?.result?.status,
		output: result.waited?.result?.output ?? result.waited?.result?.reason,
	};
}

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : ""))
		.join("");
}

export interface PackageAgentProfile {
	readonly root: string;
	readonly home: string;
	readonly agentDir: string;
	/** A project directory with its own `.atomic` config directory. */
	readonly project: string;
	/** The profile's copy of the fixture package. */
	readonly packageDir: string;
	/** A file a child's forbidden `bash` call would create. */
	readonly bashMarker: string;
	/** Every request any scripted provider received, in order. */
	readonly requests: ProviderRequest[];
	/** Every MCP tool call the loopback server received, as `server/tool`. */
	readonly mcpCalls: string[];
	/** How a child model answers; the parent model follows the scripts `runScript` and `callSubagent` queue. */
	respondAsChild: (request: ProviderRequest) => Reply;
	/** Writes `settings` as the profile's global settings, keeping retries and compaction off. */
	writeGlobalSettings(settings: Record<string, unknown>): void;
	/** Writes `settings` as the project's settings, keeping retries and compaction off. */
	writeProjectSettings(settings: Record<string, unknown>): void;
	/** Writes a user agent file into the profile's agent directory. */
	writeUserAgent(fileName: string, content: string): void;
	/** Copies the fixture package into a directory of its own under another package name; returns the directory. */
	copyPackageAs(packageName: string, dirName: string): string;
	openSession(options?: { projectTrusted?: boolean }): Promise<AgentSession>;
	packageManager(session: AgentSession): DefaultPackageManager;
	/** Runs `code` in the parent's codemode tool and returns the script's value. */
	runScript(session: AgentSession, code: string): Promise<JsonValue>;
	/** Launches `agent` from a codemode script, waits for it to settle, and returns how it ended. */
	launch(session: AgentSession, agent: string, task?: string): Promise<LaunchOutcome>;
	/** The parent's codemode `subagent({ action: "list" })` entries. */
	listAgents(session: AgentSession): Promise<ListedAgent[]>;
	/** Calls the parent's `subagent` tool directly and returns its result text and error flag. */
	callSubagent(session: AgentSession, params: JsonObject): Promise<{ text: string; isError: boolean }>;
	childRequests(): ProviderRequest[];
	parentRequests(): ProviderRequest[];
	cleanup(): Promise<void>;
}

const BASE_SETTINGS = { retry: { enabled: false }, compaction: { enabled: false } };

/** Creates the profile and stubs the environment that points discovery at it; `cleanup` restores both. */
export async function createPackageAgentProfile(): Promise<PackageAgentProfile> {
	const root = makeTempDirectory("atomic-package-agents-");
	const home = join(root, "home");
	const agentDir = join(home, ".atomic", "agent");
	const project = join(root, "project");
	const packageDir = join(root, "packages", "review-kit");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(project, ".atomic"), { recursive: true });
	cpSync(FIXTURE_PACKAGE, packageDir, { recursive: true });
	linkSharedTranspileCache(agentDir);
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("ATOMIC_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_CODING_AGENT_DIR", undefined);
	// Real SDK child sessions, not the subagent runner's NODE_ENV=test stub.
	vi.stubEnv("NODE_ENV", "development");

	const requests: ProviderRequest[] = [];
	const mcpCalls: string[] = [];
	const parentReplies: Reply[] = [];
	const sessions: AgentSession[] = [];

	const mcpServer = (server: string, tool: string, text: string) =>
		listen(async (request, response) => {
			if (request.method !== "POST") {
				response.statusCode = request.method === "DELETE" ? 200 : 405;
				response.end();
				return;
			}
			const message = JSON.parse(await readBody(request)) as {
				id?: number;
				method: string;
				params?: { name: string };
			};
			if (message.id === undefined) {
				response.statusCode = 202;
				response.end();
				return;
			}
			const result =
				message.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: server, version: "1" },
						}
					: message.method === "tools/list"
						? { tools: [{ name: tool, description: `${server} ${tool}`, inputSchema: { type: "object" } }] }
						: { content: [{ type: "text", text }] };
			if (message.method === "tools/call") mcpCalls.push(`${server}/${message.params!.name}`);
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
		});
	const selectedOrigin = await mcpServer(SELECTED_MCP_SERVER, "lookup", MCP_LOOKUP_TEXT);
	const strayOrigin = await mcpServer(STRAY_MCP_SERVER, "wipe", "stray server wiped everything");
	writeFileSync(
		join(agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				[SELECTED_MCP_SERVER]: { url: `${selectedOrigin}/mcp`, exposure: "direct" },
				[STRAY_MCP_SERVER]: { url: `${strayOrigin}/mcp`, exposure: "direct" },
			},
		}),
	);

	const base: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		reasoning: true,
		contextWindow: 200_000,
	};
	const catalog = [PARENT_MODEL, PRIMARY_MODEL, SECONDARY_MODEL, TERTIARY_MODEL, USER_MODEL].map((fullId) => {
		const [provider, id] = fullId.split("/") as [string, string];
		return { ...base, provider, id, name: `${id} (fixture)` } satisfies Model<"anthropic-messages">;
	});
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});

	const profile: PackageAgentProfile = {
		root,
		home,
		agentDir,
		project,
		packageDir,
		bashMarker: join(root, "bash-ran.txt"),
		requests,
		mcpCalls,
		respondAsChild: () => ({ text: "child done" }),
		writeGlobalSettings(settings) {
			writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ ...BASE_SETTINGS, ...settings }, null, 2));
		},
		writeProjectSettings(settings) {
			writeFileSync(
				join(project, ".atomic", "settings.json"),
				JSON.stringify({ ...BASE_SETTINGS, ...settings }, null, 2),
			);
		},
		writeUserAgent(fileName, content) {
			mkdirSync(join(agentDir, "agents"), { recursive: true });
			writeFileSync(join(agentDir, "agents", fileName), content);
		},
		copyPackageAs(packageName, dirName) {
			const dir = join(root, "packages", dirName);
			cpSync(FIXTURE_PACKAGE, dir, { recursive: true });
			const manifestPath = join(dir, "package.json");
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
			writeFileSync(manifestPath, JSON.stringify({ ...manifest, name: packageName }, null, 2));
			return dir;
		},
		async openSession(options = {}) {
			const settingsManager = SettingsManager.create(project, agentDir, {
				projectTrusted: options.projectTrusted ?? true,
			});
			const { session } = await createAgentSession({
				cwd: project,
				agentDir,
				modelRuntime: runtime,
				model: catalog[0],
				thinkingLevel: "off",
				settingsManager,
				sessionManager: SessionManager.inMemory(project),
				builtins: { subagents: true, mcp: true, intercom: false, "web-access": false },
			});
			sessions.push(session);
			await session.bindExtensions({ mode: "print" });
			return session;
		},
		packageManager(session) {
			return new DefaultPackageManager({ cwd: project, agentDir, settingsManager: session.settingsManager });
		},
		async runScript(session, code) {
			const before = session.messages.length;
			parentReplies.push({ calls: [{ name: "codemode", arguments: { code } }] }, { text: "parent done" });
			await session.prompt(`Run script ${before}`);
			const result = session.messages
				.slice(before)
				.find((message) => message.role === "toolResult" && message.toolName === "codemode");
			assert.ok(result?.role === "toolResult", "the parent ran its codemode tool");
			const text = messageText(result.content);
			assert.equal(result.isError, false, text);
			return JSON.parse(text.split("\n").at(-1)!) as JsonValue;
		},
		async launch(session, agent, task = "Review the change") {
			return launchOutcome(await profile.runScript(session, launchAndWaitScript(agent, task)));
		},
		async listAgents(session) {
			const listed = (await profile.runScript(
				session,
				`return await tools.subagent({ action: "list" })`,
			)) as unknown as {
				action: string;
				agents: ListedAgent[];
			};
			assert.equal(listed.action, "list", JSON.stringify(listed));
			return listed.agents;
		},
		async callSubagent(session, params) {
			const before = session.messages.length;
			parentReplies.push({ calls: [{ name: "subagent", arguments: params }] }, { text: "parent done" });
			await session.prompt(`Call subagent ${before}`);
			const result = session.messages
				.slice(before)
				.find((message) => message.role === "toolResult" && message.toolName === "subagent");
			assert.ok(result?.role === "toolResult", "the parent ran its subagent tool");
			return { text: messageText(result.content), isError: result.isError };
		},
		childRequests() {
			return requests.filter((request) => request.model !== PARENT_MODEL);
		},
		parentRequests() {
			return requests.filter((request) => request.model === PARENT_MODEL);
		},
		async cleanup() {
			try {
				for (const session of sessions.splice(0).reverse()) await session.dispose();
			} finally {
				for (const model of catalog) runtime.unregisterProvider(model.provider);
				await closeServers();
				vi.unstubAllEnvs();
				removeTempDirectory(root);
			}
		},
	};
	profile.writeGlobalSettings({});

	for (const model of catalog) {
		runtime.registerProvider(model.provider, {
			api: base.api,
			baseUrl: base.baseUrl,
			apiKey: `${model.provider}-fixture-key`,
			models: [model],
			streamSimple: (requestModel, context, streamOptions) => {
				const fullId = `${requestModel.provider}/${requestModel.id}`;
				const firstUser = context.messages.find((message) => message.role === "user");
				const request: ProviderRequest = {
					model: fullId,
					reasoning: streamOptions?.reasoning,
					tools: getCurrentTools(context.messages).map((tool) => tool.name),
					systemPrompt: context.messages
						.flatMap((message) => (message.role === "system" ? [getSystemMessageText(message)] : []))
						.join("\n"),
					task: firstUser ? messageText(firstUser.content) : "",
					toolResults: context.messages.flatMap((message) =>
						message.role === "toolResult"
							? [{ name: message.toolName, text: messageText(message.content), isError: message.isError }]
							: [],
					),
				};
				requests.push(request);
				const reply =
					fullId === PARENT_MODEL
						? (parentReplies.shift() ?? { text: "parent idle" })
						: profile.respondAsChild(request);
				const stream = createAssistantMessageEventStream();
				const calls = "calls" in reply ? reply.calls : [];
				const failure = "error" in reply ? reply.error : undefined;
				const message: AssistantMessage = {
					role: "assistant",
					content:
						failure !== undefined
							? []
							: calls.length > 0
								? calls.map((call, index) => ({
										type: "toolCall" as const,
										id: `call-${requests.length}-${index}`,
										name: call.name,
										arguments: call.arguments,
									}))
								: [{ type: "text" as const, text: "text" in reply ? reply.text : "" }],
					api: base.api,
					provider: requestModel.provider,
					model: requestModel.id,
					usage: usage(),
					stopReason: failure !== undefined ? "error" : calls.length > 0 ? "toolUse" : "stop",
					...(failure !== undefined ? { errorMessage: failure } : {}),
					timestamp: Date.now(),
				};
				if (failure !== undefined) stream.push({ type: "error", reason: "error", error: message });
				else stream.push({ type: "done", reason: calls.length > 0 ? "toolUse" : "stop", message });
				stream.end(message);
				return stream;
			},
		});
	}
	return profile;
}

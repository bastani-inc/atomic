import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AgentHarness,
	type AgentHarnessOptions,
	type ExecutionError,
	HarnessNotImplemented,
	type HarnessTool,
	InMemorySessionStorage,
	type Result,
	Session,
	type ShellExecOptions,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { createModels } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { describe, expect, test, vi } from "vitest";
import {
	buildCodingAgentHarnessSystemPrompt,
	type CodingAgentHarnessTool,
	createCodingAgentHarness,
} from "../../src/server/create-harness.ts";

class CapturingExecutionEnv extends NodeExecutionEnv {
	executionOverrides: Record<string, string> | undefined;
	readCalls = 0;
	writeCalls = 0;
	listDirCalls = 0;
	readTextFileCalls = 0;
	fileInfoCalls = 0;
	override async exec(
		command: string,
		options?: ShellExecOptions,
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		this.executionOverrides = options?.env ? { ...options.env } : undefined;
		return super.exec(command, options);
	}

	override async readBinaryFile(path: string, abortSignal?: AbortSignal) {
		this.readCalls++;
		return super.readBinaryFile(path, abortSignal);
	}

	override async writeFile(path: string, content: string | Uint8Array, abortSignal?: AbortSignal) {
		this.writeCalls++;
		return super.writeFile(path, content, abortSignal);
	}

	override async listDir(path: string, abortSignal?: AbortSignal) {
		this.listDirCalls++;
		return super.listDir(path, abortSignal);
	}

	override async readTextFile(path: string, abortSignal?: AbortSignal) {
		this.readTextFileCalls++;
		return super.readTextFile(path, abortSignal);
	}

	override async fileInfo(path: string) {
		this.fileInfoCalls++;
		return super.fileInfo(path);
	}
}

async function resolveSystemPrompt(systemPrompt: AgentHarnessOptions["systemPrompt"]): Promise<string> {
	if (typeof systemPrompt === "string") return systemPrompt;
	if (systemPrompt === undefined) throw new Error("Expected a system prompt callback");
	return systemPrompt();
}

function createPromptTool(name: string, promptSnippet?: string, promptGuidelines?: string[]): CodingAgentHarnessTool {
	return {
		name,
		label: name,
		description: `${name} description`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		promptSnippet,
		promptGuidelines,
	};
}

function createSession(id: string): Session {
	return new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
}

const defaultPromptTools = [
	createPromptTool("read", "Read a path selector.", [
		"Use read to inspect file and resource contents; use path selectors for line ranges, raw output, and conflict views.",
	]),
	createPromptTool("bash", "Execute a shell command.", [
		"You can inspect ATOMIC_* or PI_* environment variables for current model and session details.",
	]),
	createPromptTool("edit", "Apply source edits with hashline patch input", ["Edit carefully."]),
	createPromptTool("write", "Create or overwrite a writable path selector.", [
		"Use write when replacing the full content of a target; use edit for source edits anchored on a hashline snapshot.",
	]),
];

describe("coding-agent Harness construction", () => {
	test("adds Atomic tool policy to explicit Harness options", async () => {
		const session = createSession("harness-session");
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
			streamOptions: { maxTokens: 123 },
			retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
			steeringMode: "all",
			followUpMode: "all",
		});
		try {
			expect(created.suspended).toEqual([]);
			expect(await created.harness.getActiveTools()).toEqual(["read", "bash", "edit", "write", "find", "search"]);
			expect((await created.harness.getTools()).map((tool) => tool.name)).toEqual([
				"read",
				"bash",
				"edit",
				"write",
				"find",
				"search",
			]);
			expect(await created.harness.getStreamOptions()).toEqual({ maxTokens: 123 });
			expect(await created.harness.getRetryPolicy()).toEqual({ enabled: true, maxRetries: 2, baseDelayMs: 10 });
			expect(await created.harness.getSteeringMode()).toBe("all");
			expect(await created.harness.getFollowUpMode()).toBe("all");
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("preserves Atomic prompt snippets and guideline order", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: defaultPromptTools,
			activeToolNames: ["read", "bash", "edit", "write"],
		});
		expect(prompt).toContain("- read: Read a path selector.");
		expect(prompt).toContain("- bash: Execute a shell command.");
		expect(prompt).toContain(
			"Use read to inspect file and resource contents; use path selectors for line ranges, raw output, and conflict views.",
		);
		expect(prompt).toContain(
			"You can inspect ATOMIC_* or PI_* environment variables for current model and session details.",
		);
		expect(prompt.indexOf("Use read to inspect file")).toBeLessThan(
			prompt.indexOf("You can inspect ATOMIC_* or PI_* environment variables"),
		);
	});

	test("preserves caller-supplied tools and activation", async () => {
		const session = createSession("custom-harness-session");
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		const customTool: HarnessTool = {
			name: "inspect",
			label: "inspect",
			description: "Inspect the configured service",
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
		};
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
			tools: [customTool],
			activeToolNames: [],
			systemPrompt: "Server-owned prompt",
		});
		try {
			expect((await created.harness.getTools()).map((tool) => tool.name)).toEqual(["inspect"]);
			expect(await created.harness.getActiveTools()).toEqual([]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("uses an injected ExecutionEnv for Atomic file and shell tools", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-harness-env-"));
		const session = createSession("injected-env-session");
		const env = new CapturingExecutionEnv({
			cwd: root,
			shellEnv: { PI_SESSION_FILE: "/stale/parent.jsonl", PI_CODING_AGENT: "true" },
		});
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
			sessionFile: "/sessions/current.jsonl",
		});
		const originalCodingAgent = process.env.PI_CODING_AGENT;
		process.env.PI_CODING_AGENT = "false";
		try {
			const tools = await created.harness.getTools();
			const write = tools.find((tool) => tool.name === "write");
			const read = tools.find((tool) => tool.name === "read");
			const edit = tools.find((tool) => tool.name === "edit");
			const bash = tools.find((tool) => tool.name === "bash");
			const find = tools.find((tool) => tool.name === "find");
			if (!write || !read || !edit || !bash || !find) throw new Error("Expected the default Atomic tools");

			await write.execute("write-call", { path: "nested/file.txt", content: "hello" });
			const readResult = await read.execute("read-call", { path: "nested/file.txt" });
			const readText = readResult.content[0];
			if (readText?.type !== "text") throw new Error("Expected hashline read text");
			const header = readText.text.split("\n", 1)[0];
			await edit.execute("edit-call", { input: `${header}\nreplace 1..1:\n+world` });
			const editedReadResult = await read.execute("edited-read-call", { path: "nested/file.txt" });
			const bashResult = await bash.execute("bash-call", {
				command: `printf '%s' "$ATOMIC_SESSION_ID|$ATOMIC_SESSION_FILE|$ATOMIC_PROVIDER|$ATOMIC_MODEL|$ATOMIC_REASONING_LEVEL|$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_CODING_AGENT|$ATOMIC_HARNESS_CALL"`,
				env: { ATOMIC_HARNESS_CALL: "call-only" },
			});
			const findResult = await find.execute("find-call", { paths: ["nested"] });

			expect(env.writeCalls).toBeGreaterThan(0);
			expect(env.readCalls).toBeGreaterThan(0);
			expect(env.listDirCalls).toBeGreaterThan(0);
			expect(env.fileInfoCalls).toBeGreaterThan(0);
			expect(Object.keys(env.executionOverrides ?? {}).sort()).toEqual(
				[
					"ATOMIC_HARNESS_CALL",
					"ATOMIC_SESSION_ID",
					"ATOMIC_SESSION_FILE",
					"ATOMIC_PROVIDER",
					"ATOMIC_MODEL",
					"ATOMIC_REASONING_LEVEL",
					"PI_SESSION_ID",
					"PI_SESSION_FILE",
					"PI_PROVIDER",
					"PI_MODEL",
					"PI_REASONING_LEVEL",
				].sort(),
			);
			expect(env.executionOverrides).toMatchObject({
				ATOMIC_HARNESS_CALL: "call-only",
				ATOMIC_SESSION_ID: "injected-env-session",
				ATOMIC_SESSION_FILE: "/sessions/current.jsonl",
				ATOMIC_PROVIDER: "google",
				ATOMIC_MODEL: "gemini-2.5-flash",
				ATOMIC_REASONING_LEVEL: "high",
				PI_SESSION_ID: "injected-env-session",
				PI_SESSION_FILE: "/sessions/current.jsonl",
				PI_PROVIDER: "google",
				PI_MODEL: "gemini-2.5-flash",
				PI_REASONING_LEVEL: "high",
			});
			expect(env.executionOverrides).not.toHaveProperty("PI_CODING_AGENT");
			expect(readResult.content).toEqual([
				{
					type: "text",
					text: expect.stringMatching(/^\[nested\/file\.txt#[0-9A-F]{4}\]\n1:hello$/),
				},
			]);
			expect(editedReadResult.content).toEqual([
				{
					type: "text",
					text: expect.stringMatching(/^\[nested\/file\.txt#[0-9A-F]{4}\]\n1:world$/),
				},
			]);
			expect(bashResult.content).toEqual([
				{
					type: "text",
					text: "injected-env-session|/sessions/current.jsonl|google|gemini-2.5-flash|high|injected-env-session|/sessions/current.jsonl|google|gemini-2.5-flash|high|true|call-only",
				},
			]);
			expect(findResult.content).toEqual([{ type: "text", text: "file.txt" }]);
		} finally {
			if (originalCodingAgent === undefined) delete process.env.PI_CODING_AGENT;
			else process.env.PI_CODING_AGENT = originalCodingAgent;
			await created.harness.close();
			await env.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps search local until its remote operations seam is complete", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-harness-search-"));
		const env = new CapturingExecutionEnv({ cwd: root });
		const created = await createCodingAgentHarness({
			session: createSession("local-search-harness"),
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
		});
		try {
			const tools = await created.harness.getTools();
			const write = tools.find((tool) => tool.name === "write");
			const search = tools.find((tool) => tool.name === "search");
			if (!write || !search) throw new Error("Expected the default write and search tools");

			await write.execute("write-search-file", { path: "remote.txt", content: "needle" });
			const result = await search.execute("search-call", { pattern: "needle", paths: ["remote.txt"] });
			const text = result.content[0];
			if (text?.type !== "text") throw new Error("Expected text search output");
			expect(text.text).toContain("needle");
			expect(env.readTextFileCalls).toBe(0);
			expect(env.listDirCalls).toBe(0);
		} finally {
			await created.harness.close();
			await env.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects an ExecutionEnv without renameFile", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-harness-invalid-env-"));
		const env = new NodeExecutionEnv({ cwd: root });
		const invalidEnv = new Proxy(env, {
			get(target, property, receiver) {
				return property === "renameFile" ? undefined : Reflect.get(target, property, receiver);
			},
		});
		try {
			await expect(
				createCodingAgentHarness({
					session: createSession("invalid-env-session"),
					models: createModels(),
					model: getModel("google", "gemini-2.5-flash"),
					env: invalidEnv,
					tools: [],
					activeToolNames: [],
					systemPrompt: "Server-owned prompt",
				}),
			).rejects.toThrow("ExecutionEnv.renameFile");
		} finally {
			await env.cleanup();
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("sets the optional session file in the default bash tool environment", async () => {
		const session = createSession("session-file-harness");
		const env = new CapturingExecutionEnv({
			cwd: process.cwd(),
			shellEnv: { PI_SESSION_FILE: "/stale/parent.jsonl", PI_CODING_AGENT: "true" },
		});
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
			sessionFile: "/sessions/current.jsonl",
		});
		try {
			const bash = (await created.harness.getTools()).find((tool) => tool.name === "bash");
			if (!bash) throw new Error("Expected the default bash tool");

			const result = await bash.execute("bash-call", {
				command: `printf '%s' "$PI_SESSION_ID|$PI_SESSION_FILE|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_CODING_AGENT"`,
			});

			expect(env.executionOverrides).toMatchObject({
				ATOMIC_SESSION_ID: "session-file-harness",
				ATOMIC_SESSION_FILE: "/sessions/current.jsonl",
				ATOMIC_PROVIDER: "google",
				ATOMIC_MODEL: "gemini-2.5-flash",
				ATOMIC_REASONING_LEVEL: "high",
				PI_SESSION_ID: "session-file-harness",
				PI_SESSION_FILE: "/sessions/current.jsonl",
				PI_PROVIDER: "google",
				PI_MODEL: "gemini-2.5-flash",
				PI_REASONING_LEVEL: "high",
			});
			expect(result.content).toEqual([
				{
					type: "text",
					text: "session-file-harness|/sessions/current.jsonl|google|gemini-2.5-flash|high|true",
				},
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("keeps bash Atomic and PI model variables synchronized with Harness state", async () => {
		const session = createSession("dynamic-bash-session");
		const env = new CapturingExecutionEnv({
			cwd: process.cwd(),
			shellEnv: { PI_SESSION_FILE: "/stale/parent.jsonl", PI_CODING_AGENT: "true" },
		});
		const created = await createCodingAgentHarness({
			session,
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			thinkingLevel: "high",
			env,
		});
		try {
			await created.harness.setModel(getModel("anthropic", "claude-sonnet-4-5"));
			await created.harness.setThinkingLevel("low");
			const bash = (await created.harness.getTools()).find((tool) => tool.name === "bash");
			if (!bash) throw new Error("Expected the default bash tool");

			const result = await bash.execute("bash-call", {
				command: `printf '%s' "\${PI_SESSION_FILE-unset}|$ATOMIC_SESSION_ID|$ATOMIC_PROVIDER|$ATOMIC_MODEL|$ATOMIC_REASONING_LEVEL|$PI_SESSION_ID|$PI_PROVIDER|$PI_MODEL|$PI_REASONING_LEVEL|$PI_CODING_AGENT"`,
			});

			expect(env.executionOverrides).toMatchObject({
				ATOMIC_SESSION_ID: "dynamic-bash-session",
				ATOMIC_SESSION_FILE: "",
				ATOMIC_PROVIDER: "anthropic",
				ATOMIC_MODEL: "claude-sonnet-4-5",
				ATOMIC_REASONING_LEVEL: "low",
				PI_SESSION_ID: "dynamic-bash-session",
				PI_SESSION_FILE: "",
				PI_PROVIDER: "anthropic",
				PI_MODEL: "claude-sonnet-4-5",
				PI_REASONING_LEVEL: "low",
			});
			expect(result.content).toEqual([
				{
					type: "text",
					text: "|dynamic-bash-session|anthropic|claude-sonnet-4-5|low|dynamic-bash-session|anthropic|claude-sonnet-4-5|low|true",
				},
			]);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	test("builds each default system prompt from current Harness tool metadata", async () => {
		const originalCreate = AgentHarness.create.bind(AgentHarness);
		let configuredSystemPrompt: AgentHarnessOptions["systemPrompt"];
		const createSpy = vi.spyOn(AgentHarness, "create").mockImplementation(async (options) => {
			configuredSystemPrompt = options.systemPrompt;
			return originalCreate(options);
		});
		const session = createSession("dynamic-prompt-session");
		const env = new NodeExecutionEnv({ cwd: "/workspace" });
		try {
			const created = await createCodingAgentHarness({
				session,
				models: createModels(),
				model: getModel("google", "gemini-2.5-flash"),
				env,
			});
			createSpy.mockRestore();
			try {
				const initialPrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(initialPrompt).toContain("- read: Read a path selector.");
				expect(initialPrompt).toContain("- bash: Execute a shell command.");
				expect(initialPrompt).toContain("- edit: Apply source edits with hashline patch input");
				expect(initialPrompt).toContain("- write: Create or overwrite a writable path selector.");
				expect(initialPrompt).toContain("- find: Find filesystem paths by glob.");
				expect(initialPrompt).toContain("- search: Search file contents with regex patterns.");

				await created.harness.setActiveTools(["write"]);
				const writePrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(writePrompt).toContain("- write: Create or overwrite a writable path selector.");
				expect(writePrompt).not.toContain("- read:");
				expect(writePrompt).not.toContain("- bash:");

				const read = (await created.harness.getTools()).find((tool) => tool.name === "read");
				if (!read) throw new Error("Expected the default read tool");
				await created.harness.setTools([read]);
				const readPrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(readPrompt).toContain("- read: Read a path selector.");
				expect(readPrompt).not.toContain("- write:");

				const inspectTool: CodingAgentHarnessTool = {
					name: "inspect",
					label: "inspect",
					description: "Inspect the configured service",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }),
					promptSnippet: "  Inspect\nthe   configured service  ",
					promptGuidelines: ["Use inspect for service diagnostics."],
				};
				await created.harness.setTools([inspectTool]);
				const inspectPrompt = await resolveSystemPrompt(configuredSystemPrompt);
				expect(inspectPrompt).toContain("- inspect: Inspect the configured service");
				expect(inspectPrompt).toContain("Use inspect for service diagnostics.");
			} finally {
				await created.harness.close();
				await env.cleanup();
			}
		} finally {
			createSpy.mockRestore();
		}
	});

	test("omits active custom tools without prompt metadata from the textual tools section", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: [createPromptTool("hidden")],
			activeToolNames: ["hidden"],
		});

		expect(prompt).toContain("Available tools:\n(none)");
		expect(prompt).not.toContain("- hidden:");
		expect(prompt).not.toContain("hidden description");
	});

	test.each([
		[
			"bash",
			"Execute a shell command.",
			"You can inspect ATOMIC_* or PI_* environment variables for current model and session details.",
		],
		[
			"read",
			"Read a path selector.",
			"Use read to inspect file and resource contents; use path selectors for line ranges, raw output, and conflict views.",
		],
		["edit", "Apply source edits with hashline patch input", "Edit carefully."],
		[
			"write",
			"Create or overwrite a writable path selector.",
			"Use write when replacing the full content of a target; use edit for source edits anchored on a hashline snapshot.",
		],
	] as const)(
		"does not infer prompt metadata for a caller-supplied %s replacement",
		(name, builtInSnippet, builtInGuideline) => {
			const prompt = buildCodingAgentHarnessSystemPrompt({
				cwd: "/workspace",
				tools: [createPromptTool(name)],
				activeToolNames: [name],
			});

			expect(prompt).toContain("Available tools:\n(none)");
			expect(prompt).not.toContain(builtInSnippet);
			expect(prompt).not.toContain(builtInGuideline);
		},
	);

	test("builds the default prompt from active tools and resolved prompt resources", () => {
		const prompt = buildCodingAgentHarnessSystemPrompt({
			cwd: "/workspace",
			tools: defaultPromptTools,
			activeToolNames: ["write", "read"],
			systemPromptOptions: {
				contextFiles: [{ path: "/workspace/AGENTS.md", content: "Follow project policy." }],
				skills: [
					{
						name: "review",
						description: "Review server changes",
						filePath: "/skills/review/SKILL.md",
						baseDir: "/skills/review",
						sourceInfo: {
							path: "/skills/review/SKILL.md",
							source: "test",
							scope: "temporary",
							origin: "top-level",
						},
						disableModelInvocation: false,
					},
				],
			},
		});

		expect(prompt).toContain("- write: Create or overwrite a writable path selector.");
		expect(prompt).toContain("- read: Read a path selector.");
		expect(prompt).not.toContain("- bash:");
		expect(prompt).not.toContain("You can inspect ATOMIC_* or PI_* environment variables");
		expect(prompt).toContain('<context_file path="/workspace/AGENTS.md">');
		expect(prompt).toContain("<name>review</name>");
		expect(prompt.indexOf("Use write when replacing the full content")).toBeLessThan(
			prompt.indexOf("Use read to inspect file and resource contents"),
		);
	});

	test("does not exercise AgentHarness v2 paths that reject with HarnessNotImplemented", async () => {
		const originalCreate = AgentHarness.create.bind(AgentHarness);
		let configuredSystemPrompt: AgentHarnessOptions["systemPrompt"];
		const createSpy = vi.spyOn(AgentHarness, "create").mockImplementation(async (options) => {
			configuredSystemPrompt = options.systemPrompt;
			return originalCreate(options);
		});
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session: createSession("reachable-operations-session"),
			models: createModels(),
			model: getModel("google", "gemini-2.5-flash"),
			env,
		});
		createSpy.mockRestore();
		try {
			await expect(created.harness.getLeafId()).resolves.toBeNull();
			await expect(created.harness.getModel()).resolves.toBeDefined();
			await expect(created.harness.getThinkingLevel()).resolves.toBe("off");
			await expect(created.harness.getActiveTools()).resolves.toEqual([
				"read",
				"bash",
				"edit",
				"write",
				"find",
				"search",
			]);
			await expect(created.harness.getTools()).resolves.toHaveLength(6);
			await expect(created.harness.getStreamOptions()).resolves.toEqual({});
			await expect(created.harness.getRetryPolicy()).resolves.toEqual({
				enabled: false,
				maxRetries: 0,
				baseDelayMs: 1000,
			});
			await expect(created.harness.getCompactionSettings()).resolves.toEqual({
				enabled: true,
				reserveTokens: 16384,
				keepRecentTokens: 20000,
			});
			await expect(created.harness.getSteeringMode()).resolves.toBe("one-at-a-time");
			await expect(created.harness.getFollowUpMode()).resolves.toBe("one-at-a-time");
			await expect(resolveSystemPrompt(configuredSystemPrompt)).resolves.toContain(
				"You are an expert coding assistant operating named Atomic",
			);

			const read = (await created.harness.getTools()).find((tool) => tool.name === "read");
			if (!read) throw new Error("Expected the default read tool");
			await expect(read.execute("read-call", { path: "package.json" })).resolves.toBeDefined();
		} catch (error) {
			if (error instanceof HarnessNotImplemented) {
				throw new Error(`Factory reached HarnessNotImplemented.${error.operation}`, { cause: error });
			}
			throw error;
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});
});

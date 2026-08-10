import {
	AgentHarness,
	type AgentHarnessOptions,
	type ExecutionEnv,
	type ExecutionError,
	type FileError,
	type HarnessTool,
	type Result,
} from "@earendil-works/pi-agent-core";
import type { Static, TSchema } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../core/session-manager.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../core/system-prompt.ts";
import { createCodingToolDefinitions, type ToolsOptions } from "../core/tools/index.ts";
import { detectSupportedImageMimeType } from "../utils/mime.ts";

export interface CodingAgentHarnessTool extends HarnessTool {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

type CodingAgentToolDefinition<TParameters extends TSchema, TDetails> = {
	definition: ToolDefinition<TParameters, TDetails>;
	getContext: () => Promise<ExtensionContext>;
};

function createCodingAgentHarnessTool<TParameters extends TSchema, TDetails>(
	options: CodingAgentToolDefinition<TParameters, TDetails>,
): CodingAgentHarnessTool {
	const { definition, getContext } = options;
	return {
		...definition,
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines ? [...definition.promptGuidelines] : undefined,
		execute: async (toolCallId, params, signal, onUpdate) =>
			definition.execute(toolCallId, params as Static<TParameters>, signal, onUpdate, await getContext()),
	};
}

function normalizeBashExecutionError(error: ExecutionError, timeout: number | undefined): Error {
	if (error.code === "aborted") return new Error("aborted", { cause: error });
	if (error.code === "timeout") {
		const message = error.message.startsWith("timeout:") ? error.message : `timeout:${timeout ?? ""}`;
		return new Error(message, { cause: error });
	}
	return error;
}

function unwrapFileResult<TValue>(result: Result<TValue, FileError>): TValue {
	if (result.ok) return result.value;
	throw result.error;
}

function createExecutionEnvToolOptions(
	env: ExecutionEnv,
	commandPrefix: string | undefined,
	sessionFile: string | undefined,
): ToolsOptions {
	return {
		read: {
			operations: {
				readFile: async (path) => Buffer.from(unwrapFileResult(await env.readBinaryFile(path))),
				access: async (path) => {
					const info = unwrapFileResult(await env.fileInfo(path));
					if (info.kind === "directory") throw new Error(`Cannot read directory: ${path}`);
				},
				detectImageMimeType: async (path) =>
					detectSupportedImageMimeType(unwrapFileResult(await env.readBinaryFile(path))),
			},
		},
		bash: {
			commandPrefix,
			operations: {
				exec: async (command, cwd, options) => {
					const envOverrides: Record<string, string> = {};
					for (const [key, value] of Object.entries(options.env ?? {})) {
						if (typeof value === "string") envOverrides[key] = value;
					}
					if (sessionFile === undefined) {
						envOverrides.ATOMIC_SESSION_FILE = "";
						envOverrides.PI_SESSION_FILE = "";
					}
					const result = await env.exec(command, {
						cwd,
						env: envOverrides,
						timeout: options.timeout,
						abortSignal: options.signal,
						onStdout: (chunk) => options.onData(Buffer.from(chunk), "stdout"),
						onStderr: (chunk) => options.onData(Buffer.from(chunk), "stderr"),
					});
					if (!result.ok) throw normalizeBashExecutionError(result.error, options.timeout);
					return { exitCode: result.value.exitCode };
				},
			},
		},
		edit: {
			operations: {
				readFile: async (path) => Buffer.from(unwrapFileResult(await env.readBinaryFile(path))),
				writeFile: async (path, content) => {
					unwrapFileResult(await env.writeFile(path, content));
				},
				access: async (path) => {
					const info = unwrapFileResult(await env.fileInfo(path));
					if (info.kind !== "file" && info.kind !== "symlink")
						throw new Error(`Cannot edit non-file path: ${path}`);
				},
			},
		},
		write: {
			operations: {
				writeFile: async (path, content) => {
					unwrapFileResult(await env.writeFile(path, content));
				},
				mkdir: async (path) => {
					unwrapFileResult(await env.createDir(path));
				},
			},
		},
	};
}

function assertExecutionEnv(env: ExecutionEnv): void {
	if (typeof env?.renameFile !== "function") {
		throw new TypeError("Coding-agent Harness requires ExecutionEnv.renameFile() to be implemented");
	}
}

function createHarnessSessionManager(
	metadataId: string,
	sessionFile: string | undefined,
): Pick<ReadonlySessionManager, "getSessionId" | "getSessionFile"> {
	return {
		getSessionId: () => metadataId,
		getSessionFile: () => sessionFile,
	};
}

export interface CreateCodingAgentHarnessOptions extends Omit<AgentHarnessOptions, "toolContext" | "tools"> {
	env: ExecutionEnv;
	bashCommandPrefix?: string;
	/** Path to the JSONL session file exposed to default bash commands as ATOMIC_SESSION_FILE and PI_SESSION_FILE. */
	sessionFile?: string;
	tools?: CodingAgentHarnessTool[];
	systemPromptOptions?: Omit<BuildSystemPromptOptions, "cwd" | "promptGuidelines" | "selectedTools" | "toolSnippets">;
}

export interface BuildCodingAgentHarnessSystemPromptOptions {
	cwd: string;
	tools: readonly CodingAgentHarnessTool[];
	activeToolNames: readonly string[];
	systemPromptOptions?: CreateCodingAgentHarnessOptions["systemPromptOptions"];
}

export function buildCodingAgentHarnessSystemPrompt(options: BuildCodingAgentHarnessSystemPromptOptions): string {
	const activeTools = options.activeToolNames.flatMap((name) => {
		const tool = options.tools.find((candidate) => candidate.name === name);
		return tool ? [tool] : [];
	});
	const toolSnippets = Object.fromEntries(
		activeTools.flatMap((tool) => {
			const promptSnippet = tool.promptSnippet
				?.replace(/[\r\n]+/g, " ")
				.replace(/\s+/g, " ")
				.trim();
			return promptSnippet ? [[tool.name, promptSnippet]] : [];
		}),
	);
	const promptGuidelines = activeTools.flatMap((tool) => tool.promptGuidelines ?? []);
	return buildSystemPrompt({
		...options.systemPromptOptions,
		cwd: options.cwd,
		selectedTools: activeTools.map((tool) => tool.name),
		toolSnippets,
		promptGuidelines,
	});
}

/**
 * AgentHarness v2 is a configuration scaffold in pi-agent-core 0.84.1. The
 * factory setup reaches `AgentHarness.create` (for a fresh session),
 * `Session.getMetadata`, `getModel`, `getThinkingLevel`, `getTools`,
 * `getActiveTools`, the default system-prompt callback, Atomic tool execution,
 * and `close()` on the returned harness. The returned harness also exposes the
 * implemented state/configuration getters and setters for model, thinking
 * level, active tools, tools, resources, stream options, retry, compaction,
 * steering, and follow-up modes. It does not invoke `prompt`, `skill`,
 * `promptFromTemplate`, `compact`, `navigateTree`, `resume`, `steer`, `followUp`,
 * `nextRun`, `cancelQueued`, `recordUsage`, `abort`, `waitForIdle`,
 * `runWhenIdle`, `peekAction`, `executeAction`, `runToCompletion`, `watch`,
 * `lane`, `createLane`, `lanes`, `watchSession`, `hooks.on`, or `events.on`;
 * those unfinished paths reject with `HarnessNotImplemented` at runtime. A
 * session with existing records also reaches `create.restore`, which is
 * intentionally outside this factory layer.
 */
export async function createCodingAgentHarness(options: CreateCodingAgentHarnessOptions) {
	assertExecutionEnv(options.env);
	const {
		env,
		bashCommandPrefix,
		sessionFile,
		systemPromptOptions,
		tools: providedTools,
		activeToolNames: providedActiveToolNames,
		systemPrompt: providedSystemPrompt,
		...harnessOptions
	} = options;
	let harness: AgentHarness | undefined;
	const getHarness = (): AgentHarness => {
		if (!harness) throw new Error("Coding-agent Harness callback ran before Harness initialization");
		return harness;
	};
	let tools = providedTools;
	if (tools === undefined) {
		const metadata = await options.session.getMetadata();
		const sessionManager = createHarnessSessionManager(metadata.id, sessionFile);
		const getContext = async (): Promise<ExtensionContext> => {
			const currentHarness = getHarness();
			const [model, thinkingLevel] = await Promise.all([
				currentHarness.getModel(),
				currentHarness.getThinkingLevel(),
			]);
			const context = {
				cwd: env.cwd,
				model,
				thinkingLevel,
				// Atomic's default Harness tools only use these two read-only session methods.
				sessionManager: sessionManager as ReadonlySessionManager,
			} satisfies Pick<ExtensionContext, "cwd" | "model" | "thinkingLevel" | "sessionManager">;
			return context as ExtensionContext;
		};
		const toolOptions = createExecutionEnvToolOptions(env, bashCommandPrefix, sessionFile);
		tools = createCodingToolDefinitions(env.cwd, toolOptions).map((definition) =>
			createCodingAgentHarnessTool({ definition, getContext }),
		);
	}
	const activeToolNames = [...(providedActiveToolNames ?? tools.map((tool) => tool.name))];
	const systemPrompt =
		providedSystemPrompt ??
		(async () => {
			const currentHarness = getHarness();
			const [currentTools, currentActiveToolNames] = await Promise.all([
				currentHarness.getTools(),
				currentHarness.getActiveTools(),
			]);
			return buildCodingAgentHarnessSystemPrompt({
				cwd: env.cwd,
				tools: currentTools,
				activeToolNames: currentActiveToolNames,
				systemPromptOptions,
			});
		});
	const created = await AgentHarness.create({
		...harnessOptions,
		tools,
		activeToolNames,
		systemPrompt,
	});
	harness = created.harness;
	return created;
}

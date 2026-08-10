import {
	AgentHarness,
	type AgentHarnessOptions,
	type ExecutionEnv,
	type ExecutionError,
	type FileError,
	type FileInfo,
	type HarnessTool,
	type Result,
} from "@earendil-works/pi-agent-core";
import { minimatch } from "minimatch";
import type { Static, TSchema } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../core/extensions/types.ts";
import type { ReadonlySessionManager } from "../core/session-manager.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "../core/system-prompt.ts";
import type { DirectoryTreeEntry } from "../core/tools/directory-tree.ts";
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

function unsupportedHarnessOperation(operation: string): never {
	throw new Error(`Coding-agent Harness does not provide ${operation}`);
}

async function findExecutionEnvGlob(
	env: ExecutionEnv,
	pattern: string,
	root: string,
	options: { ignore: string[]; limit: number; hidden: boolean },
): Promise<string[]> {
	const matches: string[] = [];
	const normalizedPattern = pattern.replaceAll("\\", "/");
	const matchOptions = { dot: true, matchBase: !normalizedPattern.includes("/") };
	const hasHiddenSegment = (value: string): boolean =>
		value.split("/").some((segment) => segment.startsWith(".") && segment.length > 1);
	const isIgnored = (value: string, isDirectory: boolean): boolean =>
		options.ignore.some(
			(ignorePattern) =>
				minimatch(value, ignorePattern, { dot: true }) ||
				(isDirectory && minimatch(`${value}/__entry__`, ignorePattern, { dot: true })),
		);
	const walk = async (directory: string, prefix: string): Promise<void> => {
		if (matches.length >= options.limit) return;
		const result = await env.listDir(directory);
		if (!result.ok) return;
		const entries = result.value.sort((left, right) => left.name.localeCompare(right.name));
		for (const entry of entries) {
			if (matches.length >= options.limit) return;
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (!options.hidden && hasHiddenSegment(relativePath)) continue;
			const isDirectory = entry.kind === "directory";
			if (isIgnored(relativePath, isDirectory)) continue;
			if (minimatch(relativePath, normalizedPattern, matchOptions))
				matches.push(isDirectory ? `${relativePath}/` : relativePath);
			if (isDirectory) await walk(entry.path, relativePath);
		}
	};
	const rootInfo = await env.fileInfo(root);
	let walkRoot = root;
	if (rootInfo.ok && rootInfo.value.kind === "symlink") {
		const canonical = await env.canonicalPath(root);
		if (canonical.ok) walkRoot = canonical.value;
	}
	await walk(walkRoot, "");
	return matches;
}

async function findExecutionEnvStat(
	env: ExecutionEnv,
	path: string,
): Promise<{ isFile: boolean; isDirectory: boolean } | undefined> {
	const result = await env.fileInfo(path);
	if (!result.ok) return undefined;
	if (result.value.kind !== "symlink") {
		return { isFile: result.value.kind === "file", isDirectory: result.value.kind === "directory" };
	}
	const canonical = await env.canonicalPath(path);
	if (!canonical.ok) return undefined;
	const target = await env.fileInfo(canonical.value);
	if (!target.ok) return undefined;
	return { isFile: target.value.kind === "file", isDirectory: target.value.kind === "directory" };
}

async function toExecutionEnvDirectoryEntry(
	env: ExecutionEnv,
	info: FileInfo,
): Promise<DirectoryTreeEntry | undefined> {
	if (info.kind !== "symlink")
		return {
			name: info.name,
			path: info.path,
			isDirectory: info.kind === "directory",
			mtimeMs: info.mtimeMs,
			size: info.size,
		};
	const canonical = await env.canonicalPath(info.path);
	if (!canonical.ok) return undefined;
	const target = await env.fileInfo(canonical.value);
	if (!target.ok) return undefined;
	return {
		name: info.name,
		path: canonical.value,
		isDirectory: target.value.kind === "directory",
		mtimeMs: target.value.mtimeMs,
		size: target.value.size,
	};
}

async function listExecutionEnvDirectory(env: ExecutionEnv, path: string): Promise<DirectoryTreeEntry[] | undefined> {
	let result = await env.listDir(path);
	if (!result.ok) {
		const info = await env.fileInfo(path);
		if (!info.ok || info.value.kind !== "symlink") return undefined;
		const canonical = await env.canonicalPath(path);
		if (!canonical.ok) return undefined;
		result = await env.listDir(canonical.value);
	}
	if (!result.ok) return undefined;
	const entries = await Promise.all(result.value.map((entry) => toExecutionEnvDirectoryEntry(env, entry)));
	return entries.filter((entry): entry is DirectoryTreeEntry => entry !== undefined);
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
					unwrapFileResult(await env.fileInfo(path));
				},
				stat: (path) => findExecutionEnvStat(env, path),
				listDir: (path) => listExecutionEnvDirectory(env, path),
				detectImageMimeType: async (path) =>
					detectSupportedImageMimeType(unwrapFileResult(await env.readBinaryFile(path))),
			},
		},
		bash: {
			commandPrefix,
			// Atomic's bash tool normally hands operations the full local spawn
			// environment. The injected ExecutionEnv owns the base environment;
			// keep only the session and per-command overlays at this boundary.
			spawnHook: (context) => ({ ...context, env: {} }),
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
		find: {
			operations: {
				exists: async (path) => {
					const result = await env.exists(path);
					return result.ok && result.value;
				},
				stat: (path) => findExecutionEnvStat(env, path),
				glob: (pattern, cwd, globOptions) => findExecutionEnvGlob(env, pattern, cwd, globOptions),
			},
		},
	};
}

function assertExecutionEnv(env: ExecutionEnv): void {
	if (typeof env?.renameFile !== "function") {
		throw new TypeError("Coding-agent Harness requires ExecutionEnv.renameFile() to be implemented");
	}
}

function createHarnessSessionManager(metadataId: string, sessionFile: string | undefined): ReadonlySessionManager {
	return {
		getCwd: () => unsupportedHarnessOperation("sessionManager.getCwd()"),
		// The factory has no local session directory. URL reads still use the session id for cache scope,
		// but skip host-local artifact persistence rather than treating the ExecutionEnv cwd as local storage.
		getSessionDir: () => "",
		usesDefaultSessionDir: () => unsupportedHarnessOperation("sessionManager.usesDefaultSessionDir()"),
		getSessionId: () => metadataId,
		getSessionFile: () => sessionFile,
		getLeafId: () => unsupportedHarnessOperation("sessionManager.getLeafId()"),
		getLeafEntry: () => unsupportedHarnessOperation("sessionManager.getLeafEntry()"),
		getEntry: () => unsupportedHarnessOperation("sessionManager.getEntry()"),
		getLabel: () => unsupportedHarnessOperation("sessionManager.getLabel()"),
		getBranch: () => unsupportedHarnessOperation("sessionManager.getBranch()"),
		getHeader: () => unsupportedHarnessOperation("sessionManager.getHeader()"),
		getEntries: () => unsupportedHarnessOperation("sessionManager.getEntries()"),
		getTree: () => unsupportedHarnessOperation("sessionManager.getTree()"),
		getSessionName: () => unsupportedHarnessOperation("sessionManager.getSessionName()"),
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
 * steering, and follow-up modes. Its default tools route the primary operations
 * for read, bash, edit, write, and find through the injected `ExecutionEnv`;
 * read and edit still use Atomic's local path-variant probes and notebook
 * projection; read also uses local archive, SQLite, and internal-resource
 * selectors, while write still uses local generated-file, shebang, conflict,
 * and resource helpers. Bash validates its cwd locally and uses Atomic's local
 * temp storage for overflow output. URL fetches use the process network and do
 * not persist host-local artifacts in this factory. `search` still uses Atomic's
 * local filesystem/ripgrep pipeline
 * until that tool gains a complete remote operations seam. It does not invoke
 * `prompt`, `skill`,
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
				get ui() {
					return unsupportedHarnessOperation("context.ui");
				},
				mode: "rpc",
				hasUI: false,
				cwd: env.cwd,
				sessionManager,
				get modelRegistry() {
					return unsupportedHarnessOperation("context.modelRegistry");
				},
				model,
				scopedModels: [],
				thinkingLevel,
				isIdle: () => true,
				isProjectTrusted: () => false,
				signal: undefined,
				abort: () => unsupportedHarnessOperation("context.abort()"),
				hasPendingMessages: () => false,
				shutdown: () => unsupportedHarnessOperation("context.shutdown()"),
				getContextUsage: () => undefined,
				compact: () => unsupportedHarnessOperation("context.compact()"),
				getSystemPrompt: () => unsupportedHarnessOperation("context.getSystemPrompt()"),
			} satisfies ExtensionContext;
			return context;
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

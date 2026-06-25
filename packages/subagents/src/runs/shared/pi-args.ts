import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	APP_NAME,
	ENV_CODEX_FAST_MODE,
	getEnvValue,
	type CodexFastModeResolvedSettings,
	type CodexFastModeScope,
} from "@bastani/atomic";
import { encodeNestedPathEnv, parseNestedPathEnv, type NestedPathEntry } from "./nested-path.ts";
import { resolveMcpDirectToolNames } from "./mcp-direct-tool-allowlist.ts";
import { STRUCTURED_OUTPUT_CAPTURE_ENV, STRUCTURED_OUTPUT_SCHEMA_ENV } from "./structured-output.ts";
import type { JsonSchemaObject } from "../../shared/types.ts";
import { MAX_SUBAGENT_NESTING_DEPTH } from "../../shared/types-runtime.ts";

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];
const TASK_ARG_LIMIT = 8000;
export const SUBAGENT_PARENT_MAX_DEPTH = MAX_SUBAGENT_NESTING_DEPTH;
export const PROMPT_RUNTIME_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "subagent-prompt-runtime.ts");
const ENV_PREFIX = APP_NAME.toUpperCase();
export const FANOUT_CHILD_EXTENSION_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "extension", "fanout-child.ts");
export const SUBAGENT_CHILD_ENV = `${ENV_PREFIX}_SUBAGENT_CHILD`;
export const SUBAGENT_ORCHESTRATOR_TARGET_ENV = `${ENV_PREFIX}_SUBAGENT_ORCHESTRATOR_TARGET`;
export const SUBAGENT_RUN_ID_ENV = `${ENV_PREFIX}_SUBAGENT_RUN_ID`;
export const SUBAGENT_CHILD_AGENT_ENV = `${ENV_PREFIX}_SUBAGENT_CHILD_AGENT`;
export const SUBAGENT_CHILD_INDEX_ENV = `${ENV_PREFIX}_SUBAGENT_CHILD_INDEX`;
export const SUBAGENT_FANOUT_CHILD_ENV = `${ENV_PREFIX}_SUBAGENT_FANOUT_CHILD`;
export const SUBAGENT_PARENT_EVENT_SINK_ENV = `${ENV_PREFIX}_SUBAGENT_PARENT_EVENT_SINK`;
export const SUBAGENT_PARENT_CONTROL_INBOX_ENV = `${ENV_PREFIX}_SUBAGENT_PARENT_CONTROL_INBOX`;
export const SUBAGENT_PARENT_ROOT_RUN_ID_ENV = `${ENV_PREFIX}_SUBAGENT_PARENT_ROOT_RUN_ID`;
export const SUBAGENT_PARENT_RUN_ID_ENV = `${ENV_PREFIX}_SUBAGENT_PARENT_RUN_ID`;
export const SUBAGENT_PARENT_CHILD_INDEX_ENV = `${ENV_PREFIX}_SUBAGENT_PARENT_CHILD_INDEX`;
export const SUBAGENT_PARENT_DEPTH_ENV = `${ENV_PREFIX}_SUBAGENT_PARENT_DEPTH`;
export const SUBAGENT_PARENT_PATH_ENV = `${ENV_PREFIX}_SUBAGENT_PARENT_PATH`;
export const SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV = `${ENV_PREFIX}_SUBAGENT_PARENT_CAPABILITY_TOKEN`;
export const SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV = `${ENV_PREFIX}_SUBAGENT_INHERIT_PROJECT_CONTEXT`;
export const SUBAGENT_INHERIT_SKILLS_ENV = `${ENV_PREFIX}_SUBAGENT_INHERIT_SKILLS`;
export const SUBAGENT_INTERCOM_SESSION_NAME_ENV = `${ENV_PREFIX}_SUBAGENT_INTERCOM_SESSION_NAME`;
const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

interface BuildPiArgsInput {
	baseArgs: string[];
	task: string;
	sessionEnabled: boolean;
	sessionDir?: string;
	sessionFile?: string;
	model?: string;
	thinking?: string;
	systemPromptMode?: "append" | "replace";
	inheritProjectContext: boolean;
	inheritSkills: boolean;
	tools?: string[];
	extensions?: string[];
	systemPrompt?: string | null;
	mcpDirectTools?: string[];
	cwd?: string;
	promptFileStem?: string;
	intercomSessionName?: string;
	orchestratorIntercomTarget?: string;
	runId?: string;
	childAgentName?: string;
	childIndex?: number;
	parentEventSink?: string;
	parentControlInbox?: string;
	parentRootRunId?: string;
	parentRunId?: string;
	parentChildIndex?: number;
	parentDepth?: number;
	parentPath?: NestedPathEntry[];
	parentCapabilityToken?: string;
	codexFastModeSettings?: CodexFastModeResolvedSettings;
	codexFastModeScope?: CodexFastModeScope;
	structuredOutput?: {
		schema: JsonSchemaObject;
		schemaPath: string;
		outputPath: string;
	};
}

interface BuildPiArgsResult {
	args: string[];
	env: Record<string, string | undefined>;
	tempDir?: string;
}

export function applyThinkingSuffix(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	const colonIdx = model.lastIndexOf(":");
	if (colonIdx !== -1 && THINKING_LEVELS.includes(model.substring(colonIdx + 1))) return model;
	return `${model}:${thinking}`;
}

function serializeChildCodexFastModeSettings(settings: CodexFastModeResolvedSettings): string {
	return `chat=${settings.chat ? "1" : "0"};workflow=${settings.workflow ? "1" : "0"}`;
}

function mapChildCodexFastModeSettings(
	settings: CodexFastModeResolvedSettings,
	scope: CodexFastModeScope,
): CodexFastModeResolvedSettings {
	return {
		chat: settings[scope],
		workflow: settings.workflow,
	};
}

export function buildPiArgs(input: BuildPiArgsInput): BuildPiArgsResult {
	const args = [...input.baseArgs];

	if (input.sessionFile) {
		fs.mkdirSync(path.dirname(input.sessionFile), { recursive: true });
		args.push("--session", input.sessionFile);
	} else {
		if (!input.sessionEnabled) {
			args.push("--no-session");
		}
		if (input.sessionDir) {
			fs.mkdirSync(input.sessionDir, { recursive: true });
			args.push("--session-dir", input.sessionDir);
		}
	}

	const modelArg = applyThinkingSuffix(input.model, input.thinking);
	if (modelArg) {
		args.push("--model", modelArg);
	}

	const declaredBuiltinTools = input.tools?.filter((tool) => !(tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) ?? [];
	const fanoutAuthorized = declaredBuiltinTools.includes("subagent");
	const toolExtensionPaths: string[] = [];
	if (input.tools !== undefined) {
		const builtinTools = [...declaredBuiltinTools];
		// Path-only extension entries are passed via --extension, not --tools. An
		// extension-only list intentionally emits no --tools flag, so default built-ins
		// remain available; do not synthesize a built-in allowlist just to add
		// structured_output and accidentally make that case restrictive.
		const shouldAutoAllowStructuredOutput = input.structuredOutput
			&& (declaredBuiltinTools.length > 0 || input.tools.length === 0);
		if (shouldAutoAllowStructuredOutput && !builtinTools.includes(STRUCTURED_OUTPUT_TOOL_NAME)) {
			builtinTools.push(STRUCTURED_OUTPUT_TOOL_NAME);
		}
		for (const tool of input.tools) {
			if (!declaredBuiltinTools.includes(tool) && (tool.includes("/") || tool.endsWith(".ts") || tool.endsWith(".js"))) {
				toolExtensionPaths.push(tool);
			}
		}
		if (builtinTools.length > 0) {
			if (input.mcpDirectTools?.length) {
				for (const resolvedTool of resolveMcpDirectToolNames(input.mcpDirectTools, input.cwd)) {
					if (!builtinTools.includes(resolvedTool)) {
						builtinTools.push(resolvedTool);
					}
				}
			}
			args.push("--tools", builtinTools.join(","));
		}
	}

	// Keep the prompt runtime first: schema-backed children get structured_output
	// from this extension before the child session refreshes explicit --tools allowlists.
	const runtimeExtensions = fanoutAuthorized
		? [PROMPT_RUNTIME_EXTENSION_PATH, FANOUT_CHILD_EXTENSION_PATH]
		: [PROMPT_RUNTIME_EXTENSION_PATH];
	if (input.extensions !== undefined) {
		args.push("--no-extensions");
		for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths, ...input.extensions])]) {
			args.push("--extension", extPath);
		}
	} else {
		for (const extPath of [...new Set([...runtimeExtensions, ...toolExtensionPaths])]) {
			args.push("--extension", extPath);
		}
	}

	if (!input.inheritSkills) {
		args.push("--no-skills");
	}

	let tempDir: string | undefined;
	if (input.systemPrompt !== undefined && input.systemPrompt !== null) {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_NAME}-subagent-`));
		const stem = (input.promptFileStem ?? "prompt").replace(/[^\w.-]/g, "_");
		const promptPath = path.join(tempDir, `${stem}.md`);
		fs.writeFileSync(promptPath, input.systemPrompt, { mode: 0o600 });
		args.push(input.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptPath);
	}

	if (input.task.length > TASK_ARG_LIMIT) {
		if (!tempDir) {
			tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `${APP_NAME}-subagent-`));
		}
		const taskFilePath = path.join(tempDir, "task.md");
		fs.writeFileSync(taskFilePath, `Task: ${input.task}`, { mode: 0o600 });
		args.push(`@${taskFilePath}`);
	} else {
		args.push(`Task: ${input.task}`);
	}

	const env: Record<string, string | undefined> = {};
	env[SUBAGENT_CHILD_ENV] = "1";
	env[SUBAGENT_FANOUT_CHILD_ENV] = fanoutAuthorized ? "1" : "0";
	if (input.codexFastModeSettings) {
		env[ENV_CODEX_FAST_MODE] = serializeChildCodexFastModeSettings(
			mapChildCodexFastModeSettings(input.codexFastModeSettings, input.codexFastModeScope ?? "chat"),
		);
	}
	const parentEventSinkEnv = getEnvValue(SUBAGENT_PARENT_EVENT_SINK_ENV);
	const parentControlInboxEnv = getEnvValue(SUBAGENT_PARENT_CONTROL_INBOX_ENV);
	const parentRootRunIdEnv = getEnvValue(SUBAGENT_PARENT_ROOT_RUN_ID_ENV);
	const parentRunIdEnv = getEnvValue(SUBAGENT_PARENT_RUN_ID_ENV);
	const parentChildIndexEnv = getEnvValue(SUBAGENT_PARENT_CHILD_INDEX_ENV);
	const parentDepthEnv = getEnvValue(SUBAGENT_PARENT_DEPTH_ENV);
	const parentPathEnv = getEnvValue(SUBAGENT_PARENT_PATH_ENV);
	const parentCapabilityTokenEnv = getEnvValue(SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV);
	const inheritedNestedRoute = Boolean(parentEventSinkEnv && parentRootRunIdEnv && parentCapabilityTokenEnv);
	const parentRunId = input.parentRunId ?? input.runId ?? (inheritedNestedRoute ? getEnvValue(SUBAGENT_RUN_ID_ENV) : undefined) ?? parentRunIdEnv ?? "";
	const parentChildIndex = input.parentChildIndex !== undefined
		? String(input.parentChildIndex)
		: input.childIndex !== undefined
			? String(input.childIndex)
			: parentChildIndexEnv ?? "";
	const inheritedDepth = Number(parentDepthEnv);
	const unclampedParentDepth = input.parentDepth ?? (inheritedNestedRoute && Number.isFinite(inheritedDepth) ? inheritedDepth + 1 : 1);
	const parentDepth = Math.min(Math.max(1, unclampedParentDepth), SUBAGENT_PARENT_MAX_DEPTH);
	const parentPath = input.parentPath ?? [
		...parseNestedPathEnv(parentPathEnv),
		...(parentRunId ? [{
			runId: parentRunId,
			...(parentChildIndex && /^\d+$/.test(parentChildIndex) ? { stepIndex: Number(parentChildIndex) } : {}),
			...(input.childAgentName ? { agent: input.childAgentName } : {}),
		}] : []),
	];
	env[SUBAGENT_PARENT_EVENT_SINK_ENV] = fanoutAuthorized
		? input.parentEventSink ?? parentEventSinkEnv ?? ""
		: "";
	env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = fanoutAuthorized
		? input.parentControlInbox ?? parentControlInboxEnv ?? ""
		: "";
	env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = fanoutAuthorized
		? input.parentRootRunId ?? parentRootRunIdEnv ?? input.runId ?? ""
		: "";
	env[SUBAGENT_PARENT_RUN_ID_ENV] = fanoutAuthorized ? parentRunId : "";
	env[SUBAGENT_PARENT_CHILD_INDEX_ENV] = fanoutAuthorized ? parentChildIndex : "";
	env[SUBAGENT_PARENT_DEPTH_ENV] = fanoutAuthorized ? String(parentDepth) : "";
	env[SUBAGENT_PARENT_PATH_ENV] = fanoutAuthorized ? encodeNestedPathEnv(parentPath) : "";
	env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = fanoutAuthorized
		? input.parentCapabilityToken ?? parentCapabilityTokenEnv ?? ""
		: "";
	env[SUBAGENT_INHERIT_PROJECT_CONTEXT_ENV] = input.inheritProjectContext ? "1" : "0";
	env[SUBAGENT_INHERIT_SKILLS_ENV] = input.inheritSkills ? "1" : "0";
	if (input.intercomSessionName) {
		env[SUBAGENT_INTERCOM_SESSION_NAME_ENV] = input.intercomSessionName;
	}
	if (input.orchestratorIntercomTarget) {
		env[SUBAGENT_ORCHESTRATOR_TARGET_ENV] = input.orchestratorIntercomTarget;
	}
	if (input.runId) {
		env[SUBAGENT_RUN_ID_ENV] = input.runId;
	}
	if (input.childAgentName) {
		env[SUBAGENT_CHILD_AGENT_ENV] = input.childAgentName;
	}
	if (input.childIndex !== undefined) {
		env[SUBAGENT_CHILD_INDEX_ENV] = String(input.childIndex);
	}
	// Bare MCP_DIRECT_TOOLS is the MCP adapter contract: unset means config defaults, __none__ forces no direct tools.
	if (input.mcpDirectTools?.length) {
		env.MCP_DIRECT_TOOLS = input.mcpDirectTools.join(",");
	} else {
		env.MCP_DIRECT_TOOLS = "__none__";
	}
	if (input.structuredOutput) {
		env[STRUCTURED_OUTPUT_CAPTURE_ENV] = input.structuredOutput.outputPath;
		env[STRUCTURED_OUTPUT_SCHEMA_ENV] = input.structuredOutput.schemaPath;
	}

	return { args, env, tempDir };
}

export const parseParentPathEnv = parseNestedPathEnv;

export function cleanupTempDir(tempDir: string | null | undefined): void {
	if (!tempDir) return;
	try {
		fs.rmSync(tempDir, { recursive: true, force: true });
	} catch {
		// Temp cleanup is best effort.
	}
}

import type { AgentMessage, ThinkingLevel } from "@bastani/atomic-agent-core";
import { getCurrentSystemMessage, getCurrentTools, getSystemMessageText, type SystemMessage } from "@bastani/atomic-ai";
import type { Api, Model } from "@bastani/atomic-ai/compat";
import { type GitToolStatus, getGitStatus, getGitStatusAsync } from "../utils/tools-manager.ts";
import type { AgentSessionInternalSurface as AgentSession } from "./agent-session-methods.ts";
import { getCallableTools } from "./agent-session-nested-tools.js";
import { isSubagentChildSession } from "./agent-session-tasks.js";
import { syncSessionHistoryTool } from "./agent-session-tool-registry.ts";
import { failureDebugFields, reportDebugAsync as reportDebug } from "./debug.ts";
import type { ToolDefinition, ToolInfo } from "./extensions/index.js";
import { legacyWorkflowSection } from "./legacy-workflow-files.js";
import type { SystemPromptSectionsTransform } from "./sdk-types.ts";
import { applyToolModifiers } from "./settings-merge.js";
import { getSkillCatalog } from "./skill-catalog.ts";
import {
	buildSessionMemoryGuideline,
	buildSystemPromptSections,
	diffSystemPromptSections,
	type NormalizedBuildSystemPromptOptions,
	namesSessionFolderInGuidelines,
	normalizeBuildSystemPromptOptions,
} from "./system-prompt.ts";
import {
	isToolDeactivationEntryData,
	TOOL_DEACTIVATION_ENTRY_TYPE,
	type ToolDeactivationEntryData,
} from "./tool-deactivation.ts";
import { applyToolLoadout, isToolDeclarationHidden } from "./tool-loadout.js";
import {
	activatesOnRegistration,
	isMcpToolName,
	isRegisteredToolAllowed,
	isRetiredToolName,
	selectedToolNames,
} from "./tool-selection.ts";
import {
	buildToolStatusReport,
	describeToolSelection,
	type ToolSelectionSource,
	type ToolStatusReport,
} from "./tool-status.js";
import {
	forkToolDeclarations,
	hasTransformedPrompt,
	nextTransformedPromptRecord,
	type SystemMessageWithTransformedPrompt,
	type TransformedPromptFork,
	type TransformedPromptRecord,
	toolChangeSupport,
	transformedPromptOwner,
} from "./transformed-system-prompt.ts";

export function getActiveToolNames(this: AgentSession): string[] {
	return this.agent.state.tools.map((t) => t.name);
}

export function getCallableToolNames(this: AgentSession): string[] {
	return getCallableTools(this).map((tool) => tool.name);
}

/**
 * Get all configured tools with name, description, parameter schema, and source metadata.
 */

export function getAllTools(this: AgentSession): ToolInfo[] {
	const removed = this.settingsManager.getDefaultToolRemovals(this._defaultToolModifiers);
	return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		...(Object.hasOwn(definition, "constrainedSampling")
			? { constrainedSampling: definition.constrainedSampling }
			: {}),
		promptGuidelines: definition.promptGuidelines,
		exposure: definition.exposure ?? "direct",
		namespace: definition.namespace,
		...(removed.has(definition.name) ? { explicitDefaultOptOut: true } : {}),
		annotations: definition.annotations,
		sourceInfo,
	}));
}

export function getToolDefinition(this: AgentSession, name: string): ToolDefinition | undefined {
	return this._toolDefinitions.get(name)?.definition;
}

function toolSelectionSource(session: AgentSession): ToolSelectionSource {
	if (session._usesDefaultTools) {
		return session.settingsManager.getDefaultToolsWith([]) === undefined
			? "built-in-defaults"
			: "default-tools-setting";
	}
	if (session._allowedToolNames) return session._allowedToolNames.size === 0 ? "no-tools" : "tools-allowlist";
	return (session._initialActiveToolNames?.length ?? 0) > 0 ? "explicit-selection" : "no-built-in-tools";
}

/**
 * Explain every registered tool (active or not, and why), where the tool selection came from,
 * and which selected names nothing registered. Format it with `formatToolStatus()`.
 */
export function getToolStatus(this: AgentSession): ToolStatusReport {
	return toolStatusReport(this, getGitStatus());
}

export async function getToolStatusAsync(this: AgentSession): Promise<ToolStatusReport> {
	const git = await getGitStatusAsync();
	return toolStatusReport(this, git);
}

/**
 * The same report without its Git section, which only running git can fill: for the startup notice of unavailable
 * tools, which reads nothing else than `missing`.
 */
export function _getToolStatusWithoutGit(this: AgentSession): ToolStatusReport {
	return toolStatusReport(this, undefined);
}

function toolStatusReport(session: AgentSession, git: GitToolStatus | undefined): ToolStatusReport {
	const source = toolSelectionSource(session);
	const modifiers = [...session._defaultToolModifiers];
	return buildToolStatusReport({
		tools: [...session._toolDefinitions.values()],
		activeToolNames: session.getActiveToolNames(),
		selection: {
			source,
			description: describeToolSelection(source, modifiers),
			names: [...selectedToolNames(session)],
			modifiers,
		},
		isExcluded: session._excludedTools,
		isAllowed: session._allowedTools,
		recordedActiveNames: recordedToolLoadout(session)?.current.filter(
			(name) =>
				!isMcpToolName(name) &&
				!isRetiredToolName(name) &&
				(!session._resourceLoader.getInheritanceSnapshot?.().noExtensions ||
					session._baseToolDefinitions.has(name)) &&
				(!session._usesDefaultTools || applyToolModifiers([name], session._defaultToolModifiers).includes(name)),
		),
		git,
	});
}

/**
 * Set active tools by name.
 * Only tools in the registry can be enabled. Unknown tool names are ignored.
 * Also rebuilds the system prompt to reflect the new tool set.
 * Changes take effect on the next agent turn.
 */

export function setActiveToolsByName(this: AgentSession, toolNames: string[]): void {
	const previous = this.getActiveToolNames();
	this._setActiveTools(toolNames);
	const active = new Set(this.getActiveToolNames());
	const deactivated = previous.filter((name) => !active.has(name));
	for (const name of deactivated) this._explicitToolDeactivations.add(name);
	if (deactivated.some((name) => this._restoredToolNames.has(name))) {
		this._pendingToolNames.clear();
	}
}

/**
 * Whether the session's own tool selection leaves `name` out: a `--tools` allowlist, `--no-tools`, `--exclude-tools`, or
 * a `-name` modifier. Like a call to `setActiveTools`, that is the user's choice, so it persists across a later resume
 * as it does in upstream pi (#4660).
 */
function isLeftOutBySelection(session: AgentSession, name: string): boolean {
	return (
		!isRegisteredToolAllowed(session, name) ||
		(session._usesDefaultTools && !applyToolModifiers([name], session._defaultToolModifiers).includes(name))
	);
}

/** After a system message is saved, record which of its removals were explicit deactivations (#4660). */
export async function recordExplicitToolDeactivations(session: AgentSession, message: SystemMessage): Promise<void> {
	const tools = (message.toolsRemoved ?? [])
		.map((tool) => tool.name)
		.filter((name) => session._explicitToolDeactivations.has(name) || isLeftOutBySelection(session, name));
	if (tools.length === 0) return;
	const data: ToolDeactivationEntryData = { tools };
	try {
		await session.sessionManager.appendCustomEntry(TOOL_DEACTIVATION_ENTRY_TYPE, data);
	} catch (error) {
		// The turn goes on. The names stay pending, so the next system message records them again; if the session
		// ends first, the tools come back on resume, which is the safe direction.
		reportDebug("storage", "tool-deactivation-not-recorded", failureDebugFields(error));
		return;
	}
	for (const name of tools) session._explicitToolDeactivations.delete(name);
}

export function _setActiveTools(this: AgentSession, toolNames: string[]): void {
	const tools = applyToolLoadout(this, syncSessionHistoryTool(this, toolNames));
	for (const tool of tools) {
		this._pendingToolNames.delete(tool.name);
		this._explicitToolDeactivations.delete(tool.name);
	}
	this._rebuildSystemPrompt(tools.map((tool) => tool.name));
}

/** Whether compaction or branch summarization is currently running */

export function setScopedModels(
	this: AgentSession,
	scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>,
): void {
	this._scopedModels = scopedModels;
}

/** File-based prompt templates */

export function _normalizePromptSnippet(this: AgentSession, text: string | undefined): string | undefined {
	if (!text) return undefined;
	const oneLine = text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
	return oneLine.length > 0 ? oneLine : undefined;
}

export function _normalizePromptGuidelines(this: AgentSession, guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) {
		return [];
	}

	const unique = new Set<string>();
	for (const guideline of guidelines) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			unique.add(normalized);
		}
	}
	return Array.from(unique);
}

/** What a session in partly restored or unrestored checkouts is told about them (#4738). */
function worktreeRestoreSection(notices: readonly string[]): string {
	return [
		"This work resumed on a machine that could not restore every checkout exactly as it was recorded:",
		...notices.map((notice) => `- ${notice}`),
		"Work with the files that are here. When something listed as not restored matters to the task, say so in your answer rather than recreating it from memory.",
	].join("\n");
}

export function _rebuildSystemPrompt(this: AgentSession, toolNames: string[]): void {
	const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
	const toolSnippets: Record<string, string> = {};
	for (const name of this._toolRegistry.keys()) {
		const snippet = this._toolPromptSnippets.get(name);
		if (snippet) {
			toolSnippets[name] = snippet;
		}
	}

	const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
	const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
	const appendSystemPrompt = loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
	const loadedSkills = getSkillCatalog(this._resourceLoader).modelSkills();
	const loadedContextFiles = this._resourceLoader.getAgentsFiles().agentsFiles;
	const legacyWorkflows = isSubagentChildSession(this)
		? undefined
		: legacyWorkflowSection(this._resourceLoader.getLegacyWorkflowFiles?.());
	const previousBase = this._baseSystemPromptOptions;
	const previousForcedPrompt = previousBase?.forceSystemPrompt;
	const hiddenTools = validToolNames.filter((name) => isToolDeclarationHidden(this, name));
	// A session keeps naming its session folder where its recorded prompt does.
	const sessionFolderInGuidelines = namesSessionFolderInGuidelines(
		getCurrentSystemMessage(this.agent.state.messages),
		Boolean(loaderSystemPrompt),
	);
	const subagentSessionMemory =
		this._subagentPolicy !== undefined && loaderSystemPrompt
			? buildSessionMemoryGuideline(
					validToolNames.filter((name) => !hiddenTools.includes(name)),
					this._cwd,
					sessionFolderInGuidelines ? "guideline" : "section",
				)
			: undefined;

	this._baseSystemPromptOptions = normalizeBuildSystemPromptOptions({
		cwd: this._cwd,
		selectedModel: this.model,
		selectedThinkingLevel: this.thinkingLevel,
		skills: loadedSkills,
		contextFiles: loadedContextFiles,
		customPrompt: loaderSystemPrompt,
		appendSystemPrompt,
		selectedTools: validToolNames,
		hiddenTools,
		excludedTools: this._excludedToolNames ? Array.from(this._excludedToolNames) : undefined,
		toolSnippets,
		toolGuidelines: Object.fromEntries(this._toolPromptGuidelines),
		sections: {
			...(legacyWorkflows === undefined ? {} : { legacy_workflow_files: legacyWorkflows }),
			...(subagentSessionMemory === undefined ? {} : { session_memory: `- ${subagentSessionMemory}` }),
			...(this._worktreeRestoreNotices.length === 0
				? {}
				: { worktree_restore: worktreeRestoreSection(this._worktreeRestoreNotices) }),
		},
		...(sessionFolderInGuidelines ? { sessionFolderInGuidelines: true } : {}),
	});
	if (this._systemPromptTransform) {
		const sections = buildSystemPromptSections(this._baseSystemPromptOptions);
		const content = this._systemPromptTransform(
			getSystemMessageText({ role: "system", content: "", sections, timestamp: 0 }),
		);
		this._baseSystemPromptOptions.forceSystemPrompt = content;
		this._transformedPromptHead = this._systemPromptSections
			? { content, sections: this._systemPromptSections.transform(sections) }
			: undefined;
	}
	// A model switch partway through a run, such as a fallback, must tell the next request which model it goes to
	// (#4188). A running turn whose prompt is still this session's own transformed prompt takes the rebuilt one. A prompt
	// a `before_agent_start` handler built stays the handler's, with the model section it kept from the old prompt
	// brought up to date.
	const run = this._runSystemPromptOptions;
	const runPrompt = run?.forceSystemPrompt;
	if (run && runPrompt !== undefined) {
		const base = this._baseSystemPromptOptions;
		const previousModelSection = previousBase ? buildSystemPromptSections(previousBase).model : undefined;
		const modelSection = buildSystemPromptSections(base).model;
		const forceSystemPrompt =
			previousForcedPrompt !== undefined && runPrompt === previousForcedPrompt
				? base.forceSystemPrompt
				: previousModelSection && modelSection && previousModelSection !== modelSection
					? runPrompt.split(previousModelSection).join(modelSection)
					: runPrompt;
		if (forceSystemPrompt !== runPrompt) {
			this._runSystemPromptOptions = {
				...run,
				forceSystemPrompt,
				selectedModel: base.selectedModel,
				selectedThinkingLevel: base.selectedThinkingLevel,
			};
		}
	}
}

export function _refreshBaseSystemPromptFromActiveTools(this: AgentSession): void {
	this._rebuildSystemPrompt(this.getActiveToolNames());
}

/**
 * Remember the names of the sections the `before_agent_start` handlers of the prompt being sent set, replaced or
 * removed relative to the base options (`options` is what the handlers returned), for the runs that start without a
 * prompt until the next prompt is sent; see `_currentRunSystemPromptOptions`.
 */
export function recordPromptSections(session: AgentSession, options: NormalizedBuildSystemPromptOptions): void {
	const base = session._baseSystemPromptOptions.sections ?? {};
	const sections = options.sections ?? {};
	const names = [...new Set([...Object.keys(base), ...Object.keys(sections)])].filter(
		(name) => (sections[name] || undefined) !== (base[name] || undefined),
	);
	session._promptSectionNames =
		names.length > 0 ? { runner: session._extensionRunner, names: new Set(names) } : undefined;
}

/**
 * The base options with the sections the latest sent prompt's handlers own as the conversation last had them: present
 * with its content, or absent. A run that starts without a prompt prepares its turns from these, so that it leaves
 * those sections as they are, and follows the base options for every other part of the prompt.
 */
function withPromptSections(session: AgentSession): NormalizedBuildSystemPromptOptions {
	const base = session._baseSystemPromptOptions;
	const recorded = session._promptSectionNames;
	if (!recorded || recorded.runner !== session._extensionRunner) return base;
	const current = getCurrentSystemMessage(session.agent.state.messages)?.sections ?? {};
	const sections: Record<string, string> = { ...base.sections };
	for (const name of recorded.names) {
		delete sections[name];
		const text = current[name];
		const open = `<${name}>\n`;
		const close = `\n</${name}>`;
		if (text?.startsWith(open) && text.endsWith(close)) sections[name] = text.slice(open.length, -close.length);
	}
	return { ...base, sections };
}

/**
 * The run's system prompt options brought up to date with the session's current model, thinking level and tools. A run
 * that started without a prompt has the base options with the sections the latest sent prompt's handlers own as the
 * conversation last had them (see withPromptSections), so that its turns neither take them out of the prompt nor bring
 * back ones they removed.
 */
export function _currentRunSystemPromptOptions(this: AgentSession): NormalizedBuildSystemPromptOptions {
	const runOptions = this._runSystemPromptOptions ?? withPromptSections(this);
	return normalizeBuildSystemPromptOptions({
		...runOptions,
		selectedModel: this.model,
		selectedThinkingLevel: this.thinkingLevel,
		selectedTools: this.getActiveToolNames(),
		toolSnippets: { ...this._baseSystemPromptOptions.toolSnippets, ...runOptions.toolSnippets },
		toolGuidelines: { ...this._baseSystemPromptOptions.toolGuidelines, ...runOptions.toolGuidelines },
	});
}

/**
 * Record the system prompt change a model switch between two requests of a run makes, such as a fallback. The next
 * request is built from the transcript, and a continuation does not prepare a turn first, so without this record the
 * new model is told it is the old one (#4223).
 */
export async function _recordSystemPromptForModelSwitch(this: AgentSession): Promise<void> {
	const options = this._currentRunSystemPromptOptions();
	const update = this._preparePromptAndToolLoadout(options);
	if (this._runSystemPromptOptions) this._runSystemPromptOptions = options;
	if (!update) return;
	await this.sessionManager.appendMessage(update);
	this._refreshFinalizedContext();
}

/** Diff structured prompt state; executable tool changes are declared by the agent loop. */
export function _preparePromptAndToolLoadout(
	this: AgentSession,
	options: NormalizedBuildSystemPromptOptions,
	messages: AgentMessage[] = this.agent.state.messages,
): SystemMessage | undefined {
	const current = getCurrentSystemMessage(messages);
	options.sessionFolderInGuidelines = namesSessionFolderInGuidelines(current, Boolean(options.customPrompt));
	const selected = [...new Set(options.selectedTools)].filter((name) => this._toolRegistry.has(name));
	const recorded = (current?.toolsAdded ?? []).map((tool) => tool.name).filter((name) => selected.includes(name));
	options.selectedTools = [...recorded, ...selected.filter((name) => !recorded.includes(name))];
	options.selectedTools = applyToolLoadout(this, options.selectedTools).map((tool) => tool.name);
	options.hiddenTools = options.selectedTools.filter((name) => isToolDeclarationHidden(this, name));
	const sections = diffSystemPromptSections(current?.sections ?? {}, buildSystemPromptSections(options));
	const transformedPrompt = nextTransformedPrompt(this, messages);
	if (!sections && !transformedPrompt) return undefined;
	const update: SystemMessageWithTransformedPrompt = {
		role: "system",
		content: "",
		...(sections ? { sections } : {}),
		...(transformedPrompt ? { transformedPrompt } : {}),
		timestamp: Date.now(),
	};
	return update;
}

/**
 * The transformed prompt record the next request adds: the prompt `_rebuildSystemPrompt` built when no row sent one,
 * otherwise the sections of the session's current prompt that changed since it was last told them.
 */
function nextTransformedPrompt(
	session: AgentSession,
	messages: readonly AgentMessage[],
): TransformedPromptRecord | undefined {
	const sections = session._systemPromptSections;
	const head = session._transformedPromptHead;
	if (!sections || !head) return undefined;
	return nextTransformedPromptRecord(
		messages,
		transformedPromptOwner(session.sessionManager.getSessionId(), sections.key),
		head,
		sections.transform(buildSystemPromptSections(session._baseSystemPromptOptions)),
		sections.fork && forkOf(session, messages, sections.fork),
	);
}

/** The conversation a fork continues, as the model was told it, and the note that opens what the fork adds. */
function forkOf(
	session: AgentSession,
	messages: readonly AgentMessage[],
	fork: NonNullable<SystemPromptSectionsTransform["fork"]>,
): TransformedPromptFork {
	const hidden = new Set(fork.hiddenTools ?? []);
	const inherited = getCurrentTools(messages).filter((tool) => !hidden.has(tool.name));
	const callable = session.getActiveToolNames();
	const { throughCodemode } = forkToolDeclarations(inherited, toolChangeSupport(session.model?.compat), callable);
	const declared = new Set(inherited.map((tool) => tool.name));
	const sections = Object.entries(getCurrentSystemMessage(messages)?.sections ?? {}).flatMap(([name, text]) =>
		text === null ? [] : [[name, text] as const],
	);
	return {
		sections: Object.fromEntries(sections),
		...(fork.hiddenTools?.length ? { hidden: fork.hiddenTools } : {}),
		note: fork.note({
			tools: callable,
			throughCodemode: throughCodemode ? callable.filter((name) => !declared.has(name)) : [],
		}),
	};
}

/**
 * Record the transformed prompt before a run that starts without a prompt, such as a woken child's continued turn, when
 * no row has sent it yet: a session last run by an earlier version then keeps the prompt its first request sends.
 */
export function _recordTransformedPromptHead(this: AgentSession): Promise<void> | undefined {
	const messages = this.agent.state.messages;
	const sections = this._systemPromptSections;
	if (
		!sections ||
		messages.length === 0 ||
		hasTransformedPrompt(messages, transformedPromptOwner(this.sessionManager.getSessionId(), sections.key))
	)
		return undefined;
	const transformedPrompt = nextTransformedPrompt(this, messages);
	if (!transformedPrompt) return undefined;
	const update: SystemMessageWithTransformedPrompt = {
		role: "system",
		content: "",
		transformedPrompt,
		timestamp: Date.now(),
	};
	return this.sessionManager.appendMessage(update).then(() => this._refreshFinalizedContext());
}

export function preservesInitialToolLoadout(session: AgentSession): boolean {
	return (
		(!session._usesDefaultTools && session._initialActiveToolNames !== undefined) ||
		(session._subagentPolicy?.depth ?? 0) >= 1
	);
}

/** The tools the selected transcript records, every tool it ever added or removed, and the removals made on purpose. */
export interface RecordedToolLoadout {
	readonly current: readonly string[];
	readonly mentioned: ReadonlySet<string>;
	/** Removed tools whose latest removal was an explicit deactivation; see {@link TOOL_DEACTIVATION_ENTRY_TYPE}. */
	readonly explicitlyRemoved: ReadonlySet<string>;
}

/** The recorded loadout of the selected branch, or undefined when it recorded none. */
export function recordedToolLoadout(session: AgentSession): RecordedToolLoadout | undefined {
	// All system messages on the branch, including those before a compaction, whose snapshot lists only
	// the tools still added. Replaying them gives the current loadout and every tool the branch mentioned.
	const systemMessages: SystemMessage[] = [];
	const explicitlyRemoved = new Set<string>();
	for (const entry of session.sessionManager.getBranch()) {
		const message =
			entry.type === "message" && entry.message.role === "system"
				? entry.message
				: entry.type === "compaction"
					? entry.systemMessage
					: undefined;
		if (message) {
			systemMessages.push(message);
			for (const tool of message.toolsAdded ?? []) explicitlyRemoved.delete(tool.name);
		} else if (
			entry.type === "custom" &&
			entry.customType === TOOL_DEACTIVATION_ENTRY_TYPE &&
			isToolDeactivationEntryData(entry.data)
		) {
			for (const name of entry.data.tools) explicitlyRemoved.add(name);
		}
	}
	if (systemMessages.length === 0) return undefined;
	return {
		current: getCurrentTools(systemMessages).map((tool) => tool.name),
		mentioned: new Set(
			systemMessages
				.flatMap((message) => [...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])])
				.map((tool) => tool.name),
		),
		explicitlyRemoved,
	};
}

/** Although registered by an extension, the bundled codemode follows the user's built-in selection on restore. */
function followsBuiltinSelection(
	session: AgentSession,
	name: string,
	sourcePath = session._toolDefinitions.get(name)?.sourceInfo.path,
): boolean {
	return session._baseToolDefinitions.has(name) || (name === "codemode" && sourcePath === "builtin:codemode");
}

/**
 * Whether restoring a transcript activates a registered tool its recorded loadout does not list.
 *
 * A tool the branch never mentioned was registered after the branch recorded its loadout, so it activates like a
 * newly registered tool. A tool the branch removed without an explicit deactivation was removed only because it was
 * not registered when a turn started, for example while its extension was still loading or had failed to load, so it
 * activates as it would in a fresh session (#4660). Built-in tools follow the session's default tool selection, and
 * opt-in tools stay inactive until a selection names them.
 */
export function activatesAfterRecordedLoadout(
	session: AgentSession,
	recorded: RecordedToolLoadout,
	name: string,
	definition: { exposure?: string; defaultActive?: boolean } | undefined,
	sourcePath?: string,
): boolean {
	if (followsBuiltinSelection(session, name, sourcePath)) {
		return (
			recorded.mentioned.has(name) &&
			!recorded.current.includes(name) &&
			!recorded.explicitlyRemoved.has(name) &&
			session._usesDefaultTools &&
			session._appliedDefaultTools.has(name)
		);
	}
	return (
		!recorded.current.includes(name) &&
		!recorded.explicitlyRemoved.has(name) &&
		activatesOnRegistration(session, name, definition, false)
	);
}

/**
 * Restore registered tools from the selected transcript, not another branch's live state.
 *
 * Explicit tool selections keep their built-in loadout while restoring dynamically registered tools.
 * Default selections restore the recorded loadout with any CLI modifiers applied. Extension tools the
 * branch never added or removed were registered after it recorded its loadout, so they are activated
 * like newly registered tools.
 */
export function _restoreToolsFromTranscript(this: AgentSession, options?: { startup?: boolean }): void {
	this._pendingToolNames.clear();
	this._restoredToolNames.clear();
	const recorded = recordedToolLoadout(this);
	// No recorded loadout: keep the current tools.
	if (!recorded) return;
	const keepLoadout = options?.startup && preservesInitialToolLoadout(this);
	const modifiers = options?.startup && this._usesDefaultTools ? this._defaultToolModifiers : [];
	this._restoredToolNames = new Set(applyToolModifiers([...recorded.current], modifiers));
	// Removed tools are mentioned too, so they stay inactive.
	const newTools = [...this._toolRegistry.keys()].filter((name) =>
		activatesAfterRecordedLoadout(this, recorded, name, this._toolDefinitions.get(name)?.definition),
	);
	const declared = applyToolModifiers([...recorded.current, ...newTools], modifiers);
	if (!keepLoadout) {
		this._pendingToolNames = new Set(declared);
		this._setActiveTools(declared);
		return;
	}
	const restored = declared.filter((name) => !followsBuiltinSelection(this, name));
	this._pendingToolNames = new Set(restored);
	this._setActiveTools(applyToolModifiers([...this.getActiveToolNames(), ...restored], modifiers));
}

// =========================================================================
// Prompting
// =========================================================================

/**
 * Send a prompt to the agent.
 * - Handles extension commands (registered via pi.registerCommand) immediately, even during streaming
 * - Expands file-based prompt templates by default
 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
 * - Validates model and API key before sending (when not streaming)
 * @throws Error if streaming and no streamingBehavior specified
 * @throws Error if no model selected or no API key available (when not streaming)
 */

export const agentSessionStateMethods = {
	getActiveToolNames,
	getCallableToolNames,
	getAllTools,
	getToolDefinition,
	getToolStatus,
	getToolStatusAsync,
	_getToolStatusWithoutGit,
	setActiveToolsByName,
	_setActiveTools,
	setScopedModels,
	_normalizePromptSnippet,
	_normalizePromptGuidelines,
	_rebuildSystemPrompt,
	_recordTransformedPromptHead,
	_preparePromptAndToolLoadout,
	_restoreToolsFromTranscript,
	_refreshBaseSystemPromptFromActiveTools,
	_currentRunSystemPromptOptions,
	_recordSystemPromptForModelSwitch,
};

import { isProxy } from "node:util/types";
import type { AssistantMessage, Usage } from "@bastani/atomic-ai/compat";
import { type HistoryLeaf, type TUI, WindowedContainer } from "@bastani/atomic-tui";
import { CONFIG_DIR_NAME } from "../../config.js";
import type { AgentSessionEvent } from "../../core/agent-session.js";
import {
	advanceCacheHistory,
	cacheMissAfter,
	createCacheMissModelSource,
	formatCacheMissNotice,
	type ModelPriceSource,
	type PreviousRequest,
} from "../../core/cache-stats.ts";
import { markLifecycleTiming } from "../../core/lifecycle-timings.ts";
import {
	isVerbatimCompactionMessage,
	normalizeMessageContent,
	stripVerbatimCompactionPrefix,
} from "../../core/messages.ts";
import { projectTrustWarningVisible } from "../../core/project-trust-state.ts";
import { serviceTierWarnings } from "../../core/service-tier-warnings.ts";
import type { CustomEntry } from "../../core/session-manager.ts";
import { buildContextEntries, type SessionEntry } from "../../core/session-manager.ts";
import { sessionEntryToDisplayMessages } from "../../core/session-manager-history.ts";
import { chatPosition } from "../../core/storage/session/chat-records.js";
import { getOwnerTaskStore } from "../../core/tasks/owner-store.js";
import { ReopenedCompletionHeaders } from "../../core/tasks/reopened-completion.js";
import { taskTranscriptSource } from "../../core/tasks/supervisor.js";
import { readTaskCompletionHistory } from "../../core/tasks/task-completion-history.js";
import {
	carryRowSource,
	noteRowSource,
	noteSavedSeq,
	savedRowKey,
	savedSeqOf,
} from "../../core/tasks/transcript-origin.js";
import { userMessageOrigin } from "../../core/user-message-origin.js";
import { yieldToEventLoop } from "../../utils/event-loop.ts";
import { IsolatedInteractiveRuntime } from "../interactive-engine/isolated-runtime.js";
import {
	disposeRemoteRenderers,
	RemoteCustomMessageComponent,
	RemoteToolExecutionComponent,
} from "../interactive-engine/remote-renderer.ts";
import { appendBoundedStderr } from "../rpc/rpc-client-process.js";
import { messageComponents, statusComponents } from "./chat-message-count.ts";
import { bindChatLayout, ChatReaderLayout, chatDecorationRow } from "./chat-reader-layout.js";
import {
	CHAT_RECORD_FIRST_PAINT_MS,
	type ChatPageDecorations,
	readMountedAnchors,
	retainChatRecords,
	sessionChatMount,
} from "./chat-reader-records.js";
import { addMainPromptHistory } from "./components/agent-prompt-history.ts";
import {
	applyToolEntryState,
	callsAwaitingLaterResults,
	isResultWithoutCall,
} from "./components/chat-message-renderer.ts";
import { extractMessageText } from "./components/chat-session-host-utils.ts";
import { CustomEntryComponent } from "./components/custom-entry.ts";
import type { NewMessageCounter } from "./components/jump-to-latest.ts";
import { createMarkdownTransform } from "./components/markdown-transform.ts";
import { createMermaidMarkdownTransformer } from "./components/mermaid.ts";
import { ThemedText } from "./components/themed-text.js";
import type { ToolGroupRole } from "./components/tool-block.ts";
import {
	assistantCallBreaks,
	type ToolGroupHead,
	type ToolGroupMemberState,
	type ToolGroupRoleSink,
	ToolGroupTracker,
} from "./components/tool-group-tracker.ts";
import { isClickExpandableBlock } from "./components/transcript-block-clicks.ts";
import { appendNewChildrenBeforeAttachedChild } from "./interactive-child-ordering.ts";
import {
	countChatMessages,
	type DeferredUserInputEcho,
	InteractiveModeBase,
	isChatMessageComponent,
} from "./interactive-mode-base.ts";
import {
	type AgentMessage,
	APP_NAME,
	AssistantMessageComponent,
	addChatTranscriptEntry,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	type ChatMessageEntry,
	type ChatMessageRenderOptions,
	CompactionBoundaryMessageComponent,
	type Component,
	Container,
	CustomMessageComponent,
	chatEntriesFromAgentMessages,
	getChangelogPath,
	hasTrustRequiringProjectResourcesAsync,
	Markdown,
	type Message,
	needsChangelogPreload,
	type PersistedMessageMeta,
	parseSkillBlock,
	preloadChangelog,
	recordTimeSinceReset,
	renderChatMessageEntry,
	type SessionContext,
	SkillInvocationMessageComponent,
	Spacer,
	Text,
	ToolExecutionComponent,
	type TruncationResult,
	theme,
	UserMessageComponent,
	VERSION,
	type VerbatimCompactionResult,
} from "./interactive-mode-deps.ts";
import {
	holdCompactionWidgets,
	installSavedChatHistory,
	noteShownContext,
	type ParkedViewport,
	parkViewport,
	releaseSavedChatHistory,
	type SavedCopyDraw,
	type SavedPageEarlier,
	type SavedPageRecords,
	type SavedRendererInstances,
	storedWidget,
	widgetKey,
} from "./interactive-saved-chat-history.js";
import { followChosenExpansion, SavedPageCallsBuilder } from "./interactive-saved-tool-calls.ts";
import { StartupChatContainer, trackChatHistoryBuild } from "./interactive-startup-chat-container.ts";
import type { InteractiveSubmission } from "./interactive-submission.ts";
import { refreshInteractiveTasks } from "./interactive-task-projection.js";
import {
	nextStartedRunEcho,
	STARTED_RUN_ECHO_SENT,
	type StartedRunEchoEvent,
	startedRunEchoEvent,
} from "./started-run-echo.ts";

function countDroppedThinkingBlocks(message: AssistantMessage): number {
	return (message.diagnostics ?? []).reduce((count, diagnostic) => {
		if (diagnostic.type !== "anthropic_input_transformations") return count;
		const dropped = diagnostic.details?.droppedBlockCount;
		return count + (typeof dropped === "number" && dropped > 0 ? dropped : 0);
	}, 0);
}

function addServiceTierWarnings(mode: InteractiveModeBase, message: AssistantMessage): void {
	for (const warning of serviceTierWarnings(message)) {
		mode.chatContainer.addChild(new Spacer(1));
		mode.chatContainer.addChild(new Text(theme.fg("warning", `Warning: ${warning}`), 1, 0));
	}
}

InteractiveModeBase.prototype.maybeShowAssistantDiagnostics = function (
	this: InteractiveModeBase,
	message: AssistantMessage,
): void {
	addServiceTierWarnings(this, message);
	if (!this.settingsManager.getShowCacheMissNotices()) return;

	const count = countDroppedThinkingBlocks(message);
	if (count === 0) return;
	let previousCount = 0;
	// The local host has already committed this occurrence; the isolated mirror may still end at its predecessor.
	const publishing = this.session?.publishingReplyId?.(message);
	const branch = this.sessionManager.getBranch();
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type === "message" && entry.message.role === "assistant" && entry.id !== publishing) {
			previousCount = countDroppedThinkingBlocks(entry.message);
			break;
		}
	}
	addThinkingDrop(this, count, previousCount);
};

function addThinkingDrop(mode: InteractiveModeBase, count: number, previousCount: number): void {
	if (count <= previousCount) return;
	const noun = count === 1 ? "thinking block" : "thinking blocks";
	mode.chatContainer.addChild(new Spacer(1));
	mode.chatContainer.addChild(
		new Text(theme.fg("warning", `Anthropic dropped ${count} ${noun} (details in session)`), 1, 0),
	);
}

// Weak keys leave cleared/rebuilt transcripts collectible without separate lifecycle state.
// Only persistent diagnostic statuses participate; ordinary chat/status is never evicted.
const diagnosticStatuses = new WeakMap<Component, { spacer: Spacer; bytes: number }>();
const MAX_DIAGNOSTIC_STATUSES = 64;
const MAX_DIAGNOSTIC_HISTORY_BYTES = 256 * 1024;

InteractiveModeBase.prototype.showStatus = function (
	this: InteractiveModeBase,
	message: string,
	persist = false,
): void {
	const children = this.chatContainer.children;
	const last = children.length > 0 ? children[children.length - 1] : undefined;
	const secondLast = children.length > 1 ? children[children.length - 2] : undefined;

	if (!persist && last && secondLast && last === this.lastStatusText && secondLast === this.lastStatusSpacer) {
		this.lastStatusText.setText(theme.fg("dim", message));
		this.ui.requestRender();
		return;
	}

	if (persist) message = appendBoundedStderr("", message);
	const spacer = new Spacer(1);
	const text = new Text(theme.fg("dim", message), 1, 0);
	statusComponents.add(text);
	this.chatContainer.addChild(spacer);
	this.chatContainer.addChild(text);
	this.lastStatusSpacer = persist ? undefined : spacer;
	this.lastStatusText = persist ? undefined : text;
	if (persist) {
		diagnosticStatuses.set(text, { spacer, bytes: Buffer.byteLength(message) });
		let count = 0;
		let bytes = 0;
		for (const child of [...children].reverse()) {
			const diagnostic = diagnosticStatuses.get(child);
			if (!diagnostic) continue;
			count++;
			bytes += diagnostic.bytes;
			if (count > MAX_DIAGNOSTIC_STATUSES || bytes > MAX_DIAGNOSTIC_HISTORY_BYTES) {
				this.chatContainer.removeChild(child);
				this.chatContainer.removeChild(diagnostic.spacer);
			}
		}
	}
	this.ui.requestRender();
};

const echoReadEpochs = new WeakMap<Component[], number>();

interface GroupedToolComponent {
	setGroupRole(role: ToolGroupRole): void;
	setGroupHead?(head: ToolGroupHead | undefined): void;
}

/**
 * Gives `component`, and `entry` when the row draws one, its place in a group of calls. A call folded into a group is
 * told the group's first row too, without keeping it alive, so that it is drawn on its own while a click has left
 * the two at different expansions.
 */
function groupedRowSink(component: GroupedToolComponent, entry?: { groupRole?: ToolGroupRole }): ToolGroupRoleSink {
	return (role, head) => {
		if (entry) entry.groupRole = role;
		component.setGroupRole(role);
		const headRow = head as Component | undefined;
		if (role.kind !== "hidden" || !isClickExpandableBlock(headRow)) {
			component.setGroupHead?.(undefined);
			return;
		}
		const row = new WeakRef(headRow);
		component.setGroupHead?.({ isExpanded: () => row.deref()?.isExpanded() });
	};
}
interface MainToolGrouping {
	readonly tracker: ToolGroupTracker;
	readonly starts: Map<string, number>;
	lastMember: Component | undefined;
	carriedBreak: boolean;
}
const mainToolGroupings = new WeakMap<InteractiveModeBase, MainToolGrouping>();

function mainToolGrouping(mode: InteractiveModeBase): MainToolGrouping {
	let grouping = mainToolGroupings.get(mode);
	if (grouping === undefined) {
		grouping = {
			tracker: new ToolGroupTracker({ groupBash: false }),
			starts: new Map(),
			lastMember: undefined,
			carriedBreak: false,
		};
		mainToolGroupings.set(mode, grouping);
	}
	return grouping;
}

function isGroupedToolComponent(component: Component): component is Component & GroupedToolComponent {
	return "setGroupRole" in component && typeof component.setGroupRole === "function";
}

function hasRowsSinceLastMember(
	container: Component & { children: Component[] },
	last: Component,
	current: Component,
): boolean {
	for (let index = container.children.length - 1; index >= 0; index -= 1) {
		const child = container.children[index];
		if (child === last) return false;
		if (child !== current && !(child instanceof AssistantMessageComponent)) return true;
	}
	return true;
}

export function breakMainToolGroup(mode: InteractiveModeBase): void {
	const grouping = mainToolGrouping(mode);
	grouping.tracker.break();
	grouping.lastMember = undefined;
	grouping.carriedBreak = false;
}

function resetMainToolGroup(mode: InteractiveModeBase): void {
	const grouping = mainToolGrouping(mode);
	grouping.tracker.reset();
	grouping.lastMember = undefined;
	grouping.carriedBreak = false;
}

export function endMainToolTurn(mode: InteractiveModeBase): void {
	resetMainToolGroup(mode);
	mainToolGrouping(mode).starts.clear();
}

export function mainToolCallBreaks(mode: InteractiveModeBase, message: AssistantMessage): ReadonlySet<string> {
	return assistantCallBreaks(message.content, mainToolGrouping(mode).carriedBreak).breakBefore;
}

export function endMainAssistantMessage(mode: InteractiveModeBase, message: AssistantMessage): void {
	const grouping = mainToolGrouping(mode);
	grouping.carriedBreak = assistantCallBreaks(message.content, grouping.carriedBreak).trailing;
}

export function trackMainToolComponent(
	mode: InteractiveModeBase,
	toolCallId: string,
	toolName: string,
	component: Component & GroupedToolComponent,
	breakBefore = false,
): void {
	const grouping = mainToolGrouping(mode);
	if (
		breakBefore ||
		(grouping.lastMember !== undefined && hasRowsSinceLastMember(mode.chatContainer, grouping.lastMember, component))
	)
		grouping.tracker.break();
	grouping.tracker.append(toolCallId, toolName, "pending", groupedRowSink(component), component);
	grouping.lastMember = component;
}

export function settleMainTool(mode: InteractiveModeBase, toolCallId: string, state: ToolGroupMemberState): void {
	const grouping = mainToolGrouping(mode);
	grouping.tracker.settle(toolCallId, state);
	if (state !== "pending") grouping.starts.delete(toolCallId);
}

export function observeMainToolStart(mode: InteractiveModeBase, toolCallId: string): number {
	const starts = mainToolGrouping(mode).starts;
	const startedAt = starts.get(toolCallId) ?? Date.now();
	starts.set(toolCallId, startedAt);
	return startedAt;
}

function renderGroupedChatEntries(
	mode: InteractiveModeBase,
	entries: readonly ChatMessageEntry[],
	onEntry: (entry: ChatMessageEntry, component: Component) => void,
): void {
	const grouping = mainToolGrouping(mode);
	for (const entry of entries) {
		if (entry.kind === "tool" && entry.isPartial !== false) {
			const startedAt = grouping.starts.get(entry.toolCallId);
			if (startedAt !== undefined) {
				entry.executionStarted = true;
				entry.startedAt = startedAt;
				entry.argsComplete = true;
			}
		}
		if (entry.kind === "assistant")
			grouping.carriedBreak = assistantCallBreaks(entry.message.content, grouping.carriedBreak).trailing;
		else if (entry.kind !== "tool") grouping.carriedBreak = false;
		const component = mode.addRenderedChatEntry(entry);
		if (entry.kind === "tool" && isGroupedToolComponent(component)) {
			grouping.tracker.bind(entry.toolCallId, groupedRowSink(component, entry), component);
			grouping.lastMember = component;
		}
		onEntry(entry, component);
	}
}

InteractiveModeBase.prototype.renderDeferredUserInput = function (
	this: InteractiveModeBase,
	text: string,
	echo?: DeferredUserInputEcho,
): DeferredUserInputEcho {
	this.deferredRenderedUserInputs.push(text);
	const startIndex = this.chatContainer.children.length;
	this.addMessageToChat({ role: "user", content: text } as AgentMessage);
	// A chat drawn again draws an echo again into the same array, so the send it belongs to still names it.
	const renderedComponents = echo ?? [];
	renderedComponents.splice(0, renderedComponents.length, ...this.chatContainer.children.slice(startIndex));
	const epoch = (this.ui as AltScreenMessageCounterHost).newMessages?.epoch;
	if (epoch !== undefined) echoReadEpochs.set(renderedComponents, epoch);
	const trackedComponents = this.deferredRenderedUserInputComponents.get(text) ?? [];
	trackedComponents.push(renderedComponents);
	this.deferredRenderedUserInputComponents.set(text, trackedComponents);
	this.updatePendingMessagesDisplay();
	this.ui.requestRender();
	return renderedComponents;
};

InteractiveModeBase.prototype.consumeDeferredRenderedUserInput = function (
	this: InteractiveModeBase,
	text: string,
): boolean {
	const index = this.deferredRenderedUserInputs.indexOf(text);
	if (index === -1) return false;
	this.deferredRenderedUserInputs.splice(index, 1);
	const trackedComponents = this.deferredRenderedUserInputComponents.get(text);
	const consumed = trackedComponents?.shift();
	forgetOriginEcho(this, consumed);
	forgetStartedEcho(this, text, consumed);
	if (trackedComponents && trackedComponents.length === 0) {
		this.deferredRenderedUserInputComponents.delete(text);
	}
	return true;
};

interface StartedEcho {
	readonly text: string;
	readonly echo: DeferredUserInputEcho | undefined;
}

interface OriginEcho {
	readonly text: string;
	readonly echo: DeferredUserInputEcho;
}

/** Per chat, pending deferred echoes indexed by their ephemeral host origin send id. */
const originEchoes = new WeakMap<object, Map<string, OriginEcho>>();
/** Reverse mapping from a pending echo's component array to its origin send id. */
const echoOrigins = new WeakMap<DeferredUserInputEcho, string>();
/** `taggedUserMessagesShownCount` snapshot captured alongside `shownBefore` for an echo's send. */
const echoTaggedBaselines = new WeakMap<DeferredUserInputEcho, number>();
/** Per chat, count of newly appended user messages (no echo matched) that carried an origin send id. */
const taggedUserMessagesShown = new WeakMap<object, number>();
/** Per chat, in-flight sends without a pre-rendered echo awaiting their prompt answer, by origin send id. */
const awaitingOriginSends = new WeakMap<object, Map<string, { shown: boolean }>>();

/** Count of unmatched user messages with an origin send id shown so far on `mode`. */
export function taggedUserMessagesShownCount(mode: InteractiveModeBase): number {
	return taggedUserMessagesShown.get(mode) ?? 0;
}

/**
 * Number of untagged user messages shown as new since `(shownBefore, taggedBefore)`.
 * Equal to `userMessagesShownBySession - shownBefore` when talking to an older engine that sends no origin ids, and
 * unaffected by tagged messages from other sends on a current engine.
 */
export function untaggedUserMessagesShownSince(
	mode: InteractiveModeBase,
	shownBefore: number,
	taggedBefore: number,
): number {
	return mode.userMessagesShownBySession - shownBefore - (taggedUserMessagesShownCount(mode) - taggedBefore);
}

/** Bind a pending deferred `echo` of `text` to host prompt send `originSendId`. */
export function noteDeferredEchoOrigin(
	mode: InteractiveModeBase,
	text: string,
	echo: DeferredUserInputEcho,
	originSendId: string,
	taggedBefore?: number,
): void {
	if (mode.deferredRenderedUserInputComponents?.get(text)?.includes(echo) !== true) return;
	let byOrigin = originEchoes.get(mode);
	if (byOrigin === undefined) {
		byOrigin = new Map();
		originEchoes.set(mode, byOrigin);
	}
	byOrigin.set(originSendId, { text, echo });
	echoOrigins.set(echo, originSendId);
	if (taggedBefore !== undefined) echoTaggedBaselines.set(echo, taggedBefore);
}

/** Record the `taggedUserMessagesShownCount` baseline captured with `shownBefore` for `echo`. */
export function noteDeferredEchoShownBaseline(
	mode: InteractiveModeBase,
	echo: DeferredUserInputEcho,
	taggedBefore: number = taggedUserMessagesShownCount(mode),
): void {
	echoTaggedBaselines.set(echo, taggedBefore);
}

/**
 * Track an in-flight send without a pre-rendered echo (the busy-steer path) so `onAnswered` learns whether its own
 * `message_start` already arrived before the answer. Dispose in `finally` to retain nothing once settled.
 */
export function beginPendingOriginSend(
	mode: InteractiveModeBase,
	originSendId: string,
): { wasShown(): boolean; dispose(): void } {
	let awaiting = awaitingOriginSends.get(mode);
	if (awaiting === undefined) {
		awaiting = new Map();
		awaitingOriginSends.set(mode, awaiting);
	}
	const entry = { shown: false };
	awaiting.set(originSendId, entry);
	return {
		wasShown: () => entry.shown,
		dispose: () => {
			const current = awaitingOriginSends.get(mode);
			if (current === undefined) return;
			if (current.get(originSendId) === entry) current.delete(originSendId);
			if (current.size === 0) awaitingOriginSends.delete(mode);
		},
	};
}

function forgetOriginEcho(mode: InteractiveModeBase, echo: DeferredUserInputEcho | undefined): void {
	if (echo === undefined) return;
	const origin = echoOrigins.get(echo);
	echoOrigins.delete(echo);
	echoTaggedBaselines.delete(echo);
	if (origin === undefined) return;
	const byOrigin = originEchoes.get(mode);
	if (byOrigin === undefined) return;
	if (byOrigin.get(origin)?.echo === echo) byOrigin.delete(origin);
	if (byOrigin.size === 0) originEchoes.delete(mode);
}

function pendingEchoComponentSet(mode: InteractiveModeBase): Set<Component> {
	const pending = new Set<Component>();
	for (const echoes of mode.deferredRenderedUserInputComponents.values()) {
		for (const echo of echoes) {
			for (const component of echo) pending.add(component);
		}
	}
	return pending;
}

/**
 * Whether any non-echo row appears after `echo` in `mode.chatContainer` (for example an assistant reply, tool block,
 * earlier user message, or compaction boundary). Returns false when `echo` has no rendered components (such as minimal
 * test doubles whose `addMessageToChat` does not attach children), and true when rendered components are no longer
 * attached.
 */
function hasNonEchoRowsAfter(mode: InteractiveModeBase, echo: DeferredUserInputEcho): boolean {
	if (echo.length === 0) return false;
	const children = mode.chatContainer.children;
	let lastEchoIndex = -1;
	for (const component of echo) {
		const index = children.indexOf(component);
		if (index > lastEchoIndex) lastEchoIndex = index;
	}
	if (lastEchoIndex === -1) return true;
	if (lastEchoIndex === children.length - 1) return false;
	const pending = pendingEchoComponentSet(mode);
	for (let index = lastEchoIndex + 1; index < children.length; index++) {
		if (!pending.has(children[index]!)) return true;
	}
	return false;
}

/**
 * Earliest component in the contiguous trailing suffix of pending deferred echoes at the end of `mode.chatContainer`,
 * or undefined if the tail ends with a non-echo row (such as an assistant reply, tool block, or compaction boundary).
 */
function trailingDeferredEchoAnchor(mode: InteractiveModeBase): Component | undefined {
	const children = mode.chatContainer.children;
	if (children.length === 0 || mode.deferredRenderedUserInputs.length === 0) return undefined;
	const pending = pendingEchoComponentSet(mode);
	if (pending.size === 0) return undefined;
	let start = children.length;
	while (start > 0 && pending.has(children[start - 1]!)) start--;
	return start < children.length ? children[start] : undefined;
}

/**
 * Per chat, the echoes of the submissions that started runs, oldest first, each until its run shows its message. A run
 * begins with the message, which may carry other text than the echo when an `input` hook rewrote it (#4277).
 */
const startedEchoes = new WeakMap<object, StartedEcho[]>();

function startedEchoesOf(mode: InteractiveModeBase): StartedEcho[] {
	let started = startedEchoes.get(mode);
	if (started === undefined) {
		started = [];
		startedEchoes.set(mode, started);
	}
	return started;
}

/** Whether `echo` is the echo of a started run that has not shown its message yet. */
export function awaitsStartedRunMessage(mode: InteractiveModeBase, echo: DeferredUserInputEcho): boolean {
	return startedEchoes.get(mode)?.some((started) => started.echo === echo) === true;
}

/** The echo `echo` of `text` (the oldest with that text when not named) is gone: no run's message replaces it now. */
function forgetStartedEcho(mode: InteractiveModeBase, text: string, echo: DeferredUserInputEcho | undefined): void {
	const started = startedEchoes.get(mode);
	if (started === undefined) return;
	const index = started.findIndex(
		(started) => started.text === text && (started.echo === undefined || echo === undefined || started.echo === echo),
	);
	if (index !== -1) started.splice(index, 1);
}

/** The index of the `rank`-th (from 0) `text` in `list`; -1 when there are not that many. */
function nthIndexOf(list: readonly string[], text: string, rank: number): number {
	let seen = 0;
	for (let index = 0; index < list.length; index++)
		if (list[index] === text) {
			if (seen === rank) return index;
			seen++;
		}
	return -1;
}

/**
 * Take the echo of one sent message off the list of echoes: `echo` itself when the send names it, else the oldest
 * echo of `text`. Each send removes only its own echo, never an earlier send's of the same text. Undefined when that
 * echo is gone already.
 */
function forgetDeferredEcho(
	mode: InteractiveModeBase,
	text: string,
	echo?: DeferredUserInputEcho,
): Component[] | undefined {
	const trackedComponents = mode.deferredRenderedUserInputComponents.get(text);
	// The k-th echo of a text is its k-th tracked component list: both are added and taken in step.
	const rank = echo === undefined ? 0 : (trackedComponents?.indexOf(echo) ?? -1);
	if (rank === -1) return undefined;
	const index = nthIndexOf(mode.deferredRenderedUserInputs, text, rank);
	if (index !== -1) mode.deferredRenderedUserInputs.splice(index, 1);
	const components = trackedComponents?.splice(rank, 1)[0];
	forgetOriginEcho(mode, components ?? echo);
	if (index !== -1 || components !== undefined) forgetStartedEcho(mode, text, components ?? echo);
	if (trackedComponents && trackedComponents.length === 0) {
		mode.deferredRenderedUserInputComponents.delete(text);
	}
	return components;
}

interface PendingEcho {
	readonly text: string;
	readonly epoch: number | undefined;
	readonly components: DeferredUserInputEcho | undefined;
	readonly origin: string | undefined;
	readonly taggedBefore: number | undefined;
}

function takeDeferredEchoes(mode: InteractiveModeBase): PendingEcho[] {
	const occurrences = new Map<string, number>();
	const echoes = mode.deferredRenderedUserInputs.map((text) => {
		const occurrence = occurrences.get(text) ?? 0;
		occurrences.set(text, occurrence + 1);
		const components = mode.deferredRenderedUserInputComponents.get(text)?.[occurrence];
		return {
			text,
			epoch: components ? echoReadEpochs.get(components) : undefined,
			components,
			origin: components ? echoOrigins.get(components) : undefined,
			taggedBefore: components ? echoTaggedBaselines.get(components) : undefined,
		};
	});
	mode.deferredRenderedUserInputs = [];
	mode.deferredRenderedUserInputComponents.clear();
	originEchoes.delete(mode);
	return echoes;
}

function restoreDeferredEchoes(mode: InteractiveModeBase, echoes: readonly PendingEcho[]): void {
	for (const { text, epoch, components, origin, taggedBefore } of echoes) {
		const echo = mode.renderDeferredUserInput(text, components);
		if (epoch !== undefined) echoReadEpochs.set(echo, epoch);
		if (origin !== undefined) noteDeferredEchoOrigin(mode, text, echo, origin, taggedBefore);
		else if (taggedBefore !== undefined) echoTaggedBaselines.set(echo, taggedBefore);
	}
}

InteractiveModeBase.prototype.discardDeferredRenderedUserInput = function (
	this: InteractiveModeBase,
	text: string,
	echo?: DeferredUserInputEcho,
): void {
	const componentsToRemove = forgetDeferredEcho(this, text, echo);
	if (!componentsToRemove) return;
	const renderer = this.ui as AltScreenMessageCounterHost;
	const following = renderer.isFollowingOutput !== false;
	const countedBefore = countChatMessages(this.chatContainer);
	if (!following) renderer.newMessages?.observe(false, countedBefore);
	for (const component of componentsToRemove) this.chatContainer.removeChild(component);
	const counted = countChatMessages(this.chatContainer);
	const counter = renderer.newMessages;
	if (!following && counter && echoReadEpochs.get(componentsToRemove) === counter.epoch) {
		counter.retract(countedBefore - counted);
	}
	counter?.observe(following, counted);
	this.updatePendingMessagesDisplay();
	this.ui.requestRender();
};

/**
 * The session started a run for a submission this host echoed as `text`. The run begins with the submission's message,
 * as sent: an `input` hook may have rewritten it, so its `message_start` need not match the echo (#4277). An engine's
 * answer can reach the host after that `message_start`, which the session then showed itself (#4272): if it showed any
 * untagged message of its own since `shownBefore`, the echo goes. Otherwise the session's next matching message takes
 * the echo's place. A run starts only after the one before it showed its message, so an earlier run still waiting here
 * never got to show it, and its echo stays as it is.
 */
InteractiveModeBase.prototype.expectStartedUserInput = function (
	this: InteractiveModeBase,
	text: string,
	shownBefore: number,
	echo?: DeferredUserInputEcho,
): void {
	if (!this.deferredRenderedUserInputs.includes(text)) return;
	if (echo !== undefined && this.deferredRenderedUserInputComponents.get(text)?.includes(echo) !== true) return;
	const taggedBefore = echo !== undefined ? echoTaggedBaselines.get(echo) : undefined;
	const untaggedDelta =
		taggedBefore === undefined
			? this.userMessagesShownBySession - shownBefore
			: untaggedUserMessagesShownSince(this, shownBefore, taggedBefore);
	const stalePosition = echo !== undefined && this.chatContainer !== undefined && hasNonEchoRowsAfter(this, echo);
	if (untaggedDelta !== 0 || stalePosition) this.discardDeferredRenderedUserInput(text, echo);
	// Runs show their messages in the order they started.
	else startedEchoesOf(this).push({ text, echo });
};

/** Follows one sent message's echo through `StartedRunEcho` (see there). */
export interface StartedRunEchoFollower {
	/**
	 * The session answered the prompt: `started` when it started a run for this message. `echo` is the message's echo
	 * when it was drawn only now.
	 */
	answer(started: boolean, echo?: DeferredUserInputEcho): void;
	/** The send ended without a run to wait for (failed, or not sent): stop following, leaving the echo alone. */
	close(): void;
}

/**
 * Follow the echo of `text` from just before it is sent until the run it started shows the message (the echo stays as
 * that message) or gets past it without one (the echo goes, #5135), whichever order the answer and the run's events
 * arrive in. A run that settles or loses its engine before it starts drops the echo, and the working row the send
 * showed when `sendShowsWorkingRow`, as the answer alone used to.
 */
export function followStartedRunEcho(
	mode: InteractiveModeBase,
	text: string,
	options: {
		readonly sendShowsWorkingRow: boolean;
		/** The echo drawn for this message when it was sent; only this echo is the message's. */
		readonly echo?: DeferredUserInputEcho;
		/** Ephemeral host send id for this submission; messages tagged with a different origin are never taken. */
		readonly originSendId?: string;
	},
): StartedRunEchoFollower {
	let state = STARTED_RUN_ECHO_SENT;
	let echo = options.echo;
	const followers = echoFollowers.get(mode) ?? { count: 0, echoes: new WeakMap(), taken: new WeakSet() };
	followers.count += 1;
	echoFollowers.set(mode, followers);
	const stops: Array<() => void> = [
		() => {
			followers.count -= 1;
			if (followers.count === 0 && echoFollowers.get(mode) === followers) echoFollowers.delete(mode);
		},
	];
	const stop = (): void => {
		for (const release of stops.splice(0)) release();
	};
	let watchingEngine = false;
	const apply = (event: StartedRunEchoEvent): void => {
		if (state.kind === "settled") return;
		state = nextStartedRunEcho(state, event);
		if (state.kind === "awaiting-run-message" && !watchingEngine) {
			// Only a run answered as started waits on its engine, and is lost with it.
			watchingEngine = true;
			const runtime = mode.runtimeHost;
			if (runtime instanceof IsolatedInteractiveRuntime)
				stops.push(runtime.onGenerationEnded(() => apply({ type: "lost" })));
		}
		if (state.kind !== "settled") return;
		stop();
		if (state.echo === "left") return;
		if (mode.deferredRenderedUserInputs?.includes(text) === true) mode.discardDeferredRenderedUserInput(text, echo);
		// What the send's own end does when no run started: the working row it showed has no run to end it.
		if (
			state.echo === "never-ran" &&
			options.sendShowsWorkingRow &&
			!mode.session.isStreaming &&
			mode.workingRunMeter.snapshot() === undefined
		) {
			mode.workingRunMeter.stop();
			mode.stopWorkingLoader();
		}
	};
	// A run the host saw start and not settle before the send ends before this message's run can start: until it
	// settles, its events are not this run's. A user message shown meanwhile still counts, as it always did, unless an
	// earlier send takes it (see `takeUserMessage`).
	let earlierRun = mode.session.turnStartedAt !== undefined;
	stops.push(
		mode.session.subscribe((event) => {
			if (earlierRun && (event.type === "agent_settled" || event.type === "session_released")) {
				earlierRun = false;
				return;
			}
			const echoEvent = startedRunEchoEvent(event);
			if (echoEvent === undefined || (earlierRun && echoEvent.type !== "user-message")) return;
			if (
				echoEvent.type === "user-message" &&
				event.type === "message_start" &&
				!takeUserMessage(followers, event, text, options.originSendId)
			) {
				// Another send's message: the run showing it is an earlier one, though the host had not seen it start. What
				// that run did so far is not this message's run's.
				if (state.kind === "awaiting-answer" && !state.userMessageShown) {
					state = STARTED_RUN_ECHO_SENT;
					earlierRun = true;
				}
				return;
			}
			apply(echoEvent);
		}),
	);
	return {
		answer: (started, drawn) => {
			echo ??= drawn;
			// Everything of an earlier run came before this answer.
			earlierRun = false;
			apply({ type: "answer", started });
		},
		close: () => {
			if (state.kind === "awaiting-answer") stop();
		},
	};
}

/**
 * What a chat's live echo followers share while any is following: the text of the echo each user message shown
 * meanwhile took the place of (null when it took none), and the events whose message a follower took.
 */
interface EchoFollowers {
	count: number;
	readonly echoes: WeakMap<object, string | null>;
	readonly taken: WeakSet<object>;
}
const echoFollowers = new WeakMap<object, EchoFollowers>();

/**
 * Whether the follower of a message sent as `text` takes the user message `event` shows. A shown message is one sent
 * message's: when both carry an origin send id, only a matching origin takes it; otherwise the first follower still
 * waiting for it takes it, so another send of the same text, whose run may show no message of its own (#5135), still
 * decides its own echo (#6126). A message shown in place of another text's echo is that send's.
 */
function takeUserMessage(
	followers: EchoFollowers,
	event: Extract<AgentSessionEvent, { type: "message_start" }>,
	text: string,
	originSendId: string | undefined,
): boolean {
	const messageOrigin = userMessageOrigin(event.message);
	if (messageOrigin !== undefined && originSendId !== undefined && messageOrigin !== originSendId) return false;
	const replaced = followers.echoes.get(event.message);
	if (typeof replaced === "string" && replaced !== text) return false;
	if (followers.taken.has(event)) return false;
	followers.taken.add(event);
	return true;
}

/** Replace a pending deferred echo in place with `message`, keeping message-counter accounting intact. */
function replaceDeferredEchoWithMessage(
	mode: InteractiveModeBase,
	message: Message,
	echoText: string,
	echo: DeferredUserInputEcho | undefined,
	started?: StartedEcho,
): void {
	echoFollowers.get(mode)?.echoes.set(message, echoText);
	const renderer = mode.ui as AltScreenMessageCounterHost;
	const following = renderer.isFollowingOutput !== false;
	const countedBefore = countChatMessages(mode.chatContainer);
	renderer.newMessages?.observe(following, countedBefore);
	const removed = forgetDeferredEcho(mode, echoText, echo);
	if (started !== undefined) {
		// Its run shows its message now, whether or not its echo is still drawn.
		const waiting = startedEchoesOf(mode);
		if (waiting[0] === started) waiting.shift();
	}
	appendNewChildrenBeforeAttachedChild(mode.chatContainer, removed?.[0], () => mode.addMessageToChat(message));
	for (const component of removed ?? []) mode.chatContainer.removeChild(component);
	const counted = countChatMessages(mode.chatContainer);
	const counter = renderer.newMessages;
	if (!following && counter && removed && echoReadEpochs.get(removed) === counter.epoch) {
		counter.retract(countedBefore - counted);
	}
	counter?.replaced(counted);
	mode.updatePendingMessagesDisplay();
	mode.ui.requestRender();
}

/**
 * Show a user message from the session: when it carries an origin send id, consume or replace only that exact send's
 * echo (or insert before later pending echoes if none exists); otherwise fall back to text then oldest started run.
 */
InteractiveModeBase.prototype.showSessionUserMessage = function (this: InteractiveModeBase, message: Message): void {
	const text = this.getUserMessageText(message);
	const origin = userMessageOrigin(message);
	if (origin !== undefined) {
		const matched = originEchoes.get(this)?.get(origin);
		if (matched !== undefined) {
			if (hasNonEchoRowsAfter(this, matched.echo)) {
				// Non-echo rows (assistant reply, tool output, compaction boundary, or another turn) already sit below
				// this echo, so keeping or replacing it in place would reorder conversation history. Discard the stale
				// echo and append the message at the tail instead.
				echoFollowers.get(this)?.echoes.set(message, matched.text);
				this.discardDeferredRenderedUserInput(matched.text, matched.echo);
				this.addMessageToChat(message);
				return;
			}
			if (matched.text === text) {
				const kept = forgetDeferredEcho(this, matched.text, matched.echo);
				echoFollowers.get(this)?.echoes.set(message, matched.text);
				// The echo stays as the session's message: its rows are that message's rows.
				for (const component of kept ?? matched.echo) noteRowSource(component, { message, part: 0 });
				return;
			}
			replaceDeferredEchoWithMessage(this, message, matched.text, matched.echo);
			return;
		}
		const awaiting = awaitingOriginSends.get(this)?.get(origin);
		if (awaiting !== undefined) awaiting.shown = true;
		echoFollowers.get(this)?.echoes.set(message, null);
		this.userMessagesShownBySession += 1;
		taggedUserMessagesShown.set(this, taggedUserMessagesShownCount(this) + 1);
		appendNewChildrenBeforeAttachedChild(this.chatContainer, trailingDeferredEchoAnchor(this), () =>
			this.addMessageToChat(message),
		);
		return;
	}
	const echo = this.deferredRenderedUserInputComponents?.get(text)?.[0];
	if (this.consumeDeferredRenderedUserInput(text)) {
		echoFollowers.get(this)?.echoes.set(message, text);
		// The echo stays as the session's message: its rows are that message's rows.
		for (const component of echo ?? []) noteRowSource(component, { message, part: 0 });
		return;
	}
	// The oldest started run that has not shown its message yet shows this one.
	const started = startedEchoes.get(this)?.[0];
	if (started !== undefined) {
		replaceDeferredEchoWithMessage(this, message, started.text, started.echo, started);
		return;
	}
	echoFollowers.get(this)?.echoes.set(message, null);
	this.userMessagesShownBySession += 1;
	this.addMessageToChat(message);
};

InteractiveModeBase.prototype.getMarkdownTransformers = function (this: InteractiveModeBase) {
	const mode = this.settingsManager.getMermaidRenderingMode();
	const withheld =
		this.runtimeHost instanceof IsolatedInteractiveRuntime &&
		this.runtimeHost.isProjectTrustPending() &&
		!this.settingsManager.isProjectTrusted();
	if (this.mermaidMarkdownTransformerMode !== mode || withheld !== (this.mermaidTransformerWithheldProject === true)) {
		this.mermaidMarkdownTransformerMode = mode;
		this.mermaidTransformerWithheldProject = withheld;
		const edit = this.mermaidUserEdit;
		this.mermaidMarkdownTransformer = createMermaidMarkdownTransformer({
			// Invalidating a message for a redraw isn't permission to replace a mounted diagram with source text.
			// The user's own subsequent rendering choice, unlike approval, still applies to visible messages.
			getMode: () =>
				withheld && edit === this.mermaidUserEdit ? mode : this.settingsManager.getMermaidRenderingMode(),
			theme,
		});
	}
	const extensionTransformers =
		this.runtimeHost instanceof IsolatedInteractiveRuntime
			? []
			: this.session.extensionRunner.getMarkdownTransformers();
	return [this.mermaidMarkdownTransformer, ...extensionTransformers];
};

/**
 * Markdown of a changelog that runs the Markdown transformers registered for the `changelog` type. Transformers are
 * looked up on each render, so a notice shown before deferred extensions load uses them once it is invalidated.
 */
InteractiveModeBase.prototype.createChangelogMarkdown = function (
	this: InteractiveModeBase,
	markdown: string,
	paddingX: number,
	paddingY: number,
): Markdown {
	return new Markdown(markdown, paddingX, paddingY, this.getMarkdownThemeWithSettings(), undefined, {
		transform: (text, width) =>
			createMarkdownTransform("changelog", () => false, this.getMarkdownTransformers())(text, width),
	});
};

InteractiveModeBase.prototype.chatMessageRenderOptions = function (
	this: InteractiveModeBase,
): ChatMessageRenderOptions {
	const isolated = this.runtimeHost instanceof IsolatedInteractiveRuntime;
	return {
		ui: this.ui,
		cwd: this.sessionManager.getCwd(),
		markdownTheme: this.getMarkdownThemeWithSettings(),
		hideThinkingBlock: this.hideThinkingBlock,
		hiddenThinkingLabel: this.hiddenThinkingLabel,
		toolOutputExpanded: this.toolOutputExpanded,
		showImages: this.settingsManager.getShowImages(),
		imageWidthCells: this.settingsManager.getImageWidthCells(),
		outputPad: this.outputPad,
		renderLatex: this.settingsManager.getLatexRenderingEnabled(),
		markdownTransformers: this.getMarkdownTransformers(),
		getToolDefinition: isolated ? undefined : (toolName) => this.getRegisteredToolDefinition(toolName),
		getTaskRecord: isolated ? undefined : (taskId) => getOwnerTaskStore(this.session)?.getTask(taskId),
		hasTaskTranscript: isolated
			? undefined
			: (taskId) => {
					const lease = getOwnerTaskStore(this.session)?.resolveTask(taskId);
					return lease?.ok ? taskTranscriptSource(lease.value).ok : false;
				},
		loadTaskTranscript: isolated
			? undefined
			: async (taskId, options) => {
					const lease = getOwnerTaskStore(this.session)?.resolveTask(taskId);
					return lease?.ok ? readTaskCompletionHistory(lease.value, options?.signal) : undefined;
				},
		getCustomMessageRenderer: isolated
			? undefined
			: (customType) => this.session.extensionRunner.getMessageRenderer(customType),
		createToolComponent: isolated
			? (entry, context) => {
					const component = new RemoteToolExecutionComponent(
						entry.toolName,
						entry.toolCallId,
						entry.args,
						{
							showImages: context?.showImages ?? this.settingsManager.getShowImages(),
							imageWidthCells: context?.imageWidthCells ?? this.settingsManager.getImageWidthCells(),
							outputPad: context?.outputPad ?? this.outputPad,
							rendererTaskId: entry.rendererTaskId,
							...(context?.keptTaskAction === undefined ? {} : { keptTaskAction: context.keptTaskAction }),
						},
						this.runtimeHost as IsolatedInteractiveRuntime,
						context?.requestRender ?? (() => this.ui.requestRender()),
					);
					applyToolEntryState(component, entry, context?.expanded ?? this.toolOutputExpanded);
					return component;
				}
			: undefined,
		createCustomMessageComponent: isolated
			? (message, context) => {
					const component = new RemoteCustomMessageComponent(
						message,
						this.runtimeHost as IsolatedInteractiveRuntime,
						context?.requestRender ?? (() => this.ui.requestRender()),
						context?.outputPad ?? this.outputPad,
					);
					component.setExpanded(context?.expanded ?? this.toolOutputExpanded);
					return component;
				}
			: undefined,
	};
};

InteractiveModeBase.prototype.addRenderedChatEntry = function (
	this: InteractiveModeBase,
	entry: ChatMessageEntry,
): Component {
	const component = renderChatMessageEntry(entry, this.chatMessageRenderOptions());
	carryRowSource(entry, component);
	if (entry.kind !== "system" && !(entry.kind === "custom" && isVerbatimCompactionMessage(entry.message))) {
		messageComponents.add(component);
	}
	addChatTranscriptEntry(this.chatContainer, component, entry.role);
	return component;
};

InteractiveModeBase.prototype.addCompactionBoundaryToChat = function (
	this: InteractiveModeBase,
	result: VerbatimCompactionResult,
): void {
	this.chatContainer.addChild(new Spacer(1));
	const component = new CompactionBoundaryMessageComponent(result, this.outputPad);
	component.setExpanded(this.toolOutputExpanded);
	this.chatContainer.addChild(component);
};

InteractiveModeBase.prototype.addCompactionCostNotice = function (
	this: InteractiveModeBase,
	kind: "compaction" | "branch_summary",
	usage: Usage,
): void {
	if (!this.settingsManager.getShowCacheMissNotices()) return;
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
	const label = kind === "compaction" ? "Compaction" : "Branch summary";
	this.chatContainer.addChild(new Spacer(1));
	this.chatContainer.addChild(
		new Text(theme.fg("warning", `${label}: ${tokens.toLocaleString()} tokens billed${cost}`), 1, 0),
	);
};

InteractiveModeBase.prototype.addCustomEntryToChat = function (this: InteractiveModeBase, entry: CustomEntry): void {
	const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
	if (!renderer) return;
	const runner = this.session.extensionRunner;
	const component = new CustomEntryComponent(
		entry,
		(...args) => runner.renderEntry(entry.customType, ...args),
		this.outputPad,
	);
	component.setExpanded(this.toolOutputExpanded);
	if (!component.hasContent()) return;
	messageComponents.add(component);
	const seq = this.sessionManager.getEntrySeq?.(entry.id);
	if (seq !== undefined) noteSavedSeq(entry, seq);
	noteRowSource(component, { message: entry, part: 0 });
	const streamingIndex = this.streamingComponent ? this.chatContainer.children.indexOf(this.streamingComponent) : -1;
	if (streamingIndex >= 0) this.chatContainer.children.splice(streamingIndex, 0, component);
	else this.chatContainer.addChild(component);
};

type AltScreenMessageCounterHost = TUI & {
	isFollowingOutput?: boolean;
	newMessages?: NewMessageCounter;
};

InteractiveModeBase.prototype.addMessageToChat = function (
	this: InteractiveModeBase,
	message: AgentMessage,
	options?: { populateHistory?: boolean },
): void {
	const markdownTransformers = this.getMarkdownTransformers();
	switch (message.role) {
		case "bashExecution": {
			const component = new BashExecutionComponent(
				message.command,
				this.ui,
				message.excludeFromContext,
				this.outputPad,
			);
			if (message.output) {
				component.appendOutput(message.output);
			}
			component.setComplete(
				message.exitCode,
				message.cancelled,
				message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
				message.fullOutputPath,
			);
			messageComponents.add(component);
			noteRowSource(component, { message, part: 0 });
			this.chatContainer.addChild(component);
			break;
		}
		case "custom": {
			if (message.display) {
				const component =
					this.runtimeHost instanceof IsolatedInteractiveRuntime
						? new RemoteCustomMessageComponent(
								message,
								this.runtimeHost,
								() => this.ui.requestRender(),
								this.outputPad,
							)
						: new CustomMessageComponent(
								message,
								this.session.extensionRunner.getMessageRenderer(message.customType),
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
								this.settingsManager.getLatexRenderingEnabled(),
								markdownTransformers,
								undefined,
								undefined,
								{
									hasTranscript: (taskId) => {
										const lease = getOwnerTaskStore(this.session)?.resolveTask(taskId);
										return lease?.ok ? taskTranscriptSource(lease.value).ok : false;
									},
									loadTranscript: async (taskId, options) => {
										const lease = getOwnerTaskStore(this.session)?.resolveTask(taskId);
										return lease?.ok ? readTaskCompletionHistory(lease.value, options?.signal) : undefined;
									},
									getToolDefinition: (toolName) => this.getRegisteredToolDefinition(toolName),
									cwd: this.sessionManager.getCwd(),
									requestRender: () => this.ui.requestRender(),
								},
							);
				component.setExpanded(this.toolOutputExpanded);
				messageComponents.add(component);
				noteRowSource(component, { message, part: 0 });
				this.chatContainer.addChild(component);
			}
			break;
		}
		case "branchSummary": {
			this.chatContainer.addChild(new Spacer(1));
			const component = new BranchSummaryMessageComponent(
				message,
				this.getMarkdownThemeWithSettings(),
				this.settingsManager.getLatexRenderingEnabled(),
				this.outputPad,
				markdownTransformers,
			);
			component.setExpanded(this.toolOutputExpanded);
			messageComponents.add(component);
			noteRowSource(component, { message, part: 0 });
			this.chatContainer.addChild(component);
			break;
		}
		case "user": {
			const textContent = this.getUserMessageText(message);
			if (textContent) {
				if (this.chatContainer.children.length > 0) {
					this.chatContainer.addChild(new Spacer(1));
				}
				const skillBlock = parseSkillBlock(textContent);
				if (skillBlock) {
					// Render skill block (collapsible)
					const component = new SkillInvocationMessageComponent(
						skillBlock,
						this.getMarkdownThemeWithSettings(),
						this.settingsManager.getLatexRenderingEnabled(),
						this.outputPad,
						markdownTransformers,
					);
					component.setExpanded(this.toolOutputExpanded);
					if (!skillBlock.userMessage) messageComponents.add(component);
					noteRowSource(component, { message, part: 0 });
					this.chatContainer.addChild(component);
					// Render user message separately if present
					if (skillBlock.userMessage) {
						const userComponent = new UserMessageComponent(
							skillBlock.userMessage,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							markdownTransformers,
							this.settingsManager.getLatexRenderingEnabled(),
						);
						messageComponents.add(userComponent);
						noteRowSource(userComponent, { message, part: 0 });
						this.chatContainer.addChild(userComponent);
					}
				} else {
					const userComponent = new UserMessageComponent(
						textContent,
						this.getMarkdownThemeWithSettings(),
						this.outputPad,
						markdownTransformers,
						this.settingsManager.getLatexRenderingEnabled(),
					);
					messageComponents.add(userComponent);
					noteRowSource(userComponent, { message, part: 0 });
					this.chatContainer.addChild(userComponent);
				}
				if (options?.populateHistory) {
					addMainPromptHistory(this.editor, textContent);
				}
			}
			break;
		}
		case "assistant": {
			const assistantComponent = new AssistantMessageComponent(
				message,
				this.hideThinkingBlock,
				this.getMarkdownThemeWithSettings(),
				this.hiddenThinkingLabel,
				this.outputPad,
				markdownTransformers,
				false,
				this.settingsManager.getLatexRenderingEnabled(),
			);
			messageComponents.add(assistantComponent);
			noteRowSource(assistantComponent, { message, part: 0 });
			this.chatContainer.addChild(assistantComponent);
			break;
		}
		case "toolResult": {
			// Tool results are rendered inline with tool calls, handled separately
			break;
		}
		default:
			break;
	}
};

InteractiveModeBase.prototype.renderSessionContext = function (
	this: InteractiveModeBase,
	sessionContext: SessionContext,
	options: { updateFooter?: boolean; populateHistory?: boolean } = {},
): void {
	this.pendingTools.clear();
	const pendingEchoes = takeDeferredEchoes(this);

	if (options.updateFooter) {
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}

	const grouping = mainToolGrouping(this);
	resetMainToolGroup(this);
	const entries = chatEntriesFromAgentMessages(sessionContext.messages, undefined, { tracker: grouping.tracker });
	renderGroupedChatEntries(this, entries, (entry, component) => {
		if (entry.kind === "tool" && entry.isPartial !== false && component instanceof ToolExecutionComponent) {
			this.pendingTools.set(entry.toolCallId, component);
		}
		if (options.populateHistory && entry.kind === "user") {
			addMainPromptHistory(this.editor, entry.text);
		}
	});

	restoreDeferredEchoes(this, pendingEchoes);

	this.ui.requestRender();
};

interface ReplyNotices {
	message: AssistantMessage;
	previousReply: AssistantMessage | undefined;
	previousRequest: PreviousRequest | undefined;
	models: ModelPriceSource;
	summarizedParent?: string;
	/** On a saved page: the dropped thinking blocks of the reply read before the page, unknown when none was. */
	earlier?: { readonly drops: number | undefined };
	repeated?: {
		occurrences: ReplyNotices[];
		resolved?: true;
		owner?: ReplyNotices;
		miss?: ReturnType<typeof cacheMissAfter>;
	};
}

function missForOccurrence(notes: ReplyNotices): ReturnType<typeof cacheMissAfter> {
	const group = notes.repeated;
	if (!group) return cacheMissAfter(notes.previousRequest, notes.message, notes.models);
	// The cache statistics fold records the last miss for each saved object. Retain its exact occurrence,
	// even when a later occurrence of that same object wasn't a miss. Distinct equal objects remain distinct.
	if (!group.resolved) {
		group.resolved = true;
		for (let i = group.occurrences.length - 1; i >= 0; i--) {
			const candidate = group.occurrences[i]!;
			const miss = cacheMissAfter(candidate.previousRequest, candidate.message, candidate.models);
			if (miss) {
				group.owner = candidate;
				group.miss = miss;
				break;
			}
		}
	}
	return group.owner === notes ? group.miss : undefined;
}

function precedingDropCount(mode: InteractiveModeBase, notes: ReplyNotices): number | undefined {
	if (notes.previousReply) return countDroppedThinkingBlocks(notes.previousReply);
	if (notes.earlier) return notes.earlier.drops;
	// The provider's cumulative count does not start over at a summary. Only the first visible reply can
	// need an omitted predecessor. Do not fetch old message bodies or guess when a tail-only reader lacks it.
	let id = notes.summarizedParent;
	if (id === undefined) return 0;
	const seen = new Set<string>();
	while (!seen.has(id)) {
		seen.add(id);
		const entry = mode.sessionManager?.getEntry(id);
		if (!entry) return undefined;
		if (entry.type === "message" && entry.message.role === "assistant")
			return countDroppedThinkingBlocks(entry.message);
		if (!entry.parentId) return 0;
		id = entry.parentId;
	}
	return undefined;
}

function paintReplyNotices(mode: InteractiveModeBase, notes: ReplyNotices): void {
	const { message } = notes;
	if (message.stopReason !== "aborted" && message.stopReason !== "error") {
		const count = countDroppedThinkingBlocks(message);
		if (count > 0) {
			const previous = precedingDropCount(mode, notes);
			if (previous !== undefined) addThinkingDrop(mode, count, previous);
		}
	}
	const miss = missForOccurrence(notes);
	if (miss) mode.chatContainer.addChild(new Text(theme.fg("warning", formatCacheMissNotice(miss)), 1, 0));
}

type TranscriptStep =
	| { readonly kind: "entry"; readonly entry: ChatMessageEntry; readonly notices?: ReplyNotices }
	| { readonly kind: "custom"; readonly entry: CustomEntry }
	| {
			readonly kind: "cost";
			readonly type: "compaction" | "branch_summary";
			readonly usage: Usage;
			/** The saved entry whose cost this is, on a saved page. */
			readonly seq?: number;
	  };

const TAIL_STEPS = 32;
const PARKED_TAIL_STEPS = 128;
const TAIL_PLAN_ENTRIES = 32;
const HISTORY_PLAN_CHUNK_ENTRIES = 64;
const MAX_TAIL_SCAN_ENTRIES = 512;
const EDITOR_PROMPT_HISTORY_LIMIT = 100;
const HISTORY_SLICE_BUDGET_MS = 8;
const HISTORY_SLICE_STEPS = 24;

function isCleanUserTurnEntry(entry: SessionEntry): boolean {
	if (entry.type !== "message" || entry.message.role !== "user") return false;
	return extractMessageText(normalizeMessageContent(entry.message).content).trim().length > 0;
}

/**
 * Find a sound split index `cut` in `(0, end)` so `entries.slice(cut, end)` can be planned independently without
 * affecting tool-call pairing, aborted-turn settlement, tool grouping, or notice-before-prompt ordering. Returns 0
 * when no clean boundary exists within `maxScan` entries (falling back to planning the whole range together).
 */
function findSafeHistorySplit(
	entries: readonly SessionEntry[],
	end: number,
	targetEntries: number,
	maxScan: number,
): number {
	if (end <= targetEntries) return 0;
	const minIndex = Math.max(1, end - maxScan);
	const unmatchedResults = new Set<string>();
	let fallbackCut = 0;
	for (let i = end - 1; i >= minIndex; i--) {
		const entry = entries[i]!;
		if (entry.type === "message") {
			const msg = entry.message;
			if (msg.role === "toolResult") {
				unmatchedResults.add(msg.toolCallId);
			} else if (msg.role === "assistant") {
				if (msg.stopReason === "aborted" || msg.stopReason === "error") return 0;
				if (Array.isArray(msg.content)) {
					for (const block of msg.content) {
						if (block.type === "toolCall") unmatchedResults.delete(block.id);
					}
				}
			} else if (
				msg.role === "user" &&
				unmatchedResults.size === 0 &&
				isCleanUserTurnEntry(entry) &&
				chatPosition(entries[i - 1]!).role !== "notice"
			) {
				if (end - i >= targetEntries) return i;
				fallbackCut = i;
			}
		}
	}
	return unmatchedResults.size === 0 ? fallbackCut : 0;
}

/**
 * Populate editor Up-arrow history with the last `EDITOR_PROMPT_HISTORY_LIMIT` adjacent-deduplicated user prompts,
 * scanning from the tail instead of replaying every user turn in a huge transcript.
 */
function populateRecentPromptHistory(mode: InteractiveModeBase, sessionEntries: readonly SessionEntry[]): void {
	const recent: string[] = [];
	for (let i = sessionEntries.length - 1; i >= 0 && recent.length < EDITOR_PROMPT_HISTORY_LIMIT; i--) {
		const entry = sessionEntries[i]!;
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = extractMessageText(normalizeMessageContent(entry.message).content).trim();
		if (!text || recent.at(-1) === text) continue;
		recent.push(text);
	}
	for (let i = recent.length - 1; i >= 0; i--) addMainPromptHistory(mode.editor, recent[i]!);
}

/**
 * Where a saved page's replies start from, as the whole chat reaches them: the request and the dropped thinking of
 * the entries read right before the page. Without a reply among them or the start of the branch, the count is unknown.
 */
function earlierReplies(earlier: SavedPageEarlier | undefined): {
	request: PreviousRequest | undefined;
	drops: number | undefined;
} {
	let request: PreviousRequest | undefined;
	let drops = earlier?.root ? 0 : undefined;
	for (const entry of earlier?.entries ?? []) {
		request = advanceCacheHistory(request, entry);
		if (entry.type === "message" && entry.message.role === "assistant")
			drops = countDroppedThinkingBlocks(entry.message);
	}
	return { request, drops };
}

function planTranscript(
	mode: InteractiveModeBase,
	sessionEntries: SessionEntry[],
	options: {
		populateHistory?: boolean;
		suppressCompactionBoundary?: VerbatimCompactionResult;
		saved?: { seqs: Map<SessionEntry, number>; owners: WeakMap<object, string>; earlier?: SavedPageEarlier };
		localGrouping?: MainToolGrouping;
		headers?: ReopenedCompletionHeaders;
	},
	layout?: ChatReaderLayout,
): TranscriptStep[] {
	const steps: TranscriptStep[] = [];
	const grouping: MainToolGrouping =
		options.localGrouping ??
		(options.saved
			? {
					tracker: new ToolGroupTracker({ groupBash: false }),
					starts: new Map(),
					lastMember: undefined,
					carriedBreak: false,
				}
			: mainToolGrouping(mode));
	if (!options.saved && !options.localGrouping) resetMainToolGroup(mode);
	let messageBuffer: AgentMessage[] = [];
	const sources = layout ? ([] as string[]) : undefined;
	const messageMeta = new Map<AgentMessage, PersistedMessageMeta>();
	const messageSeq = options.saved ? new Map<AgentMessage, number>() : undefined;
	const models = mode.settingsManager.getShowCacheMissNotices()
		? createCacheMissModelSource(mode.session.modelRuntime)
		: undefined;
	// A saved page goes on from the entries read right before it, as the whole chat goes on from them.
	const earlier = options.saved && models ? earlierReplies(options.saved.earlier) : undefined;
	let previousRequest: PreviousRequest | undefined = earlier?.request;
	let previousReply: AssistantMessage | undefined;
	const replyGroups: ReplyNotices[] = [];
	let firstMessage = true;
	const firstOccurrence = models && new WeakMap<AssistantMessage, ReplyNotices>();
	const boundary = sessionEntries[0];
	const firstParent = sessionEntries[1]?.parentId;
	const summarizedParent =
		boundary?.type === "compaction"
			? ((firstParent === boundary.id ? boundary.parentId : firstParent) ?? undefined)
			: undefined;
	const flushMessages = (): void => {
		if (options.suppressCompactionBoundary && firstMessage) {
			// A boundary replays after the system prompt it recorded, so the boundary is the first non-system message.
			const boundaryIndex = messageBuffer.findIndex((message) => message.role !== "system");
			if (isSynthesizedCompactionBoundary(messageBuffer[boundaryIndex], options.suppressCompactionBoundary)) {
				messageBuffer = messageBuffer.filter((_, index) => index !== boundaryIndex);
				sources?.splice(boundaryIndex, 1);
			}
		}
		firstMessage = false;
		if (options.saved || options.localGrouping) grouping.tracker.break();
		else breakMainToolGroup(mode);
		const saved = options.saved;
		// Pair by occurrence, not by message identity: an SDK caller can append the very same object twice.
		let occurrence = 0;
		const groups = replyGroups.length ? new Map<ChatMessageEntry, ReplyNotices>() : undefined;
		let source = 0;
		const entries = chatEntriesFromAgentMessages(messageBuffer, messageMeta, {
			tracker: grouping.tracker,
			...(saved && messageSeq
				? {
						onSourceRow: (e: ChatMessageEntry, message: AgentMessage, block: number) =>
							saved.owners.set(e, `${messageSeq.get(message)}:${block}`),
					}
				: {}),
			onMessageGroup: layout && sources ? (row) => layout.bind(sources[source++]!, row) : undefined,
			onAssistantGroup: groups && ((lastRow) => groups.set(lastRow, replyGroups[occurrence++]!)),
		});
		for (const entry of entries) {
			if (entry.kind === "tool" && entry.isPartial !== false) {
				const startedAt = grouping.starts.get(entry.toolCallId);
				if (startedAt !== undefined) {
					entry.executionStarted = true;
					entry.startedAt = startedAt;
					entry.argsComplete = true;
				}
			}
			if (entry.kind === "assistant")
				grouping.carriedBreak = assistantCallBreaks(entry.message.content, grouping.carriedBreak).trailing;
			else if (entry.kind !== "tool") grouping.carriedBreak = false;
			steps.push({ kind: "entry", entry, notices: groups?.get(entry) });
			if (options.populateHistory && entry.kind === "user") addMainPromptHistory(mode.editor, entry.text);
		}
		replyGroups.length = 0;
		if (sources) sources.length = 0;
		messageBuffer = [];
	};
	const headers =
		options.headers ??
		new ReopenedCompletionHeaders(
			() => ({
				entries: mode.sessionManager.getBranch(),
				recovery: mode.sessionManager.getSessionRecoveryState(),
			}),
			isProxy,
		);
	for (const entry of sessionEntries) {
		if (entry.type === "custom") {
			// An unrendered record between a tool call and its result must not split them into two cards.
			if (!mode.session.extensionRunner.getEntryRenderer(entry.customType)) continue;
			const seq = options.saved ? options.saved.seqs.get(entry) : mode.sessionManager?.getEntrySeq?.(entry.id);
			if (seq !== undefined) noteSavedSeq(entry, seq);
			flushMessages();
			if (options.saved) options.saved.owners.set(entry, `${options.saved.seqs.get(entry)}:entry`);
			steps.push({ kind: "custom", entry });
			layout?.bind(entry.id, entry);
		} else {
			const messages = sessionEntryToDisplayMessages(entry, headers);
			const seq = options.saved ? options.saved.seqs.get(entry) : mode.sessionManager?.getEntrySeq?.(entry.id);
			for (const message of messages) {
				sources?.push(entry.id);
				messageMeta.set(message, { id: entry.id, timestamp: entry.timestamp });
				if (seq !== undefined) noteSavedSeq(message, seq);
				if (options.saved) messageSeq?.set(message, options.saved.seqs.get(entry)!);
				if (models && firstOccurrence && message.role === "assistant") {
					const notes: ReplyNotices = {
						message,
						previousReply,
						summarizedParent,
						previousRequest,
						models,
						...(earlier ? { earlier } : {}),
					};
					const saved = entry.type === "message" && entry.message.role === "assistant" ? entry.message : message;
					const first = firstOccurrence.get(saved);
					if (first) {
						notes.repeated = first.repeated ??= { occurrences: [first] };
						notes.repeated.occurrences.push(notes);
					} else firstOccurrence.set(saved, notes);
					replyGroups.push(notes);
					previousReply = message;
				}
			}
			if (models) previousRequest = advanceCacheHistory(previousRequest, entry);
			messageBuffer.push(...messages);
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
				flushMessages();
				const suppressedLiveBoundary =
					entry.type === "compaction" &&
					options.suppressCompactionBoundary !== undefined &&
					entry.summary === options.suppressCompactionBoundary.compactedText &&
					entry.tokensBefore === options.suppressCompactionBoundary.tokensBefore;
				const seq = options.saved?.seqs.get(entry);
				if (!suppressedLiveBoundary) {
					const cost: TranscriptStep = {
						kind: "cost",
						type: entry.type,
						usage: entry.usage,
						...(seq === undefined ? {} : { seq }),
					};
					steps.push(cost);
					layout?.extendGroup(entry.id, cost);
				}
			}
		}
	}
	flushMessages();
	return steps;
}

/** The rows a parked reader sees of entries a new context keeps, while that context is being drawn. */
const adoptions = new WeakMap<InteractiveModeBase, ParkedViewport & { inserted: boolean }>();

function stepKey(step: TranscriptStep): string | undefined {
	if (step.kind === "entry") return savedRowKey(step.entry);
	// A custom entry draws one row, from the entry itself.
	const seq = step.kind === "custom" ? savedSeqOf(step.entry) : undefined;
	return seq === undefined ? undefined : `${seq}:0`;
}

/** A kept entry the reader sees keeps its drawn rows: the first such step puts them all where it belongs. */
function adoptStep(mode: InteractiveModeBase, step: TranscriptStep): Component | undefined {
	const adoption = adoptions.get(mode);
	const key = adoption && stepKey(step);
	const component = key === undefined ? undefined : adoption?.keys.get(key);
	if (!adoption || !component) return undefined;
	if (!adoption.inserted) {
		for (const row of adoption.adopted) mode.chatContainer.addChild(row);
		adoption.inserted = true;
	}
	return component;
}

function addTranscriptStep(mode: InteractiveModeBase, step: TranscriptStep, latest = true, saved = false): void {
	const adopted = saved ? undefined : adoptStep(mode, step);
	if (step.kind === "custom") {
		if (!adopted) {
			const seq = savedSeqOf(step.entry);
			const kept = saved || seq === undefined ? undefined : storedWidget(mode, `${seq}:entry`);
			if (kept) mode.chatContainer.addChild(kept);
			else mode.addCustomEntryToChat(step.entry);
		}
		return;
	}
	if (step.kind === "cost") {
		mode.addCompactionCostNotice(step.type, step.usage);
		return;
	}
	const { entry } = step;
	const kept = saved || adopted ? undefined : storedWidget(mode, widgetKey(entry));
	if (kept) addChatTranscriptEntry(mode.chatContainer, kept, entry.role);
	const component = adopted ?? kept ?? mode.addRenderedChatEntry(entry);
	if (!saved && entry.kind === "tool" && isGroupedToolComponent(component)) {
		const grouping = mainToolGrouping(mode);
		grouping.tracker.bind(entry.toolCallId, groupedRowSink(component, entry), component);
		if (latest) grouping.lastMember = component;
	}
	if (entry.kind === "assistant" && !adopted) addServiceTierWarnings(mode, entry.message);
	if (step.notices && !adopted) paintReplyNotices(mode, step.notices);
	if (!saved && entry.kind === "tool" && entry.isPartial !== false && component instanceof ToolExecutionComponent) {
		mode.pendingTools.set(entry.toolCallId, component);
	}
}

/** A cost notice follows every row of its saved entry. */
const COST_BLOCK = Number.MAX_SAFE_INTEGER;

/** The saved entry and sub-block of a saved row key (`seq:block`, `seq:entry` or `seq:cost`). */
function savedLeaf(key: string): { seq: number; block: number } {
	const [seq, block] = key.split(":");
	return { seq: Number(seq), block: block === "entry" ? 0 : block === "cost" ? COST_BLOCK : Number(block) };
}

/**
 * Render an archived page on its own. Never register historical tools as pending in the live turn. When a later page
 * follows (`adjacent.newer`), calls the page ends with wait for it: their results start that page.
 *
 * With `copy`, the rows are drawn for a copy, not mounted: each row's saved position is noted there instead of
 * keeping its renderer, a kept instance is reused as it is, the page joins no mounted page, and the reads its edge
 * cards need are left in `copy.settled`. Mounted, a card whose call and result fall on different pages is marked
 * provisional: what it shows depends on the pages mounted, so a selection draws its entry again for a copy.
 */
function savedChatComponents(
	mode: InteractiveModeBase,
	entries: SessionEntry[],
	seqs: number[],
	exceptions: SavedRendererInstances,
	adjacent: { readonly older?: string; readonly newer?: string } | undefined,
	copy?: SavedCopyDraw,
	records?: SavedPageRecords,
	earlier?: SavedPageEarlier,
): Component[] {
	const scratch = new Container();
	// Each page draws after earlier rows, as the whole transcript does: its first message keeps its spacing.
	scratch.addChild(new Spacer(0));
	const chat = mode.chatContainer;
	try {
		mode.chatContainer = scratch;
		const saved = {
			seqs: new Map(entries.map((e, i) => [e, seqs[i]!])),
			owners: new WeakMap<object, string>(),
			earlier,
		};
		// The page's saved lines go where the whole chat draws them: after the last row of their entry's group.
		const layout = records ? new ChatReaderLayout(entries, scratch, { root: records.root }) : undefined;
		const steps = planTranscript(mode, entries, { saved }, layout);
		/** Each drawn row's saved leaf, for the saved lines drawn after it. */
		const leaves = new Map<Component, HistoryLeaf>();
		const held = new Set(
			adjacent?.newer || copy?.edges.newer
				? callsAwaitingLaterResults(steps.flatMap((step) => (step.kind === "entry" ? [step.entry] : [])))
				: [],
		);
		const calls = new SavedPageCallsBuilder(mode, chat, seqs, exceptions, copy !== undefined);
		const mark = (components: readonly Component[], key: string, provisional: boolean) => {
			const { seq, block } = savedLeaf(key);
			for (let part = 0; part < components.length; part++)
				leaves.set(components[part]!, { source: exceptions.source, seq, block, part });
			for (let part = 0; part < components.length; part++)
				if (copy) copy.positions.set(components[part]!, { source: exceptions.source, seq, block, part });
				else
					WindowedContainer.markHistoryComponent(
						components[part]!,
						exceptions.source,
						seq,
						block,
						part,
						provisional,
					);
		};
		for (const step of steps) {
			const key =
				step.kind !== "cost"
					? saved.owners.get(step.entry)
					: step.seq === undefined
						? undefined
						: `${step.seq}:cost`;
			const index = scratch.children.length;
			if (step.kind === "entry" && step.entry.kind === "tool" && held.has(step.entry)) {
				const slot = calls.hold(step.entry, key);
				scratch.addChild(slot);
				if (key) mark([slot], key, true);
				layout?.paint(step.entry, scratch, index);
				continue;
			}
			const kept = key && (copy ? exceptions.peek(key) : exceptions.get(key));
			if (kept) for (const component of kept) scratch.addChild(component);
			else addTranscriptStep(mode, step, false, true);
			layout?.paint(step.kind === "cost" ? step : step.entry, scratch, index);
			const drawn = scratch.children.slice(index);
			if (key) {
				const { seq, block } = savedLeaf(key);
				for (let part = 0; part < drawn.length; part++)
					leaves.set(drawn[part]!, { source: exceptions.source, seq, block, part });
			}
			const alone = step.kind === "entry" && step.entry.kind === "tool" && isResultWithoutCall(step.entry);
			if (key) {
				if (!copy && !kept) exceptions.remember(key, drawn, savedLeaf(key));
				if (copy || alone) {
					// The widget is owned by its saved result, but the document places a paired card at its call.
					const at =
						copy && step.kind === "entry" && step.entry.kind === "tool" ? savedRowKey(step.entry) : undefined;
					mark(drawn, at ?? key, alone);
				}
				followChosenExpansion(mode, exceptions, key, drawn);
			}
			if (step.kind !== "entry") continue;
			if (key && alone && step.entry.kind === "tool")
				calls.drewResult(
					step.entry,
					drawn,
					key,
					copy
						? () => {
								for (const child of drawn) copy.positions.delete(child);
							}
						: undefined,
				);
			calls.drew(step.entry);
		}
		if (layout && records) {
			layout.apply(scratch, records.data);
			markRecordRows(scratch.children, leaves, (row, leaf) => {
				if (copy) copy.positions.set(row, leaf);
				else WindowedContainer.markHistoryComponent(row, leaf.source, leaf.seq, leaf.block, leaf.part);
			});
		}
		const page = scratch.children.slice(1);
		if (copy) copy.settled = calls.settle(mode.sessionManager, copy.edges, copy.alive);
		else if (page.length > 0) page.unshift(calls.finish(mode.sessionManager, adjacent));
		return page;
	} finally {
		mode.chatContainer = chat;
	}
}

/**
 * Give each saved line of a page the saved leaf right after the row it follows, so a selection or a copy places it
 * where the page shows it. A line ahead of every row of the page goes just before the first one.
 */
function markRecordRows(
	rows: readonly Component[],
	leaves: ReadonlyMap<Component, HistoryLeaf>,
	mark: (row: Component, leaf: HistoryLeaf) => void,
): void {
	let previous: HistoryLeaf | undefined;
	let leading: Component[] = [];
	for (const row of rows) {
		const leaf = leaves.get(row);
		if (leaf) {
			for (let i = 0; i < leading.length; i++) mark(leading[i]!, { ...leaf, part: leaf.part - leading.length + i });
			leading = [];
			previous = leaf;
			continue;
		}
		if (!chatDecorationRow(row)) continue;
		if (!previous) {
			leading.push(row);
			continue;
		}
		previous = { ...previous, part: previous.part + 1 };
		mark(row, previous);
	}
}

interface UnplannedHistory {
	readonly entries: SessionEntry[];
	remainingEnd: number;
	readonly headers: ReopenedCompletionHeaders;
}

function buildHistoryInSlices(
	mode: InteractiveModeBase,
	history: readonly TranscriptStep[],
	end: Component,
	layout?: WeakRef<ChatReaderLayout>,
	unplanned?: UnplannedHistory,
): void {
	const chat = mode.chatContainer;
	let pendingSteps: readonly TranscriptStep[] = history;
	let remaining = pendingSteps.length;
	let before = end;
	const hasMore = (): boolean => remaining > 0 || (unplanned !== undefined && unplanned.remainingEnd > 0);
	const planNextChunk = (planAll: boolean): void => {
		if (!unplanned || unplanned.remainingEnd <= 0) return;
		const chunkEnd = unplanned.remainingEnd;
		const chunkStart = planAll
			? 0
			: findSafeHistorySplit(unplanned.entries, chunkEnd, HISTORY_PLAN_CHUNK_ENTRIES, MAX_TAIL_SCAN_ENTRIES);
		const localGrouping: MainToolGrouping = {
			tracker: new ToolGroupTracker({ groupBash: false }),
			starts: mainToolGrouping(mode).starts,
			lastMember: undefined,
			carriedBreak: false,
		};
		const activeLayout = layout?.deref();
		const chunkSteps = planTranscript(
			mode,
			unplanned.entries.slice(chunkStart, chunkEnd),
			{ populateHistory: false, localGrouping, headers: unplanned.headers },
			activeLayout,
		);
		unplanned.remainingEnd = chunkStart;
		activeLayout?.advancePlannedFrom(chunkStart);
		pendingSteps = chunkSteps;
		remaining = chunkSteps.length;
	};
	const build = (budgetMs: number, maxSteps: number): boolean => {
		const at = chat.children.indexOf(before);
		if (at < 0 || !hasMore()) return false;
		const finishAll = !Number.isFinite(budgetMs);
		const deadline = performance.now() + budgetMs;
		const built: Component[][] = [];
		const preceding = new Spacer(0);
		const scratch = new Container();
		mode.chatContainer = scratch;
		try {
			let steps = 0;
			while (steps < maxSteps && hasMore()) {
				if (remaining === 0) {
					planNextChunk(finishAll);
					if (remaining === 0) continue;
				}
				scratch.children = [preceding];
				const step = pendingSteps[--remaining]!;
				addTranscriptStep(mode, step, false);
				layout?.deref()?.paint(step.kind === "cost" ? step : step.entry, scratch, 1);
				built.push(scratch.children.slice(1));
				steps++;
				if (performance.now() >= deadline) break;
			}
		} finally {
			mode.chatContainer = chat;
		}
		const components = built.reverse().flat();
		if (components.length > 0) {
			if (chat instanceof StartupChatContainer) chat.insertChildren(at, components);
			else chat.children.splice(at, 0, ...components);
			before = components[0]!;
			const messages = components.filter(isChatMessageComponent).length;
			if (messages > 0) (mode.ui as AltScreenMessageCounterHost).newMessages?.historyPrepended(messages);
			mode.ui.requestRender();
		}
		if (hasMore()) return true;
		chat.removeChild(end);
		return false;
	};
	const tracked = trackChatHistoryBuild(chat, () => {
		build(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
		tracked.done();
	});
	const slice = (): void => {
		if (build(HISTORY_SLICE_BUDGET_MS, HISTORY_SLICE_STEPS)) setImmediate(slice);
		else tracked.done();
	};
	setImmediate(slice);
}

InteractiveModeBase.prototype.renderSessionEntries = function (
	this: InteractiveModeBase,
	sessionEntries: SessionEntry[],
	options: {
		updateFooter?: boolean;
		populateHistory?: boolean;
		preserveViewportInput?: boolean;
		suppressCompactionBoundary?: VerbatimCompactionResult;
		/** @internal The rows a reader parked above the end sees, taken out of the chat this replaces. */
		parked?: ParkedViewport;
	} = {},
): void {
	if (!options.preserveViewportInput && !options.parked) this.resetTranscriptSelection();
	this.pendingTools.clear();
	const pendingEchoes = takeDeferredEchoes(this);
	if (options.updateFooter) {
		this.footer.invalidate();
		this.updateEditorBorderColor();
	}
	const parked = options.parked;
	installSavedChatHistory(this, sessionEntries, savedChatComponents, parked?.parked);
	noteShownContext(this, sessionEntries);
	const chat = this.chatContainer;
	const regular = this.ui.mode !== "fullscreen";
	const mount = sessionChatMount(this, this.sessionManager);
	let layout = mount ? new ChatReaderLayout(sessionEntries, chat) : undefined;
	if (layout) bindChatLayout(this, layout);
	// Saved lines a parked reader still sees stay in their rows; this drawing does not show them twice.
	if (layout && parked?.shownRecords) layout.keepShown(parked.shownRecords);
	const canSlicePlan =
		!regular &&
		!parked?.keys.size &&
		!options.suppressCompactionBoundary &&
		!this.settingsManager.getShowCacheMissNotices() &&
		sessionEntries.length > TAIL_PLAN_ENTRIES;
	const splitIndex = canSlicePlan
		? findSafeHistorySplit(sessionEntries, sessionEntries.length, TAIL_PLAN_ENTRIES, MAX_TAIL_SCAN_ENTRIES)
		: 0;
	let steps: TranscriptStep[];
	let unplanned: UnplannedHistory | undefined;
	if (splitIndex > 0) {
		if (options.populateHistory) populateRecentPromptHistory(this, sessionEntries);
		layout?.beginSlicedPlan(splitIndex);
		const headers = new ReopenedCompletionHeaders(
			() => ({
				entries: this.sessionManager.getBranch(),
				recovery: this.sessionManager.getSessionRecoveryState(),
			}),
			isProxy,
		);
		steps = planTranscript(
			this,
			sessionEntries.slice(splitIndex),
			{ ...options, populateHistory: false, headers },
			layout,
		);
		unplanned = { entries: sessionEntries, remainingEnd: splitIndex, headers };
	} else {
		steps = planTranscript(this, sessionEntries, options, layout);
	}
	// Only the drawn context's saved lines stay resident; a saved page reads its own with its rows.
	if (mount && layout) retainChatRecords(mount, () => layout?.anchors() ?? []);
	const initialTailSteps = parked?.keys.size ? PARKED_TAIL_STEPS : TAIL_STEPS;
	let tailStart = this.ui.mode === "fullscreen" ? Math.max(0, steps.length - initialTailSteps) : 0;
	if (parked?.keys.size) {
		// The reader's kept rows are drawn now, in place, so the first frame shows them where they were.
		const adopted = steps.findIndex((step) => {
			const key = stepKey(step);
			return key !== undefined && parked.keys.has(key);
		});
		if (adopted >= 0) {
			tailStart = Math.min(tailStart, adopted);
			adoptions.set(this, { ...parked, inserted: false });
		}
	}
	if (tailStart > 0 || unplanned !== undefined) {
		const historyEnd = new Spacer(0);
		this.chatContainer.addChild(historyEnd);
		buildHistoryInSlices(this, steps.slice(0, tailStart), historyEnd, layout && new WeakRef(layout), unplanned);
	}
	const adoption = adoptions.get(this);
	try {
		for (let index = tailStart; index < steps.length; index++) {
			const step = steps[index]!;
			const key = adoption && stepKey(step);
			const start = chat.children.length;
			addTranscriptStep(this, step);
			// An adopted row is where the reader saw it, with the saved lines drawn after it then.
			if (key === undefined || !adoption?.keys.has(key))
				layout?.paint(step.kind === "cost" ? step : step.entry, chat, start);
		}
	} finally {
		adoptions.delete(this);
		const unused = [...(adoption?.inserted ? [] : (parked?.adopted ?? [])), ...(parked?.parked?.rows ?? [])].filter(
			(row) => !this.chatContainer.children.includes(row),
		);
		disposeRemoteRenderers(unused);
	}
	if (mount && layout) {
		if (!regular && chat instanceof StartupChatContainer) {
			layout.observeWindowWhenPresent(chat, mount, () => this.ui.requestRender());
		} else {
			const page = readMountedAnchors(mount, () => layout?.anchors() ?? []);
			const apply = (data?: ChatPageDecorations) => {
				const changed = data !== undefined && layout?.apply(chat, data) === true;
				layout = undefined;
				return changed;
			};
			// The main-screen renderer writes the rows into the one frame it may hold for them; nothing renders again.
			if (chat instanceof StartupChatContainer)
				chat.awaitChatRecords(page, apply, this.ui, CHAT_RECORD_FIRST_PAINT_MS);
			else
				void page.then((data) => {
					if (apply(data)) this.ui.requestRender();
				});
		}
	}
	restoreDeferredEchoes(this, pendingEchoes);
	this.ui.requestRender();
};

InteractiveModeBase.prototype.attachStartupNoticesContainer = function (
	this: InteractiveModeBase,
	options: { resetDetached?: boolean } = {},
): void {
	const disclosureIndex = this.chatContainer.children.indexOf(this.resourceDisclosureContainer);
	const noticesIndex = this.chatContainer.children.indexOf(this.startupNoticesContainer);
	if (disclosureIndex >= 0 && noticesIndex >= 0) return;
	if (disclosureIndex < 0) {
		if (options.resetDetached) this.resourceDisclosureContainer.clear();
		if (noticesIndex >= 0) this.chatContainer.children.splice(noticesIndex, 0, this.resourceDisclosureContainer);
		else this.chatContainer.addChild(this.resourceDisclosureContainer);
	}
	if (noticesIndex < 0) {
		if (options.resetDetached) this.startupNoticesContainer.clear();
		this.chatContainer.addChild(this.startupNoticesContainer);
	}
};

const renderedSessionIds = new WeakMap<InteractiveModeBase, string>();
const nativeHistoryHints = new WeakMap<Container, Component>();

/** The terminal owns scrollback in regular mode: a resumed window cannot paint rows it never printed. */
function showNativeHistoryHint(mode: InteractiveModeBase): void {
	const notices = mode.startupNoticesContainer;
	const previous = nativeHistoryHints.get(notices);
	if (mode.ui.mode !== "regular" || !mode.sessionManager.getOmittedHistoryTotals?.()?.totalMessages) {
		if (previous) notices.removeChild(previous);
		return;
	}
	const hint =
		previous ??
		new ThemedText(
			() =>
				theme.fg(
					"dim",
					"Older messages: use terminal scrollback, ask the agent to read history://, or use /export.",
				),
			1,
			0,
		);
	if (!previous) nativeHistoryHints.set(notices, hint);
	if (!notices.children.includes(hint)) notices.addChild(hint);
}

export function clearChatForRerender(mode: InteractiveModeBase): void {
	releaseSavedChatHistory(mode);
	const renderer = mode.ui as AltScreenMessageCounterHost;
	if (mode.chatContainer.children.length > 0) {
		renderer.newMessages?.observe(renderer.isFollowingOutput !== false, countChatMessages(mode.chatContainer));
	}
	mode.chatContainer.clear();
}

InteractiveModeBase.prototype.renderInitialMessages = function (this: InteractiveModeBase): void {
	const sessionId = this.sessionManager.getSessionId();
	const previousSessionId = renderedSessionIds.get(this);
	renderedSessionIds.set(this, sessionId);
	const renderer = this.ui as AltScreenMessageCounterHost;
	if (previousSessionId !== sessionId) renderer.newMessages?.reset();
	this.attachStartupNoticesContainer({ resetDetached: true });
	showNativeHistoryHint(this);
	const entries =
		typeof this.sessionManager.buildContextEntries === "function"
			? this.sessionManager.buildContextEntries()
			: buildContextEntries(this.sessionManager.getEntries(), this.sessionManager.getLeafId());
	this.renderSessionEntries(entries, { updateFooter: true, populateHistory: true });
	renderProjectTrustWarningIfNeeded(this);
	refreshInteractiveTasks(this);
	if (previousSessionId === sessionId) {
		renderer.newMessages?.replaced(countChatMessages(this.chatContainer));
	}
};

/**
 * Says that the session's project is untrusted, for as long as it is. It reads the trust when the chat paints: an
 * isolated interactive host learns its engine's decision after the chat was drawn, and a decision that is still to be
 * made is neither trusted nor untrusted.
 */
class ProjectTrustWarning implements Component {
	private readonly visible: () => boolean;
	private readonly lines: Component[];

	constructor(visible: () => boolean, separated: boolean) {
		this.visible = visible;
		const text = new ThemedText(
			() =>
				theme.fg(
					"warning",
					`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart ${APP_NAME}.`,
				),
			1,
			0,
		);
		this.lines = separated ? [new Spacer(1), text] : [text];
	}

	render(width: number): string[] {
		return this.visible() ? this.lines.flatMap((line) => line.render(width)) : [];
	}

	invalidate(): void {
		for (const line of this.lines) line.invalidate();
	}
}

/** The chat slot of the warning a mode last drew, while the chat still holds it. */
const projectTrustWarningSlots = new WeakMap<InteractiveModeBase, Container>();

function projectTrustWarningShows(mode: InteractiveModeBase, requiresTrust: boolean): boolean {
	return projectTrustWarningVisible({
		trusted: mode.settingsManager.isProjectTrusted(),
		pending: mode.runtimeHost?.isProjectTrustPending?.() === true,
		requiresTrust,
	});
}

/**
 * Adds the warning at the end of the chat when the session's project is untrusted and has resources that need trust.
 * A trusted session, or one whose decision is still to be made, gets none here: refreshProjectTrustWarning adds it if
 * the decision turns out untrusted.
 */
function renderProjectTrustWarningIfNeeded(mode: InteractiveModeBase): void {
	if (!projectTrustWarningShows(mode, true)) return;
	const chat = mode.chatContainer;
	const separated = chat.children.length > 0;
	const slot = new Container();
	chat.addChild(slot);
	projectTrustWarningSlots.set(mode, slot);
	const settle = (requiresTrust: boolean) => {
		if (!chat.children.includes(slot)) return;
		if (!requiresTrust) {
			chat.removeChild(slot);
			return;
		}
		slot.addChild(new ProjectTrustWarning(() => projectTrustWarningShows(mode, true), separated));
		mode.ui.requestRender();
	};
	void hasTrustRequiringProjectResourcesAsync(mode.sessionManager.getCwd()).then(settle, () => settle(false));
}

InteractiveModeBase.prototype.appendProjectTrustWarning = function (this: InteractiveModeBase): void {
	renderProjectTrustWarningIfNeeded(this);
};

InteractiveModeBase.prototype.refreshProjectTrustWarning = function (this: InteractiveModeBase): void {
	// Before the chat shows this session, its own drawing adds the warning.
	if (renderedSessionIds.get(this) !== this.sessionManager.getSessionId()) return;
	const slot = projectTrustWarningSlots.get(this);
	if (slot && this.chatContainer.children.includes(slot)) {
		// The warning in the chat reads the trust when it paints.
		this.chatContainer.invalidate();
	} else {
		renderProjectTrustWarningIfNeeded(this);
	}
	this.ui.requestRender();
};

InteractiveModeBase.prototype.getUserInput = async function (
	this: InteractiveModeBase,
): Promise<InteractiveSubmission> {
	while (true) {
		const queuedInput = this.pendingUserInputs.shift();
		if (queuedInput !== undefined) {
			return queuedInput;
		}

		if (this.startupReplayActiveInput) {
			await this.drainStartupReplayCommands();
			continue;
		}

		return new Promise((resolve) => {
			this.onInputCallback = (submission: InteractiveSubmission) => {
				this.onInputCallback = undefined;
				resolve(submission);
			};
			if (!this.inputHandlerReadyRecorded) {
				this.inputHandlerReadyRecorded = true;
				recordTimeSinceReset("interactive-input-handler-ready");
				markLifecycleTiming("interactive-input-handler-ready");
				void (async () => {
					await yieldToEventLoop();
					const deferredStartup = this.deferredStartupPending ? this.ensureDeferredStartupComplete() : undefined;
					deferredStartup?.catch(() => {});
					this.footerDataProvider.startGitWatcher();
					// pi parity: the changelog/first-run notices need nothing from
					// extensions — render them right after the input handler is ready
					// instead of gating them behind the deferred extension reload (or,
					// when the user types immediately, behind the whole agent turn).
					if (
						needsChangelogPreload(
							(this.session?.state?.messages?.length ?? 0) > 0,
							this.settingsManager?.getLastChangelogVersion?.(),
							VERSION,
						)
					) {
						await preloadChangelog(getChangelogPath());
					}
					this.showStartupNoticesIfNeeded(this.startupNoticesContainer);
					await deferredStartup;
				})().catch((error) => {
					const message = error instanceof Error ? error.message : String(error);
					console.error(`Deferred input-readiness startup task failed: ${message}`);
				});
			}
		});
	}
};

InteractiveModeBase.prototype.rebuildChatFromMessages = function (
	this: InteractiveModeBase,
	options: {
		suppressCompactionBoundary?: VerbatimCompactionResult;
		resetStartupDisclosure?: boolean;
		preserveViewportInput?: boolean;
	} = {},
): void {
	// Generic rebuilds keep the same session: pending fd/rg callbacks still own
	// this transcript. Full session replacements invalidate their generation in
	// renderCurrentSessionState() before rebuilding the replacement transcript.
	const renderer = this.ui as AltScreenMessageCounterHost;
	this.managedToolStatusStarted = false;
	this.lastStatusSpacer = undefined;
	this.lastStatusText = undefined;
	const entries =
		typeof this.sessionManager.buildContextEntries === "function"
			? this.sessionManager.buildContextEntries()
			: buildContextEntries(this.sessionManager.getEntries(), this.sessionManager.getLeafId());
	// Count what arrived unread before the rows the reader sees leave the chat with the rest.
	if (this.chatContainer.children.length > 0) {
		renderer.newMessages?.observe(renderer.isFollowingOutput !== false, countChatMessages(this.chatContainer));
	}
	// A compaction while the reader is above the end keeps what they see, their selection and their place.
	const parked = parkViewport(this, entries);
	holdCompactionWidgets(this, entries, parked);
	clearChatForRerender(this);
	if (options.resetStartupDisclosure) this.resourceDisclosureContainer.clear();
	this.attachStartupNoticesContainer();
	showNativeHistoryHint(this);
	this.renderSessionEntries(entries, parked ? { ...options, parked } : options);
	// A caller that suppresses the persisted boundary appends the live one, then the warning (appendProjectTrustWarning).
	if (!options.suppressCompactionBoundary) renderProjectTrustWarningIfNeeded(this);
	renderer.newMessages?.replaced(countChatMessages(this.chatContainer));
};

function isSynthesizedCompactionBoundary(message: AgentMessage | undefined, result: VerbatimCompactionResult): boolean {
	if (message?.role !== "custom" || message.customType !== "compaction" || !message.display) return false;
	const details = message.details as { strategy?: string } | undefined;
	if (details?.strategy !== "verbatim-lines") return false;
	const content = Array.isArray(message.content)
		? message.content
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("\n")
		: message.content;
	return stripVerbatimCompactionPrefix(content) === result.compactedText;
}

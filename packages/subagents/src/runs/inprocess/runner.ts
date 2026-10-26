import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	applyAssistantMessageDelta,
	beginStreamingAssistantMessage,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	getBuiltinPackagePaths,
	type PackageSource,
	SessionManager,
	type SessionStats,
	SettingsManager,
	type SubagentIntercomIdentity,
} from "@bastani/atomic";
import {
	type ChildIdentity,
	type NativeAdmissionResult,
	type AgentStatus as NativeAgentStatus,
	type NativeExecutionGuardResult,
	type TerminationCause as NativeTerminationCause,
	SubagentControl,
} from "@bastani/atomic-natives";
import { type Api, type AssistantMessage, clampThinkingLevel, type Model } from "@bastani/pi-ai/compat";
import type { Cleanup } from "../../../../coding-agent/src/core/tasks/contracts.js";
import type { AgentConfig } from "../../agents/agent-types.js";
import {
	buildSkillInjection,
	isSubagentOrchestrationSkillSelector,
	resolveSkillsFromCatalog,
} from "../../agents/skills.js";
import { childAllowsIntercom } from "../../intercom/supervisor-authorization.js";
import { ensureArtifactsDir, writeArtifact, writeMetadata } from "../../shared/artifacts.js";
import { DEFAULT_MAX_JSONL_BYTES } from "../../shared/jsonl-writer.js";
import { resolveEffectiveThinking, splitKnownThinkingSuffix, taskRecordModel } from "../../shared/model-info.js";
import {
	type AgentProgress,
	type ArtifactPaths,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	type TaskExecutionHooks,
	type TestSessionQueue,
	truncateOutput,
} from "../../shared/types.js";
import {
	lastNonEmptyAssistantText,
	PARENT_CANCEL_CAUSE,
	recoverCancelledChildOutput,
} from "../shared/cancellation-recovery.js";
import { type ChildModePolicy, resolveChildModePolicy } from "./child-policy.js";
import { createInProcessChildPromptBehavior, createInProcessChildSystemPromptTransform } from "./prompt-behavior.js";

export type ChildStatus = NativeAgentStatus | "killed";
export type ContinuationReason = "intercom-coordination";
export type TerminationCauseName = NativeTerminationCause;
export type TerminalStatus = "ok" | "error" | "skipped" | "interrupted" | "killed" | "continued";

export interface ParentContext {
	readonly path: string;
	readonly depth: number;
	readonly sessionId?: string;
	readonly intercomGroup?: string;
	readonly workflowStageSubagentGuard?: boolean;
	readonly orchestrationContext?: CreateAgentSessionOptions["orchestrationContext"];
	readonly getChildSessionOptions?: (options: CreateAgentSessionOptions) => CreateAgentSessionOptions;
	readonly resourceLoaderInheritanceSnapshot?: import("@bastani/atomic").DefaultResourceLoaderInheritanceSnapshot;
}

export interface TestSessionOptions {
	readonly output?: string;
	readonly promptLogPath?: string;
	/** Hold a test prompt open until the caller releases the supplied promise. */
	readonly promptGate?: Promise<void>;
	/** Match AgentSession.abort() settling an active prompt without throwing. */
	readonly abortResolvesPrompt?: boolean;
	/** Emit a fallback event for tests that exercise live model metadata. */
	readonly fallbackModel?: string;
	/** Emit the effective thinking level applied to the fallback candidate. */
	readonly fallbackThinkingLevel?: string;
	/** Test-only session model exposed through the AgentSession accessors. */
	readonly sessionModel?: string;
	/** Test-only effective thinking level exposed through the AgentSession accessors. */
	readonly sessionThinkingLevel?: string;
	/** Test-only session events emitted in order after the initial agent_start event. */
	readonly events?: readonly AgentSessionEvent[];
	/** Deterministic events before the held prompt gate, for continuity scenarios. */
	readonly beforeGateEvents?: readonly AgentSessionEvent[];
	/** Seed an earlier assistant message so abort recovery can find real text. */
	readonly seededAssistantText?: string;
	/** After abort, append a thinking-only aborted message with no text. */
	readonly thinkingOnlyOnAbort?: boolean;
	/** Emit the fallback event before the prompt gate so abort can preserve live fallback metadata. */
	readonly fallbackBeforeGate?: boolean;
	/** Test-only disposal barrier/failure injection. */
	readonly dispose?: () => void | Promise<void>;
	/** Receives the stub session, to queue steering and follow-up messages as an SDK caller does. */
	readonly onSession?: (session: TestSessionQueue) => void;
}

export interface ChildSpec {
	readonly taskName: string;
	readonly task: string;
	readonly agent: AgentConfig;
	readonly cwd: string;
	readonly tools?: string[];
	readonly excludedTools?: string[];
	readonly mcpDirectTools?: string[];
	readonly skills?: string[];
	readonly customTools?: CreateAgentSessionOptions["customTools"];
	readonly model?: Model<Api>;
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly parent?: ParentContext;
	/** Typed identity/capability resolved by the parent before admission. */
	readonly intercom?: SubagentIntercomIdentity;
	readonly sessionManager?: SessionManager;
	/** The child reopens its own interrupted session, so its unreconciled deliveries are recovered before the task. */
	readonly resumeSession?: boolean;
	/** Follow-ups queued with the task prompt, in order: a resumed child's held messages, then its continuation. */
	readonly resumeFollowUps?: readonly string[];
	/** Told the child's own session, and the model it started on, for a launch no task host records. */
	readonly onChildSession?: TaskExecutionHooks["bindChildSession"];
	readonly onChildLaunch?: TaskExecutionHooks["bindChildLaunch"];
	readonly testSession?: boolean | TestSessionOptions;
	readonly artifactJsonlPath?: string;
	/**
	 * Fallback model candidates (full ids, optional `:thinking` suffix) handed to
	 * the SDK session so child fallback uses the exact classification and
	 * candidate-advancement behavior main chat and workflow stages share.
	 */
	readonly fallbackModels?: readonly string[];
	readonly isFallbackModelAllowed?: CreateAgentSessionOptions["isFallbackModelAllowed"];
	readonly onProgress?: (progress: AgentProgress) => void;
	/** Run-scoped progress.md path used to recover partial findings after parent abort. */
	readonly progressPath?: string;
	/** Persisted progress.md path to cite after parent cancellation. */
	readonly progressArtifactPath?: string;
	/** Persisted output artifact path to cite after parent cancellation. */
	readonly outputArtifactPath?: string;
}

export interface ChildPolicy extends ChildModePolicy {
	readonly cwd: string;
	readonly tools?: readonly string[];
	readonly excludedTools?: readonly string[];
	readonly mcpDirectTools?: readonly string[];
	readonly skills: readonly string[];
	readonly customTools?: CreateAgentSessionOptions["customTools"];
	readonly model?: Model<Api>;
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly intercomGroup?: string;
	readonly depth: number;
}

export interface ModelCandidate {
	readonly model?: Model<Api>;
	readonly modelId?: string;
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
}

function modelIdForCandidate(candidate: ModelCandidate, fallbackModel?: Model<Api>): string | undefined {
	return (
		candidate.modelId ??
		(candidate.model ? `${candidate.model.provider}/${candidate.model.id}` : undefined) ??
		(fallbackModel ? `${fallbackModel.provider}/${fallbackModel.id}` : undefined)
	);
}

function modelIdForSession(session: AgentSession | undefined): string | undefined {
	const model = session?.model;
	return model ? `${model.provider}/${model.id}` : undefined;
}

function thinkingLevelForSession(session: AgentSession | undefined): string | undefined {
	const thinking = session?.thinkingLevel;
	return typeof thinking === "string" ? thinking : undefined;
}

function initialThinkingForAttempt(
	model: string | undefined,
	configuredThinking: string | undefined,
): string | undefined {
	return resolveEffectiveThinking(model, configuredThinking) ?? configuredThinking;
}

export interface AttemptSignals {
	readonly abort: AbortSignal;
	readonly interrupt: AbortSignal;
}

export type AttemptStats = SessionStats;
export interface AttemptSkillReport {
	readonly skills?: readonly string[];
	readonly skillsWarning?: string;
}

export type AttemptOutcome = (
	| {
			readonly status: "ok";
			readonly output: string;
			readonly stats: AttemptStats;
			readonly path: string;
			readonly envelope: string;
			readonly sessionFile?: string;
			readonly model?: string;
			readonly thinking?: string;
			readonly attemptedModels?: readonly string[];
	  }
	| {
			readonly status: "error";
			readonly cause: string;
			readonly stats: AttemptStats;
			readonly path: string;
			readonly envelope: string;
			readonly sessionFile?: string;
			readonly fallbackSignal?: string;
			readonly model?: string;
			readonly thinking?: string;
			readonly attemptedModels?: readonly string[];
	  }
	| {
			readonly status: "interrupted" | "killed";
			readonly cause?: string;
			/** Steering then follow-up messages the child had queued but not read when its parent stopped it, in order. */
			readonly pendingMessages?: readonly string[];
			readonly stats: AttemptStats;
			readonly path: string;
			readonly envelope: string;
			readonly sessionFile?: string;
			readonly model?: string;
			readonly thinking?: string;
			readonly attemptedModels?: readonly string[];
	  }
	| {
			readonly status: "continued";
			readonly childPath: string;
			readonly stats: AttemptStats;
			readonly path: string;
			readonly envelope: string;
			readonly sessionFile?: string;
			readonly model?: string;
			readonly thinking?: string;
	  }
) &
	AttemptSkillReport;

export interface ResultEnvelope {
	readonly path: string;
	readonly status: TerminalStatus;
	readonly cause?: string;
	readonly stats: AttemptStats;
	readonly envelope: string;
	readonly model?: string;
	readonly thinking?: string;
	readonly modelAttempts?: readonly {
		readonly model: string;
		readonly status: TerminalStatus;
		readonly cause?: string;
	}[];
	readonly sessionFile?: string;
	readonly artifactsDir?: string;
	readonly durationMs?: number;
	readonly timestamp: number;
}

export interface DeliverChildResultOptions {
	readonly artifactsDir?: string;
	readonly artifactPaths?: ArtifactPaths;
	readonly artifactsDisabled?: boolean;
	readonly maxOutput?: MaxOutputConfig;
}

export interface AdmittedResult {
	readonly admitted?: AdmittedChild;
	readonly refusal?: AdmissionRefusal;
}

export interface AdmissionRefusal {
	readonly kind: NativeAdmissionResult["refusal"] extends infer R ? (R extends { kind: infer K } ? K : never) : never;
	readonly reason: string;
	readonly maxDepth?: number;
}

const EMPTY_STATS: AttemptStats = {
	sessionFile: undefined,
	sessionId: "",
	userMessages: 0,
	assistantMessages: 0,
	toolCalls: 0,
	toolResults: 0,
	totalMessages: 0,
	tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	cost: 0,
};

const CAPACITY_RETRY_INITIAL_DELAY_MS = 5;
const INTERRUPTED_ENVELOPE = "Interrupted";
const CAPACITY_RETRY_MAX_DELAY_MS = 100;

type CapacityWaitResult = "retry" | "abort" | "interrupt";

function waitForExecutionCapacity(
	delayMs: number,
	signals: AttemptSignals,
	onSettled: (result: CapacityWaitResult) => void,
): Promise<CapacityWaitResult> {
	if (signals.interrupt.aborted || signals.abort.aborted) {
		const result = signals.interrupt.aborted ? "interrupt" : "abort";
		onSettled(result);
		return Promise.resolve(result);
	}
	return new Promise((resolveWait) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const settle = (result: CapacityWaitResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signals.abort.removeEventListener("abort", onAbort);
			signals.interrupt.removeEventListener("abort", onInterrupt);
			onSettled(result);
			resolveWait(result);
		};
		const onAbort = () => settle("abort");
		const onInterrupt = () => settle("interrupt");
		signals.abort.addEventListener("abort", onAbort, { once: true });
		signals.interrupt.addEventListener("abort", onInterrupt, { once: true });
		timer = setTimeout(() => settle("retry"), delayMs);
	});
}

function workflowMetadataFromContext(
	context: CreateAgentSessionOptions["orchestrationContext"] | undefined,
): { runId: string; stageId: string; stageName: string } | undefined {
	if (context?.kind !== "workflow-stage") return undefined;
	return {
		runId: context.workflowRunId,
		stageId: context.workflowStageId,
		stageName: context.workflowStageName,
	};
}

/**
 * In-process children keep bundled package resources, but never load the
 * workflows extension itself. Every subagent child is a separate AgentSession;
 * letting it adopt the process-shared workflow singletons rebinds the parent
 * session's store facade and strands the parent's panel and control surfaces.
 * Workflow-stage children already forbid the workflow tool explicitly, and
 * ordinary subagent children must not gain an indirect orchestration door either.
 */
export function inProcessChildBuiltinPackagePaths(
	_context: CreateAgentSessionOptions["orchestrationContext"] | undefined,
	builtins?: CreateAgentSessionOptions["builtins"],
): PackageSource[] {
	return getBuiltinPackagePaths(builtins).map((source) =>
		basename(source) === "workflows" ? { source, extensions: [] } : source,
	);
}

/**
 * Resource-loading options for a real (non-test) in-process child session.
 * Omitting `builtinPackagePaths` leaves a child with no bundled extension at
 * all — no `subagent`, `web_search`, `fetch_content`, or `intercom` — so the
 * bundled roots belong in every child loader.
 */
export function inProcessChildResourceLoaderOptions(input: {
	readonly cwd: string;
	readonly agentDir: string;
	readonly settingsManager: SettingsManager;
	readonly agent: Pick<AgentConfig, "systemPrompt" | "systemPromptMode">;
	readonly orchestrationContext: CreateAgentSessionOptions["orchestrationContext"] | undefined;
	readonly builtins?: CreateAgentSessionOptions["builtins"];
	readonly resourceLoaderInheritanceSnapshot?: import("@bastani/atomic").DefaultResourceLoaderInheritanceSnapshot;
}): ConstructorParameters<typeof DefaultResourceLoader>[0] {
	const agentPrompt = input.agent.systemPrompt?.trim();
	return {
		cwd: input.cwd,
		agentDir: input.agentDir,
		settingsManager: input.settingsManager,
		resourceLoaderInheritanceSnapshot: input.resourceLoaderInheritanceSnapshot,
		builtinPackagePaths: inProcessChildBuiltinPackagePaths(input.orchestrationContext, input.builtins),
		...(agentPrompt && input.agent.systemPromptMode === "append"
			? { appendSystemPrompt: [agentPrompt] }
			: agentPrompt
				? { systemPrompt: agentPrompt }
				: {}),
	};
}

function createTestSession(sessionManager: SessionManager, spec: ChildSpec): AgentSession {
	const listeners = new Set<AgentSessionEventListener>();
	const testOptions = typeof spec.testSession === "object" ? spec.testSession : {};
	const sessionModel = (() => {
		const fullId = testOptions.sessionModel;
		if (!fullId) return undefined;
		const slash = fullId.indexOf("/");
		return {
			provider: slash === -1 ? "" : fullId.slice(0, slash),
			id: slash === -1 ? fullId : fullId.slice(slash + 1),
		};
	})();
	let lastAssistantText = "";
	let aborted = false;
	let settlePromptAbort: (() => void) | undefined;
	const messages: Array<{
		role: string;
		content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>;
		stopReason?: string;
	}> = [];
	let userMessages = 0;
	let assistantMessages = 0;
	const zeroTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const appendAssistant = async (
		content: Array<{ type: "text"; text: string } | { type: "thinking"; thinking: string }>,
		stopReason: "stop" | "aborted",
	): Promise<void> => {
		await sessionManager.appendMessage({
			role: "assistant",
			content,
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.4",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: zeroCost,
			},
			stopReason,
			timestamp: Date.now(),
		});
		messages.push({ role: "assistant", content, stopReason });
		assistantMessages += 1;
	};
	const steering: string[] = [];
	const followUps: string[] = [];
	const session = {
		sessionFile: sessionManager.getSessionFile(),
		model: sessionModel,
		thinkingLevel: testOptions.sessionThinkingLevel,
		messages,
		abort: async () => {
			aborted = true;
			settlePromptAbort?.();
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: async (text: string) => {
			const emitFallback = (): void => {
				if (!testOptions.fallbackModel) return;
				for (const listener of listeners) {
					listener({
						type: "model_fallback_start",
						from: "openai/gpt-5.1-codex",
						to: testOptions.fallbackModel,
						reason: "test fallback",
						attempt: 1,
					} as AgentSessionEvent);
					if (testOptions.fallbackThinkingLevel) {
						listener({
							type: "thinking_level_changed",
							level: testOptions.fallbackThinkingLevel,
						} as AgentSessionEvent);
					}
					listener({
						type: "tool_execution_start",
						toolCallId: "test-fallback-tool",
						toolName: "test-fallback-tool",
						args: {},
					} as AgentSessionEvent);
				}
			};
			for (const listener of listeners) listener({ type: "agent_start" } as AgentSessionEvent);
			if (aborted) throw new Error("aborted");
			if (testOptions.promptLogPath) appendFileSync(testOptions.promptLogPath, `${text}\n---PROMPT---\n`, "utf8");
			await sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			userMessages += 1;
			if (testOptions.seededAssistantText) {
				lastAssistantText = testOptions.seededAssistantText;
				await appendAssistant([{ type: "text", text: lastAssistantText }], "stop");
			}
			if (testOptions.fallbackBeforeGate) emitFallback();
			for (const event of testOptions.beforeGateEvents ?? []) for (const listener of listeners) listener(event);
			if (testOptions.promptGate) {
				const gateResult = await Promise.race([
					testOptions.promptGate.then(() => "released" as const),
					new Promise<"aborted">((resolve, reject) => {
						settlePromptAbort = () => {
							if (testOptions.abortResolvesPrompt) resolve("aborted");
							else reject(new DOMException("aborted", "AbortError"));
						};
						if (aborted) settlePromptAbort();
					}),
				]);
				if (gateResult === "aborted") {
					if (testOptions.thinkingOnlyOnAbort) {
						lastAssistantText = "";
						await appendAssistant([{ type: "thinking", thinking: "aborted mid-thought" }], "aborted");
					}
					for (const event of testOptions.events ?? []) for (const listener of listeners) listener(event);
					return "";
				}
			}
			for (const event of testOptions.events ?? []) {
				for (const listener of listeners) listener(event);
			}
			if (!testOptions.fallbackBeforeGate) emitFallback();
			lastAssistantText = testOptions.output ?? "done";
			await appendAssistant([{ type: "text", text: lastAssistantText }], "stop");
			const next = steering.shift() ?? followUps.shift();
			return next === undefined ? lastAssistantText : session.prompt(next);
		},
		steer: async (text: string) => {
			steering.push(text);
		},
		followUp: async (text: string) => {
			followUps.push(text);
			return "queued";
		},
		getSteeringMessages: () => steering,
		getFollowUpMessages: () => followUps,
		getLastAssistantText: () => {
			const lastAssistant = [...messages].reverse().find((message) => {
				if (message.role !== "assistant") return false;
				if (message.stopReason === "aborted" && message.content.length === 0) return false;
				return true;
			});
			if (!lastAssistant) return lastAssistantText || undefined;
			let text = "";
			for (const content of lastAssistant.content) {
				if (content.type === "text") text += content.text ?? "";
			}
			return text.trim() || undefined;
		},
		getSessionStats: () => ({
			sessionFile: sessionManager.getSessionFile(),
			sessionId: sessionManager.getSessionId(),
			userMessages,
			assistantMessages,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: userMessages + assistantMessages,
			tokens: zeroTokens,
			cost: 0,
		}),
		startPendingRecovery: async () => ({ replayed: 0, dropped: 0, completions: 0, notices: [] }),
		dispose: testOptions.dispose ?? (() => {}),
	} as unknown as AgentSession;
	testOptions.onSession?.({
		steer: async (text) => {
			await session.steer(text);
		},
		followUp: async (text) => {
			await session.followUp(text);
		},
	});
	return session;
}

type TranscriptSource = Parameters<NonNullable<TaskExecutionHooks["bindTranscript"]>>[0];

/**
 * What a settled child keeps for task inspection: its entries, with no reference back to the
 * disposed session. The task owner holds the last bound source for as long as the task exists.
 */
function settledTranscript(manager: SessionManager): TranscriptSource {
	const sessionId = manager.getSessionId();
	const entries = manager.getEntries();
	return { getSessionId: () => sessionId, getEntries: () => [...entries] };
}

function nativeStatus(value: ChildStatus): NativeAgentStatus {
	return value === "killed" ? "interrupted" : value;
}

function nativeCause(value: TerminationCauseName): NativeTerminationCause {
	return value;
}

function refusal(result: NativeAdmissionResult): AdmittedResult {
	if (!result.refusal) return {};
	return {
		refusal: {
			kind: result.refusal.kind,
			reason: result.refusal.reason,
			...(result.refusal.maxDepth === undefined ? {} : { maxDepth: result.refusal.maxDepth }),
		},
	};
}

function statsFor(session: AgentSession | undefined, fallbackSessionId: string): AttemptStats {
	if (!session) return { ...EMPTY_STATS, sessionId: fallbackSessionId };
	try {
		return session.getSessionStats();
	} catch {
		return {
			...EMPTY_STATS,
			sessionId: fallbackSessionId,
			sessionFile: session.sessionFile,
		};
	}
}

type BranchEntry = ReturnType<SessionManager["getBranch"]>[number];
type TranscriptMessage = Extract<BranchEntry, { type: "message" }>["message"];

/**
 * The messages this attempt produced: entries on the child's branch after its launch leaf.
 * A forked child's session also carries the parent's history up to the fork point, and none
 * of that is the child's output (#3987). A launch leaf missing from the branch yields
 * nothing rather than the whole inherited transcript.
 */
function messagesSinceLaunch(manager: SessionManager, launchLeafId: string | null): TranscriptMessage[] {
	const branch = manager.getBranch();
	const launchIndex = launchLeafId === null ? -1 : branch.findIndex((entry) => entry.id === launchLeafId);
	if (launchLeafId !== null && launchIndex === -1) return [];
	return branch.slice(launchIndex + 1).flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
}

function outputFor(ownMessages: readonly TranscriptMessage[]): string {
	return lastNonEmptyAssistantText(
		ownMessages.filter((message) => message.role === "assistant") as Parameters<typeof lastNonEmptyAssistantText>[0],
	);
}

/**
 * Why an attempt that settled without a stop failed, or undefined when it did not. It failed
 * only when it completed no successful assistant turn of its own: every own turn failed, or it
 * ran none (#3987). A child with a successful turn, even a tool-only one with no final text, did
 * not fail.
 */
function noSuccessfulTurnCause(ownMessages: readonly TranscriptMessage[]): string | undefined {
	const ownTurns = ownMessages.flatMap((message) => (message.role === "assistant" ? [message] : []));
	if (ownTurns.some((turn) => turn.stopReason !== "error" && turn.stopReason !== "aborted")) return undefined;
	const errorMessage = ownTurns.findLast((turn) => turn.errorMessage?.trim())?.errorMessage?.trim();
	return errorMessage || "Child ended without completing an assistant turn of its own.";
}

function cancelledEnvelope(
	session: AgentSession | undefined,
	spec: ChildSpec,
	stats: AttemptStats,
	ownMessages: readonly TranscriptMessage[],
): string {
	return recoverCancelledChildOutput({
		progressPath: spec.progressPath,
		assistantText: outputFor(ownMessages),
		toolCount: stats.toolCalls,
		sessionPath: session?.sessionFile ?? spec.sessionManager?.getSessionFile(),
		...(spec.progressArtifactPath ? { progressArtifactPath: spec.progressArtifactPath } : {}),
		...(spec.outputArtifactPath ? { outputArtifactPath: spec.outputArtifactPath } : {}),
	}).text;
}

/**
 * What a stopped child had queued and not yet read, steering before follow-ups, so its resume delivers it. A child
 * stopped before its prompt ran never read its task either: that comes first, then the follow-ups it was to queue.
 */
function pendingMessagesOf(
	session: AgentSession | undefined,
	unsent: readonly string[],
): { pendingMessages?: readonly string[] } {
	const queued = session ? [...session.getSteeringMessages(), ...session.getFollowUpMessages()] : [];
	const [task, ...followUps] = unsent;
	const pending = task === undefined ? queued : [task, ...queued, ...followUps];
	return pending.length > 0 ? { pendingMessages: pending } : {};
}

function attemptStatus(termination: TerminationCauseName | undefined): "ok" | "error" | "interrupted" {
	if (termination === "interrupt" || termination === PARENT_CANCEL_CAUSE) return "interrupted";
	if (termination) return "error";
	return "ok";
}

function boundedEnvelope(output: string, artifactPath?: string, maxOutput?: MaxOutputConfig): string {
	const config = { ...DEFAULT_MAX_OUTPUT, ...maxOutput };
	const result = truncateOutput(output, config, artifactPath);
	return result.truncated && artifactPath ? `${result.text}\n\nFull output: ${artifactPath}` : result.text;
}

function canonicalArtifactPaths(artifactsDir: string, childPath: string): ArtifactPaths {
	const prefix = childPath.replaceAll("/", "_");
	return {
		inputPath: join(artifactsDir, `${prefix}_input.md`),
		outputPath: join(artifactsDir, `${prefix}_output.md`),
		jsonlPath: join(artifactsDir, `${prefix}.jsonl`),
		metadataPath: join(artifactsDir, `${prefix}_meta.json`),
	};
}

function validatePath(pathValue: string): void {
	if (
		!pathValue ||
		pathValue.startsWith("/") ||
		pathValue.includes("\\") ||
		pathValue.split("/").some((part) => !part || part === "." || part === "..")
	) {
		throw new Error("child path is outside the trusted session root");
	}
}

function trustedSessionRoot(parent: ParentContext, requestedRoot?: string): string {
	validatePath(parent.path);
	const root = resolve(requestedRoot ?? join(process.cwd(), ".atomic", "subagents"));
	const child = resolve(root, ...parent.path.split("/"));
	if (relative(root, child).startsWith("..")) throw new Error("subagent session root escapes trusted root");
	return root;
}

function sessionDirectory(root: string, pathValue: string): string {
	validatePath(pathValue);
	const directory = resolve(root, ...pathValue.split("/"));
	if (relative(root, directory).startsWith("..")) throw new Error("child session path escapes trusted root");
	return directory;
}

function safeArgsPreview(args: unknown): string {
	if (args === undefined) return "";
	try {
		const text = typeof args === "string" ? args : JSON.stringify(args);
		return text.length > 200 ? `${text.slice(0, 200)}…` : text;
	} catch {
		return "";
	}
}

/**
 * How a child session event should publish {@link AgentProgress} to the host UI.
 *
 * - `force` — the event changed progress the live widget shows; bypass the throttle.
 * - `throttled` — worth publishing, but subject to the 400 ms throttle.
 * - `none` — carries nothing the widget shows; do not publish.
 *
 * `none` is the important case. Foreground subagent results render into chat
 * scrollback, which can sit above pi-tui's viewport fold. Every publish rewrites
 * `durationMs`/`lastActivityAt` and repaints the widget, and a repaint of a row
 * above the fold makes `TUI.doRender()` take its `firstChanged < viewportTop`
 * branch, which issues a full redraw that writes `\x1b[2J\x1b[H\x1b[3J` — clearing
 * the user's scrollback and snapping the terminal to the bottom. A catch-all
 * publish therefore destroyed the scrollback ~2.5x/s for the whole run, because
 * `AgentSessionEvent` includes high-frequency traffic (`message_update` streaming
 * deltas, `tool_execution_update`, `entry_appended`) that the widget never shows.
 * Keep this table narrow: add an event only when the widget renders something the
 * event changed.
 */
export type ProgressEmission = "force" | "throttled" | "none";

export function progressEmissionFor(eventType: AgentSessionEvent["type"]): ProgressEmission {
	switch (eventType) {
		case "agent_start":
		case "tool_execution_start":
		case "tool_execution_end":
			return "force";
		case "message_end":
			return "throttled";
		default:
			return "none";
	}
}

function writeEvent(pathValue: string | undefined, event: AgentSessionEvent): void {
	if (!pathValue) return;
	const line = `${JSON.stringify(event)}\n`;
	let existingBytes = 0;
	try {
		existingBytes = statSync(pathValue).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
	if (existingBytes + Buffer.byteLength(line, "utf8") > DEFAULT_MAX_JSONL_BYTES) return;
	mkdirSync(dirname(pathValue), { recursive: true });
	appendFileSync(pathValue, line, "utf8");
}

/**
 * A child identity whose constructor is private. Depth and path validation happen
 * at the Rust admission door, so callers cannot manufacture an admitted child
 * below the single permitted delegation level or bypass canonical identity
 * allocation.
 */
interface AdmittedChildInput {
	readonly identity: ChildIdentity;
	readonly spec: ChildSpec;
	readonly policy: ChildPolicy;
	readonly sessionDir: string;
	readonly sessionManager?: SessionManager;
	readonly control: SubagentControlRuntime;
}

export class AdmittedChild {
	readonly identity: ChildIdentity;
	readonly spec: ChildSpec;
	readonly policy: ChildPolicy;
	readonly sessionDir: string;
	readonly sessionManager?: SessionManager;
	readonly control: SubagentControlRuntime;

	private constructor(input: {
		identity: ChildIdentity;
		spec: ChildSpec;
		policy: ChildPolicy;
		sessionDir: string;
		sessionManager?: SessionManager;
		control: SubagentControlRuntime;
	}) {
		this.identity = input.identity;
		this.spec = input.spec;
		this.policy = input.policy;
		this.sessionDir = input.sessionDir;
		this.sessionManager = input.sessionManager;
		this.control = input.control;
	}

	static create(input: AdmittedChildInput): AdmittedChild {
		if (input.identity.depth > 1) throw new Error("child depth exceeds maximum 1");
		validatePath(input.identity.path);
		return new AdmittedChild(input);
	}
}

export interface ChildRuntimeMetadata {
	model?: string;
	thinking?: string;
}

export interface RunningAttempt {
	readonly id: number;
	readonly child: AdmittedChild;
	readonly candidate: ModelCandidate;
	readonly startedAt: number;
	currentModel?: string;
	currentThinking?: string;
	status: "running" | ChildStatus;
	promise: Promise<AttemptOutcome>;
	terminate?: (cause: TerminationCauseName) => Promise<void>;
	attemptToken?: number;
}

export class SubagentControlRuntime {
	readonly native: SubagentControl;
	readonly parent: ParentContext;
	readonly sessionRoot: string;
	private readonly runningAttempts = new Map<number, RunningAttempt>();
	private readonly attemptTokens = new Map<string, number>();
	private readonly attemptTerminators = new Map<string, (cause: TerminationCauseName) => Promise<void>>();
	private readonly delivered = new Set<string>();
	private readonly deliveredEnvelopes = new Map<string, ResultEnvelope>();
	private readonly killedChildren = new Set<string>();
	private nextAttemptId = 1;

	constructor(parent: ParentContext, sessionRoot?: string, runningCapacity?: number) {
		this.parent = { ...parent };
		this.sessionRoot = trustedSessionRoot(this.parent, sessionRoot);
		this.native = new SubagentControl(this.parent.path, runningCapacity);
	}

	registerAgents(agents: readonly AgentConfig[]): void {
		for (const agent of agents) this.native.registerAgent(agent.name);
	}

	admitChildSession(spec: ChildSpec, parent: ParentContext = this.parent): AdmittedResult {
		if (!existsSync(spec.cwd) || !statSync(spec.cwd).isDirectory()) {
			return {
				refusal: {
					kind: "invalidCwd",
					reason: `cwd is not a directory: ${spec.cwd}`,
				},
			};
		}
		const native = this.native.admitChildSession(
			{ taskName: spec.taskName, agentName: spec.agent.name, cwd: spec.cwd },
			{ path: parent.path, depth: parent.depth },
		);
		if (!native.child) return refusal(native);
		const identity = native.child;
		const childModePolicy = resolveChildModePolicy(spec);
		const sessionDir = spec.sessionManager?.getSessionDir() || sessionDirectory(this.sessionRoot, identity.path);
		mkdirSync(sessionDir, { recursive: true });
		return {
			admitted: AdmittedChild.create({
				identity,
				spec,
				policy: {
					...childModePolicy,
					cwd: spec.cwd,
					tools: spec.tools ?? spec.agent.tools,
					excludedTools: spec.excludedTools,
					mcpDirectTools: spec.mcpDirectTools ?? spec.agent.mcpDirectTools,
					skills: [...(spec.skills ?? spec.agent.skills ?? [])],
					customTools: spec.customTools,
					model: spec.model,
					thinkingLevel: spec.thinkingLevel ?? (spec.agent.thinking as ChildPolicy["thinkingLevel"]),
					intercomGroup: parent.intercomGroup,
					intercom: spec.intercom,
					depth: identity.depth,
				},
				sessionDir,
				sessionManager: spec.sessionManager,
				control: this,
			}),
		};
	}

	async runChildAttempt(
		admitted: AdmittedChild,
		candidate: ModelCandidate,
		signals: AttemptSignals,
		onModelChange: ((model: string | undefined, thinking?: string) => void) | undefined,
		taskHooks?: Pick<
			TaskExecutionHooks,
			"reportActivity" | "bindTranscript" | "bindChildSession" | "bindChildLaunch"
		>,
		onCleanup?: (cleanup: Promise<Cleanup>) => void,
	): Promise<AttemptOutcome> {
		const candidateModelId = modelIdForCandidate(candidate, admitted.policy.model);
		const configuredThinking = candidate.thinkingLevel ?? admitted.policy.thinkingLevel;
		let effectiveModelId = candidateModelId;
		let effectiveThinking = initialThinkingForAttempt(candidateModelId, configuredThinking);
		let transcriptManager: SessionManager | undefined;
		let attemptedModels: string[] = candidateModelId ? [candidateModelId] : [];
		// Background receipts can precede capacity acquisition and session loading. Publish
		// only the concrete selection handed to createAgentSession, not a requested ID
		// or an arbitrary parent model. Session and fallback reports remain authoritative.
		const selectedModel = candidate.model ?? admitted.policy.model;
		if (selectedModel)
			taskHooks?.reportActivity({
				reportId: `${randomUUID()}:admission-model`,
				change: {
					kind: "model",
					model: `${selectedModel.provider}/${selectedModel.id}`,
					thinking:
						configuredThinking === undefined ? undefined : clampThinkingLevel(selectedModel, configuredThinking),
				},
			});
		let guard: NativeExecutionGuardResult;
		let retryDelayMs = CAPACITY_RETRY_INITIAL_DELAY_MS;
		for (;;) {
			guard = this.native.beginChildAttempt(admitted.identity.path);
			if (guard.token || guard.refusal?.kind !== "capacityExhausted") break;
			let killed = false;
			const waitResult = await waitForExecutionCapacity(retryDelayMs, signals, (result) => {
				// Snapshot at signal delivery, before a later kill or parent abort can change classification.
				killed =
					this.killedChildren.has(admitted.identity.path) ||
					(result === PARENT_CANCEL_CAUSE && !!taskHooks && signals.abort.reason === "user");
			});
			if (waitResult !== "retry") {
				const stats = { ...EMPTY_STATS, sessionId: admitted.identity.path };
				if (waitResult === "interrupt" || waitResult === PARENT_CANCEL_CAUSE) {
					if (killed) this.killedChildren.add(admitted.identity.path);
					else this.killedChildren.delete(admitted.identity.path);
					this.native.publishChildStatus(admitted.identity.path, nativeStatus("interrupted"));
					return {
						status: killed ? "killed" : "interrupted",
						...(waitResult === PARENT_CANCEL_CAUSE && !killed
							? {
									cause: PARENT_CANCEL_CAUSE,
									...pendingMessagesOf(undefined, [
										admitted.spec.task,
										...(admitted.spec.resumeFollowUps ?? []),
									]),
								}
							: {}),
						stats,
						path: admitted.identity.path,
						envelope: killed
							? "Killed. This child cannot be resumed."
							: waitResult === PARENT_CANCEL_CAUSE
								? cancelledEnvelope(undefined, admitted.spec, stats, [])
								: INTERRUPTED_ENVELOPE,
						...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
						...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
					};
				}
				this.native.publishChildStatus(admitted.identity.path, nativeStatus("error"));
				return {
					status: "error",
					cause: waitResult,
					stats,
					path: admitted.identity.path,
					envelope: boundedEnvelope(waitResult),
					...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
					...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
				};
			}
			retryDelayMs = Math.min(retryDelayMs * 2, CAPACITY_RETRY_MAX_DELAY_MS);
		}
		if (!guard.token) {
			const reason = guard.refusal?.reason ?? "child execution was refused";
			const stats = { ...EMPTY_STATS, sessionId: admitted.identity.path };
			this.native.publishChildStatus(admitted.identity.path, nativeStatus("error"));
			return {
				status: "error",
				cause: reason,
				stats,
				path: admitted.identity.path,
				envelope: boundedEnvelope(reason),
				...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
				...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
			};
		}
		const token = guard.token;
		this.attemptTokens.set(admitted.identity.path, token);
		let session: AgentSession | undefined;
		// Messages this attempt produced; a forked child's inherited history is never among them.
		let ownMessages: () => TranscriptMessage[] = () => [];
		const executionEnded = new AbortController();

		let termination: TerminationCauseName | undefined;
		// The task and resume follow-ups the session has not been given yet; a stop before then keeps them for resume.
		const unsent = [admitted.spec.task, ...(admitted.spec.resumeFollowUps ?? [])];
		let terminating: Promise<void> | undefined;
		let terminationWasKill = false;
		let unsubscribe: (() => void) | undefined;
		let skillReport: AttemptSkillReport = {};
		const terminate = async (cause: TerminationCauseName): Promise<void> => {
			if (terminating) {
				if (!terminationWasKill) this.killedChildren.delete(admitted.identity.path);
				return terminating;
			}
			if (taskHooks && cause === "abort" && signals.abort.reason === "user")
				this.killedChildren.add(admitted.identity.path);
			// Preserve the first termination's classification across late kill requests.
			terminationWasKill = this.killedChildren.has(admitted.identity.path);
			termination = cause;
			terminating = (async () => {
				try {
					await session?.abort();
				} finally {
					try {
						await this.native.terminateChildAttempt(token, nativeCause(cause));
					} catch {
						// The attempt may have completed between signal delivery and termination.
					}
				}
			})();
			return terminating;
		};
		this.attemptTerminators.set(admitted.identity.path, terminate);
		const abortListener = () => void terminate("abort");
		const interruptListener = () => void terminate("interrupt");
		signals.abort.addEventListener("abort", abortListener, { once: true });
		signals.interrupt.addEventListener("abort", interruptListener, {
			once: true,
		});
		try {
			const workflow = workflowMetadataFromContext(admitted.spec.parent?.orchestrationContext);
			const sessionManager = admitted.sessionManager
				? await SessionManager.open(
						admitted.sessionManager.getSessionStore(),
						admitted.sessionManager.getSessionId(),
						admitted.policy.cwd,
					)
				: await SessionManager.create(
						admitted.policy.cwd,
						admitted.sessionDir,
						workflow ? { internal: true, workflow } : { internal: true },
					);
			transcriptManager = sessionManager;
			taskHooks?.bindTranscript?.(sessionManager);
			const childSession = {
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
			};
			taskHooks?.bindChildSession?.(childSession);
			admitted.spec.onChildSession?.(childSession);
			if (workflow) await sessionManager.markSessionInternal(workflow);
			const launchLeafId = sessionManager.getLeafId();
			ownMessages = () => messagesSinceLaunch(sessionManager, launchLeafId);
			let created: { session: AgentSession };
			if (admitted.spec.testSession) {
				created = { session: createTestSession(sessionManager, admitted.spec) };
			} else {
				const childOptions: CreateAgentSessionOptions = {
					cwd: admitted.policy.cwd,
					...((candidate.model ?? admitted.policy.model)
						? { model: candidate.model ?? admitted.policy.model }
						: {}),
					...((candidate.thinkingLevel ?? admitted.policy.thinkingLevel)
						? { thinkingLevel: candidate.thinkingLevel ?? admitted.policy.thinkingLevel }
						: {}),
					...(admitted.spec.fallbackModels !== undefined
						? { fallbackModels: [...admitted.spec.fallbackModels] }
						: {}),
					isFallbackModelAllowed: admitted.spec.isFallbackModelAllowed,
					tools: admitted.policy.tools ? [...admitted.policy.tools] : undefined,
					excludedTools: admitted.policy.excludedTools ? [...admitted.policy.excludedTools] : undefined,
				};
				const inherited = admitted.spec.parent?.getChildSessionOptions?.(childOptions) ?? childOptions;
				const agentDir = inherited.agentDir ?? getAgentDir();
				const settingsManager = inherited.settingsManager ?? SettingsManager.create(admitted.policy.cwd, agentDir);
				const resourceLoader = new DefaultResourceLoader(
					inProcessChildResourceLoaderOptions({
						cwd: admitted.policy.cwd,
						agentDir,
						settingsManager,
						agent: admitted.spec.agent,
						builtins: inherited.builtins,
						resourceLoaderInheritanceSnapshot: admitted.spec.parent?.resourceLoaderInheritanceSnapshot,
						orchestrationContext: admitted.spec.parent?.orchestrationContext,
					}),
				);
				await resourceLoader.reload();
				const selectedSkills = resolveSkillsFromCatalog(
					[...admitted.policy.skills],
					resourceLoader.getSkillCatalog(),
					admitted.policy.cwd,
				);
				skillReport = {
					...(selectedSkills.resolved.length > 0
						? { skills: selectedSkills.resolved.map((skill) => skill.name) }
						: {}),
					...(selectedSkills.missing.length > 0
						? { skillsWarning: `Skills not found: ${selectedSkills.missing.join(", ")}` }
						: {}),
				};
				if (selectedSkills.missing.some(isSubagentOrchestrationSkillSelector)) {
					throw new Error("Skills not found: subagent");
				}
				const skillInjection = buildSkillInjection(selectedSkills.resolved);
				const promptBehavior = createInProcessChildPromptBehavior(admitted.policy);
				const systemPromptTransform = createInProcessChildSystemPromptTransform(admitted.policy, skillInjection);
				created = {
					session: (
						await createAgentSession({
							...inherited,
							customTools: admitted.policy.customTools ?? inherited.customTools,
							resourceLoader,
							resourceAdmissionSignal: AbortSignal.any([signals.abort, signals.interrupt]),
							subagentPolicy: {
								...admitted.policy,
								executionEnded: executionEnded.signal,
								...(!childAllowsIntercom(inherited) ? { intercom: undefined, intercomGroup: undefined } : {}),
							},
							settingsManager,
							orchestrationContext: admitted.spec.parent?.orchestrationContext,
							sessionManager,
							systemPromptTransform,
							initialContextTransform: promptBehavior.initialContextTransform,
						})
					).session,
				};
			}
			session = created.session;
			const transcriptSession = session;
			// Snapshot at the public session-event boundary, never ahead of its queued events.
			let observedStreamingMessage: AssistantMessage | undefined;
			taskHooks?.bindTranscript?.({
				getSessionId: () => sessionManager.getSessionId(),
				getEntries: () => sessionManager.getEntries(),
				subscribe: (listener) => transcriptSession.subscribe(listener),
				getStreamingMessage: () => observedStreamingMessage,
			});
			const initialModelId = modelIdForSession(session) ?? candidateModelId;
			effectiveModelId = initialModelId;
			effectiveThinking =
				thinkingLevelForSession(session) ?? initialThinkingForAttempt(candidateModelId, configuredThinking);
			attemptedModels = initialModelId ? [initialModelId] : [];
			onModelChange?.(effectiveModelId, effectiveThinking);
			const childLaunch = {
				model: effectiveModelId === undefined ? undefined : splitKnownThinkingSuffix(effectiveModelId).baseModel,
				thinking: effectiveThinking,
				leafId: sessionManager.getLeafId(),
			};
			taskHooks?.bindChildLaunch?.(childLaunch);
			admitted.spec.onChildLaunch?.(childLaunch);
			const progressState: AgentProgress = {
				index: 0,
				agent: admitted.spec.agent.name,
				status: "running",
				...(initialModelId === undefined ? {} : { model: initialModelId }),
				...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
				task: admitted.spec.task,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
				lastActivityAt: Date.now(),
			};
			const attemptStartedAt = Date.now();
			const activityPrefix = randomUUID();
			let lastProgressEmit = 0;
			const emitProgress = (force: boolean) => {
				const onProgress = admitted.spec.onProgress;
				if (!onProgress && !taskHooks) return;
				const now = Date.now();
				if (!force && now - lastProgressEmit < 400) return;
				lastProgressEmit = now;
				progressState.durationMs = now - attemptStartedAt;
				progressState.lastActivityAt = now;
				taskHooks?.reportActivity({
					reportId: `${activityPrefix}:metrics-${++activitySequence}`,
					change: {
						kind: "metrics",
						elapsedMs: progressState.durationMs,
						toolCount: progressState.toolCount,
						tokenCount: progressState.tokens,
					},
				});
				onProgress?.({ ...progressState, recentTools: [...progressState.recentTools] });
			};
			let activitySequence = 0;
			const reportModel = () =>
				taskHooks?.reportActivity({
					reportId: `${activityPrefix}:model-${++activitySequence}`,
					// Task records name the model alone; its thinking level is reported beside it (#4009).
					change: { kind: "model", model: taskRecordModel(effectiveModelId), thinking: effectiveThinking },
				});
			reportModel();
			unsubscribe = session.subscribe((event) => {
				writeEvent(admitted.spec.artifactJsonlPath, event);
				if (event.type === "message_start" && event.message.role === "assistant")
					observedStreamingMessage = beginStreamingAssistantMessage(event.message);
				else if (event.type === "message_update" && observedStreamingMessage)
					applyAssistantMessageDelta(observedStreamingMessage, event.assistantMessageEvent);
				else if (event.type === "message_end" && event.message.role === "assistant")
					observedStreamingMessage = undefined;
				const emission = progressEmissionFor(event.type);
				if (event.type === "tool_execution_start") {
					taskHooks?.reportActivity({
						reportId: `${activityPrefix}:tool-${++activitySequence}`,
						change: { kind: "action", tool: event.toolName, text: safeArgsPreview(event.args) },
					});
				}
				if (event.type === "agent_start") {
					this.native.publishChildStatus(admitted.identity.path, nativeStatus("running"));
				} else if (event.type === "tool_execution_start") {
					progressState.toolCount += 1;
					progressState.currentTool = event.toolName;
					progressState.currentToolArgs = safeArgsPreview(event.args);
					progressState.currentToolStartedAt = Date.now();
				} else if (event.type === "tool_execution_end") {
					if (progressState.currentTool !== undefined) {
						progressState.recentTools.push({
							tool: progressState.currentTool,
							args: progressState.currentToolArgs ?? "",
							endMs: Date.now(),
						});
						if (progressState.recentTools.length > 5) progressState.recentTools.shift();
					}
					progressState.currentTool = undefined;
					progressState.currentToolArgs = undefined;
					progressState.currentToolStartedAt = undefined;
				} else if (event.type === "message_end") {
					const message = (event as { message?: { role?: string; usage?: { input?: number; output?: number } } })
						.message;
					if (message?.role === "assistant") {
						progressState.turnCount = (progressState.turnCount ?? 0) + 1;
						const usage = message.usage;
						if (usage) progressState.tokens += (usage.input ?? 0) + (usage.output ?? 0);
					}
				}
				if (emission !== "none") emitProgress(emission === "force");
				if (event.type === "model_fallback_start" && !signals.abort.aborted) {
					if (!attemptedModels.includes(event.to)) attemptedModels.push(event.to);
					effectiveModelId = event.to;
					progressState.model = event.to;
					onModelChange?.(effectiveModelId, effectiveThinking);
					reportModel();
					emitProgress(true);
				} else if (event.type === "thinking_level_changed") {
					effectiveThinking = event.level;
					progressState.thinking = effectiveThinking;
					onModelChange?.(effectiveModelId, effectiveThinking);
					reportModel();
					emitProgress(true);
				}
			});
			if (signals.abort.aborted) await terminate("abort");
			if (signals.interrupt.aborted) await terminate("interrupt");
			if (!termination && admitted.spec.resumeSession) await session.startPendingRecovery("resume");
			for (const followUp of admitted.spec.resumeFollowUps ?? []) {
				if (termination) break;
				await session.followUp(followUp);
				unsent.splice(1, 1);
			}
			if (!termination) {
				unsent.splice(0, 1);
				await session.prompt(admitted.spec.task);
			}
			await terminating;
			const stats = statsFor(session, admitted.identity.path);
			const sessionFile = session.sessionFile;
			const producedMessages = ownMessages();
			const output = outputFor(producedMessages);
			// A child that settled without a stop and completed no successful turn of its own failed (#3987).
			const noOutput = termination === undefined ? noSuccessfulTurnCause(producedMessages) : undefined;
			const status = noOutput === undefined ? attemptStatus(termination) : "error";
			this.native.publishChildStatus(admitted.identity.path, nativeStatus(status));
			this.native.finishChildAttempt(token, nativeStatus(status));
			const envelope =
				termination === PARENT_CANCEL_CAUSE
					? cancelledEnvelope(session, admitted.spec, stats, producedMessages)
					: status === "interrupted"
						? INTERRUPTED_ENVELOPE
						: boundedEnvelope(output || noOutput || termination || "(no output)", undefined);
			if (status === "ok")
				return {
					status,
					output,
					stats,
					path: admitted.identity.path,
					envelope,
					sessionFile,
					...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
					...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
					...(attemptedModels.length > 1 ? { attemptedModels: [...attemptedModels] } : {}),
					...skillReport,
				};
			if (status === "interrupted")
				return {
					status: this.killedChildren.has(admitted.identity.path) ? "killed" : status,
					...(termination === PARENT_CANCEL_CAUSE && !this.killedChildren.has(admitted.identity.path)
						? { cause: PARENT_CANCEL_CAUSE, ...pendingMessagesOf(session, unsent) }
						: {}),
					stats,
					path: admitted.identity.path,
					envelope: this.killedChildren.has(admitted.identity.path)
						? "Killed. This child cannot be resumed."
						: envelope,
					sessionFile,
					...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
					...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
					...(attemptedModels.length > 1 ? { attemptedModels: [...attemptedModels] } : {}),
					...skillReport,
				};
			return {
				status,
				cause: noOutput ?? termination ?? "agent session ended without a successful completion",
				stats,
				path: admitted.identity.path,
				envelope,
				sessionFile,
				...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
				...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
				...(attemptedModels.length > 1 ? { attemptedModels: [...attemptedModels] } : {}),
				...skillReport,
			};
		} catch (error) {
			const stats = statsFor(session, admitted.identity.path);
			const cause = error instanceof Error ? error.message : String(error);
			const status = attemptStatus(termination) === "interrupted" ? "interrupted" : "error";
			this.native.publishChildStatus(admitted.identity.path, nativeStatus(status));
			try {
				this.native.finishChildAttempt(token, nativeStatus(status));
			} catch {
				// Preserve the original failure when Rust already stamped termination.
			}
			if (status === "interrupted")
				return {
					status: this.killedChildren.has(admitted.identity.path) ? "killed" : status,
					...(termination === PARENT_CANCEL_CAUSE && !this.killedChildren.has(admitted.identity.path)
						? { cause: PARENT_CANCEL_CAUSE, ...pendingMessagesOf(session, unsent) }
						: {}),
					stats,
					path: admitted.identity.path,
					envelope:
						termination === PARENT_CANCEL_CAUSE && !this.killedChildren.has(admitted.identity.path)
							? cancelledEnvelope(session, admitted.spec, stats, ownMessages())
							: this.killedChildren.has(admitted.identity.path)
								? "Killed. This child cannot be resumed."
								: INTERRUPTED_ENVELOPE,
					sessionFile: session?.sessionFile,
					...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
					...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
					...(attemptedModels.length > 1 ? { attemptedModels: [...attemptedModels] } : {}),
					...skillReport,
				};
			return {
				status,
				cause,
				stats,
				path: admitted.identity.path,
				envelope: boundedEnvelope(cause),
				sessionFile: session?.sessionFile,
				...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
				...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
				...(attemptedModels.length > 1 ? { attemptedModels: [...attemptedModels] } : {}),
				...skillReport,
			};
		} finally {
			// End reply capability before asynchronous cleanup or extension invalidation.
			executionEnded.abort();
			signals.abort.removeEventListener("abort", abortListener);
			signals.interrupt.removeEventListener("abort", interruptListener);
			try {
				unsubscribe?.();
			} catch {
				// Listener teardown must not replace the attempt result.
			}
			const settleTranscript = (): void => {
				if (transcriptManager !== undefined) taskHooks?.bindTranscript?.(settledTranscript(transcriptManager));
			};
			if (onCleanup) {
				onCleanup(
					(async (): Promise<Cleanup> => {
						try {
							await session?.dispose();
							return { kind: "reaped" };
						} catch (error) {
							return {
								kind: "failed",
								resources: [
									{
										resource: "agent-session",
										code: "CleanupFailed",
										message: error instanceof Error ? error.message : String(error),
									},
								],
							};
						} finally {
							settleTranscript();
						}
					})(),
				);
			} else {
				try {
					await session?.dispose();
				} catch {
					// Session teardown must not replace the attempt result.
				} finally {
					settleTranscript();
				}
			}
			if (this.attemptTokens.get(admitted.identity.path) === token)
				this.attemptTokens.delete(admitted.identity.path);
			if (this.attemptTerminators.get(admitted.identity.path) === terminate)
				this.attemptTerminators.delete(admitted.identity.path);
		}
	}

	startAttempt(
		admitted: AdmittedChild,
		candidate: ModelCandidate,
		signals: AttemptSignals,
		taskHooks?: TaskExecutionHooks,
	): RunningAttempt {
		const initialModel = modelIdForCandidate(candidate, admitted.policy.model);
		const initialThinking = initialThinkingForAttempt(
			initialModel,
			candidate.thinkingLevel ?? admitted.policy.thinkingLevel,
		);
		const running: RunningAttempt = {
			id: this.nextAttemptId++,
			child: admitted,
			candidate,
			status: "running",
			startedAt: Date.now(),
			...(initialModel === undefined ? {} : { currentModel: initialModel }),
			currentThinking: initialThinking,
			promise: Promise.resolve({
				status: "error",
				cause: "uninitialized",
				stats: { ...EMPTY_STATS, sessionId: admitted.identity.path },
				path: admitted.identity.path,
				envelope: "uninitialized",
			}),
		};
		let cleanup: Promise<Cleanup> = Promise.resolve({ kind: "reaped" });
		running.promise = this.runChildAttempt(
			admitted,
			candidate,
			signals,
			(model, thinking) => {
				running.currentModel = model;
				running.currentThinking = thinking;
			},
			taskHooks,
			taskHooks
				? (result) => {
						cleanup = result;
					}
				: undefined,
		).then((result) => {
			running.status = result.status;
			this.runningAttempts.delete(running.id);
			return result;
		});
		running.terminate = (cause) => this.terminateRunningAttempt(running, cause);
		running.promise.catch(() => undefined);
		this.runningAttempts.set(running.id, running);
		taskHooks?.onExecution({
			result: running.promise,
			cleanup: running.promise.then(
				() => cleanup,
				() => cleanup,
			),
		});
		return running;
	}

	continueDetached(running: RunningAttempt, _reason: ContinuationReason): string {
		if (running.status !== "running") throw new Error("continue_detached requires a running attempt");
		this.native.publishChildStatus(running.child.identity.path, nativeStatus("continued"));
		running.status = "continued";
		running.promise.catch(() => undefined);
		return running.child.identity.path;
	}

	getChildMetadata(pathValue: string): ChildRuntimeMetadata | undefined {
		const running = [...this.runningAttempts.values()].find(
			(attempt) =>
				attempt.child.identity.path === pathValue &&
				(attempt.status === "running" || attempt.status === "continued"),
		);
		if (!running) return undefined;
		const model = running.currentModel;
		const thinking = running.currentThinking;
		if (model === undefined && thinking === undefined) return undefined;
		return {
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
		};
	}

	async terminateChildAttempt(running: RunningAttempt, cause: TerminationCauseName): Promise<void> {
		if (running.status !== "running" && running.status !== "continued") return;
		await running.terminate?.(cause);
		await running.promise;
	}

	async deliverChildResult(envelope: ResultEnvelope, options?: DeliverChildResultOptions): Promise<void> {
		if (this.delivered.has(envelope.path)) return;
		this.delivered.add(envelope.path);
		const artifactDir = options?.artifactsDir ?? envelope.artifactsDir;
		const paths =
			options?.artifactPaths ?? (artifactDir ? canonicalArtifactPaths(artifactDir, envelope.path) : undefined);
		const bounded = boundedEnvelope(envelope.envelope, paths?.outputPath, options?.maxOutput);
		const deliveredEnvelope = { ...envelope, envelope: bounded };
		this.deliveredEnvelopes.set(envelope.path, deliveredEnvelope);
		if (options?.artifactsDisabled) return;
		if (!artifactDir || !paths)
			throw new Error(`Artifact persistence paths are unresolved for child ${envelope.path}`);
		ensureArtifactsDir(artifactDir);
		writeArtifact(paths.outputPath, envelope.envelope);
		writeMetadata(paths.metadataPath, {
			...deliveredEnvelope,
			outputPath: paths.outputPath,
		});
		appendFileSync(join(artifactDir, "run-history.jsonl"), `${JSON.stringify(deliveredEnvelope)}\n`, "utf8");
	}

	getDeliveredResult(pathValue: string): ResultEnvelope | undefined {
		return this.deliveredEnvelopes.get(pathValue);
	}
	findChild(pathValue: string): (Omit<ChildIdentity, "status"> & { status: ChildStatus }) | undefined {
		return this.listChildren().find((child) => child.path === pathValue);
	}

	listChildren(): readonly (Omit<ChildIdentity, "status"> & { status: ChildStatus })[] {
		return this.native.listChildren().map((child) => ({
			...child,
			status: child.status === "interrupted" && this.killedChildren.has(child.path) ? "killed" : child.status,
		}));
	}

	subscribe(pathValue: string, callback: (status: ChildStatus) => void): void {
		this.native.subscribeChildStatus(pathValue, (status) =>
			callback(status === "interrupted" && this.killedChildren.has(pathValue) ? "killed" : status),
		);
	}

	private async terminateRunningAttempt(running: RunningAttempt, cause: TerminationCauseName): Promise<void> {
		const terminate = this.attemptTerminators.get(running.child.identity.path);
		if (terminate) {
			await terminate(cause);
			return;
		}
		const token = running.attemptToken ?? this.attemptTokens.get(running.child.identity.path);
		if (token === undefined) {
			await running.promise;
			return;
		}
		try {
			await this.native.terminateChildAttempt(token, nativeCause(cause));
		} catch {
			// The runner's signal path owns the race with terminal completion.
		}
	}
}

export function createSubagentControl(
	parent: ParentContext,
	sessionRoot?: string,
	runningCapacity?: number,
): SubagentControlRuntime {
	return new SubagentControlRuntime(parent, sessionRoot, runningCapacity);
}

export function admit_child_session(
	control: SubagentControlRuntime,
	spec: ChildSpec,
	parent: ParentContext,
): AdmittedResult {
	return control.admitChildSession(spec, parent);
}

export function run_child_attempt(
	control: SubagentControlRuntime,
	admitted: AdmittedChild,
	candidate: ModelCandidate,
	signals: AttemptSignals,
): Promise<AttemptOutcome> {
	return control.runChildAttempt(admitted, candidate, signals, undefined);
}

export function continue_detached(
	control: SubagentControlRuntime,
	running: RunningAttempt,
	reason: ContinuationReason,
): string {
	return control.continueDetached(running, reason);
}

export function terminate_child_attempt(
	control: SubagentControlRuntime,
	running: RunningAttempt,
	cause: TerminationCauseName,
): Promise<void> {
	return control.terminateChildAttempt(running, cause);
}

export function deliver_child_result(
	control: SubagentControlRuntime,
	envelope: ResultEnvelope,
	options?: DeliverChildResultOptions,
): Promise<void> {
	return control.deliverChildResult(envelope, options);
}

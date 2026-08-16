import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionEventListener,
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
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentConfig } from "../../agents/agent-types.ts";
import {
	buildSkillInjection,
	isSubagentOrchestrationSkillSelector,
	resolveSkillsFromCatalog,
} from "../../agents/skills.ts";
import { ensureArtifactsDir, writeArtifact, writeMetadata } from "../../shared/artifacts.ts";
import {
	getSubagentCodexFastModeSettings,
	resolveSubagentCodexFastModeScope,
	resolveSubagentModelFastMode,
} from "../../shared/fast-mode.ts";
import { resolveEffectiveThinking } from "../../shared/model-info.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	DEFAULT_MAX_OUTPUT,
	type MaxOutputConfig,
	normalizeMaxSubagentDepth,
	truncateOutput,
} from "../../shared/types.ts";
import { type ChildModePolicy, resolveChildModePolicy } from "./child-policy.ts";
import { type InProcessNestedResumeOutcome, registerInProcessNestedAttempt } from "./nested-routing.ts";
import { createInProcessChildPromptBehavior, createInProcessChildSystemPromptTransform } from "./prompt-behavior.ts";

export type ChildStatus = NativeAgentStatus;
export type ContinuationReason = "intercom-coordination";
export type TerminationCauseName = NativeTerminationCause;
export type TerminalStatus = "ok" | "error" | "skipped" | "interrupted" | "continued";

export interface ParentContext {
	readonly path: string;
	readonly depth: number;
	readonly sessionId?: string;
	readonly intercomGroup?: string;
	readonly workflowStageSubagentGuard?: boolean;
	readonly orchestrationContext?: CreateAgentSessionOptions["orchestrationContext"];
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
	readonly sessionFile?: string;
	/**
	 * Effective delegation limit for this child, already narrowed by the parent's
	 * limit and the child agent's own `maxSubagentDepth`. Retained on the spec so
	 * a cold reload reissues the same limit.
	 */
	readonly maxSubagentDepth?: number;
	readonly testSession?: boolean | TestSessionOptions;
	readonly artifactJsonlPath?: string;
	/**
	 * Fallback model candidates (full ids, optional `:thinking` suffix) handed to
	 * the SDK session so child fallback uses the exact classification and
	 * candidate-advancement behavior main chat and workflow stages share.
	 */
	readonly fallbackModels?: readonly string[];
	/** Live progress callback for the parent's tool-result rendering. */
	readonly onProgress?: (progress: AgentProgress) => void;
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
function defaultFastModeForChild(
	cwd: string,
	context: ParentContext["orchestrationContext"],
	workflowStageSubagentGuard?: boolean,
): (model?: string) => boolean {
	const settings = getSubagentCodexFastModeSettings(cwd);
	const scope = resolveSubagentCodexFastModeScope(workflowStageSubagentGuard ?? context?.kind === "workflow-stage");
	return (model) => resolveSubagentModelFastMode({ model, cwd, settings, scope });
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
			readonly status: "interrupted";
			readonly stats: AttemptStats;
			readonly path: string;
			readonly envelope: string;
			readonly sessionFile?: string;
			readonly model?: string;
			readonly thinking?: string;
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
	readonly fastMode?: boolean;
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

function waitForExecutionCapacity(delayMs: number, signals: AttemptSignals): Promise<CapacityWaitResult> {
	if (signals.interrupt.aborted) return Promise.resolve("interrupt");
	if (signals.abort.aborted) return Promise.resolve("abort");
	return new Promise((resolveWait) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout>;
		const settle = (result: CapacityWaitResult) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signals.abort.removeEventListener("abort", onAbort);
			signals.interrupt.removeEventListener("abort", onInterrupt);
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
 * Effective delegation limit for an admitted child. A caller that already
 * narrowed the parent's limit against the agent definition puts the result on
 * the spec; a caller admitting a child directly still gets the agent's own
 * declared limit rather than an unbounded policy.
 */
export function effectiveChildMaxSubagentDepth(spec: ChildSpec): number | undefined {
	return spec.maxSubagentDepth ?? normalizeMaxSubagentDepth(spec.agent.maxSubagentDepth);
}

/**
 * In-process children must load the same bundled extensions as the host.
 * Workflow extensions are disabled inside workflow-owned sessions because their
 * startup lifecycle belongs to the parent workflow store.
 */
export function inProcessChildBuiltinPackagePaths(
	context: CreateAgentSessionOptions["orchestrationContext"] | undefined,
): PackageSource[] {
	return getBuiltinPackagePaths().map((source) => {
		if (context?.kind !== "workflow-stage" || basename(source) !== "workflows") return source;
		return { source, extensions: [] };
	});
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
}): ConstructorParameters<typeof DefaultResourceLoader>[0] {
	const agentPrompt = input.agent.systemPrompt?.trim();
	return {
		cwd: input.cwd,
		agentDir: input.agentDir,
		settingsManager: input.settingsManager,
		builtinPackagePaths: inProcessChildBuiltinPackagePaths(input.orchestrationContext),
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
	const promptAbort = new Promise<"aborted">((resolve, reject) => {
		settlePromptAbort = () => {
			if (testOptions.abortResolvesPrompt) resolve("aborted");
			else reject(new Error("aborted"));
		};
	});
	let userMessages = 0;
	let assistantMessages = 0;
	const zeroTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	return {
		sessionFile: sessionManager.getSessionFile(),
		model: sessionModel,
		thinkingLevel: testOptions.sessionThinkingLevel,
		abort: async () => {
			aborted = true;
			settlePromptAbort?.();
		},
		subscribe(listener: AgentSessionEventListener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		prompt: async (text: string) => {
			for (const listener of listeners) listener({ type: "agent_start" } as AgentSessionEvent);
			if (aborted) throw new Error("aborted");
			if (testOptions.promptLogPath) appendFileSync(testOptions.promptLogPath, `${text}\n---PROMPT---\n`, "utf8");
			sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
			userMessages += 1;
			if (testOptions.promptGate) {
				const gateResult = await Promise.race([
					testOptions.promptGate.then(() => "released" as const),
					promptAbort,
				]);
				if (gateResult === "aborted") return "";
			}
			if (testOptions.fallbackModel) {
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
			}
			lastAssistantText = testOptions.output ?? "done";
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: lastAssistantText }],
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
				stopReason: "stop",
				timestamp: Date.now(),
			});
			assistantMessages += 1;
			return lastAssistantText;
		},
		getLastAssistantText: () => lastAssistantText,
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
		dispose: () => {},
	} as unknown as AgentSession;
}

function nativeStatus(value: ChildStatus): NativeAgentStatus {
	return value;
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

function outputFor(session: AgentSession | undefined): string {
	return session?.getLastAssistantText() ?? "";
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
	mkdirSync(dirname(pathValue), { recursive: true });
	appendFileSync(pathValue, `${JSON.stringify(event)}\n`, "utf8");
}

/**
 * A child identity whose constructor is private. Depth and path validation happen
 * at the Rust admission door, so callers cannot manufacture an admitted depth-6
 * child or bypass canonical identity allocation.
 */
interface AdmittedChildInput {
	readonly identity: ChildIdentity;
	readonly spec: ChildSpec;
	readonly policy: ChildPolicy;
	readonly sessionDir: string;
	readonly sessionFile?: string;
	readonly control: SubagentControlRuntime;
}

export class AdmittedChild {
	readonly identity: ChildIdentity;
	readonly spec: ChildSpec;
	readonly policy: ChildPolicy;
	readonly sessionDir: string;
	readonly sessionFile?: string;
	readonly control: SubagentControlRuntime;

	private constructor(input: {
		identity: ChildIdentity;
		spec: ChildSpec;
		policy: ChildPolicy;
		sessionDir: string;
		sessionFile?: string;
		control: SubagentControlRuntime;
	}) {
		this.identity = input.identity;
		this.spec = input.spec;
		this.policy = input.policy;
		this.sessionDir = input.sessionDir;
		this.sessionFile = input.sessionFile;
		this.control = input.control;
	}

	static create(input: AdmittedChildInput): AdmittedChild {
		if (input.identity.depth > 5) throw new Error("child depth exceeds maximum 5");
		validatePath(input.identity.path);
		return new AdmittedChild(input);
	}
}

export interface ChildRuntimeMetadata {
	model?: string;
	thinking?: string;
	fastMode?: boolean;
}

export interface RunningAttempt {
	readonly id: number;
	readonly child: AdmittedChild;
	readonly candidate: ModelCandidate;
	readonly startedAt: number;
	currentModel?: string;
	currentThinking?: string;
	currentFastMode?: boolean;
	status: "running" | ChildStatus;
	promise: Promise<AttemptOutcome>;
	terminate?: (cause: TerminationCauseName) => Promise<void>;
	attemptToken?: number;
}

export interface StartAttemptOptions {
	readonly fastModeForModel?: (model: string | undefined) => boolean;
}

export class SubagentControlRuntime {
	readonly native: SubagentControl;
	readonly parent: ParentContext;
	readonly sessionRoot: string;
	private readonly sessions = new Map<string, AgentSession>();
	private readonly specs = new Map<string, ChildSpec>();
	private readonly sessionFiles = new Map<string, string>();
	private readonly runningAttempts = new Map<number, RunningAttempt>();
	private readonly attemptTokens = new Map<string, number>();
	private readonly attemptTerminators = new Map<string, (cause: TerminationCauseName) => Promise<void>>();
	private readonly delivered = new Set<string>();
	private readonly deliveredEnvelopes = new Map<string, ResultEnvelope>();
	private nextAttemptId = 1;

	constructor(parent: ParentContext, sessionRoot?: string) {
		this.parent = { ...parent };
		this.sessionRoot = trustedSessionRoot(this.parent, sessionRoot);
		this.native = new SubagentControl(this.parent.path);
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
		const sessionDir = spec.sessionFile
			? dirname(spec.sessionFile)
			: sessionDirectory(this.sessionRoot, identity.path);
		mkdirSync(sessionDir, { recursive: true });
		this.specs.set(identity.path, spec);
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
					...(effectiveChildMaxSubagentDepth(spec) === undefined
						? {}
						: { maxSubagentDepth: effectiveChildMaxSubagentDepth(spec) }),
				},
				sessionDir,
				sessionFile: spec.sessionFile,
				control: this,
			}),
		};
	}

	async runChildAttempt(
		admitted: AdmittedChild,
		candidate: ModelCandidate,
		signals: AttemptSignals,
		onModelChange: ((model: string | undefined, thinking?: string, fastMode?: boolean) => void) | undefined,
		fastModeForModel: (model: string | undefined) => boolean,
	): Promise<AttemptOutcome> {
		const candidateModelId = modelIdForCandidate(candidate, admitted.policy.model);
		const configuredThinking = candidate.thinkingLevel ?? admitted.policy.thinkingLevel;
		let effectiveModelId = candidateModelId;
		let effectiveThinking = initialThinkingForAttempt(candidateModelId, configuredThinking);
		let attemptedModels: string[] = candidateModelId ? [candidateModelId] : [];
		let guard: NativeExecutionGuardResult;
		let retryDelayMs = CAPACITY_RETRY_INITIAL_DELAY_MS;
		for (;;) {
			guard = this.native.beginChildAttempt(admitted.identity.path);
			if (guard.token || guard.refusal?.kind !== "capacityExhausted") break;
			const waitResult = await waitForExecutionCapacity(retryDelayMs, signals);
			if (waitResult !== "retry") {
				const stats = { ...EMPTY_STATS, sessionId: admitted.identity.path };
				const status = waitResult === "interrupt" ? "interrupted" : "error";
				this.native.publishChildStatus(admitted.identity.path, nativeStatus(status));
				return status === "interrupted"
					? {
							status,
							stats,
							path: admitted.identity.path,
							envelope: INTERRUPTED_ENVELOPE,
							...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
							...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
						}
					: {
							status,
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
		let activeSessionManager: SessionManager | undefined;
		let termination: TerminationCauseName | undefined;
		let terminating: Promise<void> | undefined;
		let unsubscribe: (() => void) | undefined;
		let skillReport: AttemptSkillReport = {};
		const terminate = async (cause: TerminationCauseName): Promise<void> => {
			if (terminating) return terminating;
			termination = cause;
			terminating = (async () => {
				try {
					activeSessionManager?.flush();
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
			if (admitted.sessionFile) mkdirSync(dirname(admitted.sessionFile), { recursive: true });
			const sessionManager = admitted.sessionFile
				? SessionManager.open(admitted.sessionFile, admitted.sessionDir, admitted.policy.cwd)
				: SessionManager.create(
						admitted.policy.cwd,
						admitted.sessionDir,
						workflow ? { internal: true, workflow } : { internal: true },
					);
			activeSessionManager = sessionManager;
			if (workflow) sessionManager.markSessionInternal(workflow);
			let created: { session: AgentSession };
			if (admitted.spec.testSession) {
				created = { session: createTestSession(sessionManager, admitted.spec) };
			} else {
				const settingsManager = SettingsManager.create(admitted.policy.cwd, getAgentDir());
				const resourceLoader = new DefaultResourceLoader(
					inProcessChildResourceLoaderOptions({
						cwd: admitted.policy.cwd,
						agentDir: getAgentDir(),
						settingsManager,
						agent: admitted.spec.agent,
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
							cwd: admitted.policy.cwd,
							model: candidate.model ?? admitted.policy.model,
							thinkingLevel: candidate.thinkingLevel ?? admitted.policy.thinkingLevel,
							...(admitted.spec.fallbackModels?.length
								? { fallbackModels: [...admitted.spec.fallbackModels] }
								: {}),
							tools: admitted.policy.tools ? [...admitted.policy.tools] : undefined,
							excludedTools: admitted.policy.excludedTools ? [...admitted.policy.excludedTools] : undefined,
							customTools: admitted.policy.customTools,
							resourceLoader,
							sessionManager,
							settingsManager,
							orchestrationContext: admitted.spec.parent?.orchestrationContext,
							subagentPolicy: admitted.policy,
							systemPromptTransform,
							initialContextTransform: promptBehavior.initialContextTransform,
						})
					).session,
				};
			}
			session = created.session;
			if (session.sessionFile) this.sessionFiles.set(admitted.identity.path, session.sessionFile);
			this.sessions.set(admitted.identity.path, session);
			const initialModelId = modelIdForSession(session) ?? candidateModelId;
			effectiveModelId = initialModelId;
			effectiveThinking =
				thinkingLevelForSession(session) ?? initialThinkingForAttempt(candidateModelId, configuredThinking);
			attemptedModels = initialModelId ? [initialModelId] : [];
			onModelChange?.(effectiveModelId, effectiveThinking, fastModeForModel(effectiveModelId));
			const progressState: AgentProgress = {
				index: 0,
				agent: admitted.spec.agent.name,
				status: "running",
				...(initialModelId === undefined ? {} : { model: initialModelId }),
				...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
				fastMode: fastModeForModel(initialModelId),
				task: admitted.spec.task,
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: 0,
				lastActivityAt: Date.now(),
			};
			const attemptStartedAt = Date.now();
			let lastProgressEmit = 0;
			const emitProgress = (force: boolean) => {
				const onProgress = admitted.spec.onProgress;
				if (!onProgress) return;
				const now = Date.now();
				if (!force && now - lastProgressEmit < 400) return;
				lastProgressEmit = now;
				progressState.durationMs = now - attemptStartedAt;
				progressState.lastActivityAt = now;
				onProgress({ ...progressState, recentTools: [...progressState.recentTools] });
			};
			unsubscribe = session.subscribe((event) => {
				writeEvent(admitted.spec.artifactJsonlPath, event);
				const emission = progressEmissionFor(event.type);
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
				if (event.type === "model_fallback_start") {
					if (!attemptedModels.includes(event.to)) attemptedModels.push(event.to);
					effectiveModelId = event.to;
					progressState.model = event.to;
					progressState.fastMode = fastModeForModel(event.to);
					onModelChange?.(effectiveModelId, effectiveThinking, progressState.fastMode);
				} else if (event.type === "thinking_level_changed") {
					effectiveThinking = event.level;
					progressState.thinking = effectiveThinking;
					const fastMode = fastModeForModel(effectiveModelId);
					onModelChange?.(effectiveModelId, effectiveThinking, fastMode);
					emitProgress(true);
				}
			});
			if (signals.abort.aborted) await terminate("abort");
			if (signals.interrupt.aborted) await terminate("interrupt");
			await session.prompt(admitted.spec.task);
			await terminating;
			const stats = statsFor(session, admitted.identity.path);
			const sessionFile = session.sessionFile;
			const output = outputFor(session);
			const status: "ok" | "error" | "interrupted" =
				termination === "interrupt" ? "interrupted" : termination ? "error" : "ok";
			this.native.publishChildStatus(admitted.identity.path, nativeStatus(status));
			this.native.finishChildAttempt(token, nativeStatus(status));
			const envelope =
				status === "interrupted"
					? INTERRUPTED_ENVELOPE
					: boundedEnvelope(output || termination || "(no output)", undefined);
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
			return {
				status,
				cause: termination ?? "agent session ended without a successful completion",
				stats,
				path: admitted.identity.path,
				envelope,
				sessionFile,
				...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
				...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
				...(status === "error" && attemptedModels.length > 1 ? { attemptedModels: [...attemptedModels] } : {}),
				...skillReport,
			};
		} catch (error) {
			const stats = statsFor(session, admitted.identity.path);
			const cause = error instanceof Error ? error.message : String(error);
			const status: "interrupted" | "error" = termination === "interrupt" ? "interrupted" : "error";
			this.native.publishChildStatus(admitted.identity.path, nativeStatus(status));
			try {
				this.native.finishChildAttempt(token, nativeStatus(status));
			} catch {
				// Preserve the original failure when Rust already stamped termination.
			}
			return status === "interrupted"
				? {
						status,
						stats,
						path: admitted.identity.path,
						envelope: INTERRUPTED_ENVELOPE,
						sessionFile: session?.sessionFile,
						...(effectiveModelId === undefined ? {} : { model: effectiveModelId }),
						...(effectiveThinking === undefined ? {} : { thinking: effectiveThinking }),
						...skillReport,
					}
				: {
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
			signals.abort.removeEventListener("abort", abortListener);
			signals.interrupt.removeEventListener("abort", interruptListener);
			try {
				unsubscribe?.();
			} catch {
				// Listener teardown must not replace the attempt result.
			}
			try {
				activeSessionManager?.flush();
			} catch {
				// Persistence teardown must not replace the attempt result.
			}
			try {
				session?.dispose();
			} catch {
				// Session teardown must not replace the attempt result.
			}
			this.sessions.delete(admitted.identity.path);
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
		options: StartAttemptOptions = {},
	): RunningAttempt {
		const initialModel = modelIdForCandidate(candidate, admitted.policy.model);
		const initialThinking = initialThinkingForAttempt(
			initialModel,
			candidate.thinkingLevel ?? admitted.policy.thinkingLevel,
		);
		const fastModeForModel =
			options.fastModeForModel ??
			defaultFastModeForChild(
				admitted.policy.cwd,
				admitted.spec.parent?.orchestrationContext,
				admitted.spec.parent?.workflowStageSubagentGuard,
			);
		const running: RunningAttempt = {
			id: this.nextAttemptId++,
			child: admitted,
			candidate,
			status: "running",
			startedAt: Date.now(),
			...(initialModel === undefined ? {} : { currentModel: initialModel }),
			currentThinking: initialThinking,
			currentFastMode: fastModeForModel(initialModel),
			promise: Promise.resolve({
				status: "error",
				cause: "uninitialized",
				stats: { ...EMPTY_STATS, sessionId: admitted.identity.path },
				path: admitted.identity.path,
				envelope: "uninitialized",
			}),
		};
		running.promise = this.runChildAttempt(
			admitted,
			candidate,
			signals,
			(model, thinking, fastMode) => {
				running.currentModel = model;
				running.currentThinking = thinking;
				running.currentFastMode = fastMode;
			},
			fastModeForModel,
		).then((result) => {
			running.status = result.status;
			this.runningAttempts.delete(running.id);
			return result;
		});
		running.terminate = (cause) => this.terminateRunningAttempt(running, cause);
		running.promise.catch(() => undefined);
		this.runningAttempts.set(running.id, running);
		return running;
	}

	continueDetached(running: RunningAttempt, _reason: ContinuationReason): string {
		if (running.status !== "running") throw new Error("continue_detached requires a running attempt");
		this.native.publishChildStatus(running.child.identity.path, nativeStatus("continued"));
		running.status = "continued";
		running.promise.catch(() => undefined);
		return running.child.identity.path;
	}

	reloadColdChild(pathValue: string, message: string): AdmittedResult {
		let sessionDir: string;
		try {
			sessionDir = sessionDirectory(this.sessionRoot, pathValue);
		} catch (error) {
			return {
				refusal: {
					kind: "invalidCwd",
					reason: error instanceof Error ? error.message : String(error),
				},
			};
		}
		const identity = this.native.listChildren().find((child) => child.path === pathValue);
		if (!identity)
			return {
				refusal: { kind: "unknownAgent", reason: "unknown child identity" },
			};
		const sessionFile = this.sessionFiles.get(pathValue) ?? this.findSessionFile(sessionDir);
		if (!sessionFile)
			return {
				refusal: {
					kind: "invalidCwd",
					reason: "child session file is missing",
				},
			};
		sessionDir = dirname(sessionFile);
		const native = this.native.reloadColdChild(pathValue, message);
		if (!native.child) return refusal(native);
		const previous = this.specs.get(pathValue);
		if (!previous)
			return {
				refusal: {
					kind: "unknownAgent",
					reason: "child policy is not resident",
				},
			};
		const spec: ChildSpec = { ...previous, task: message };
		this.specs.set(pathValue, spec);
		return {
			admitted: AdmittedChild.create({
				identity: native.child,
				spec,
				policy: { ...this.policyFor(spec, native.child.depth) },
				sessionDir,
				sessionFile,
				control: this,
			}),
		};
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
		if (model === undefined && thinking === undefined && running.currentFastMode === undefined) return undefined;
		return {
			...(model === undefined ? {} : { model }),
			...(thinking === undefined ? {} : { thinking }),
			...(running.currentFastMode === undefined ? {} : { fastMode: running.currentFastMode }),
		};
	}

	registerNestedAttempt(runId: string, running: RunningAttempt, candidate: ModelCandidate): void {
		registerInProcessNestedAttempt({
			runId,
			path: running.child.identity.path,
			status: () => running.status,
			interrupt: () => this.terminateChildAttempt(running, "interrupt"),
			resume: async (message): Promise<InProcessNestedResumeOutcome> => {
				const admission = this.reloadColdChild(running.child.identity.path, message);
				if (!admission.admitted) {
					throw new Error(admission.refusal?.reason ?? "nested child cold reload was refused");
				}
				const neverAbort = new AbortController().signal;
				const resumed = this.startAttempt(admission.admitted, candidate, {
					abort: neverAbort,
					interrupt: neverAbort,
				});
				const outcome = await resumed.promise;
				return {
					status: outcome.status,
					path: outcome.path,
					sessionFile: outcome.sessionFile,
					envelope: outcome.envelope,
				};
			},
		});
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
	findChild(pathValue: string): ChildIdentity | undefined {
		return this.native.listChildren().find((child) => child.path === pathValue);
	}

	listChildren(): readonly ChildIdentity[] {
		return this.native.listChildren();
	}

	async interruptChild(pathValue: string): Promise<boolean> {
		const running = [...this.runningAttempts.values()].find(
			(attempt) =>
				attempt.child.identity.path === pathValue &&
				(attempt.status === "running" || attempt.status === "continued"),
		);
		if (!running) return false;
		await this.terminateChildAttempt(running, "interrupt");
		return true;
	}
	async resumeChild(
		pathValue: string,
		message: string,
		candidate: ModelCandidate,
		signals: AttemptSignals = {
			abort: new AbortController().signal,
			interrupt: new AbortController().signal,
		},
	): Promise<AttemptOutcome> {
		const admission = this.reloadColdChild(pathValue, message);
		if (!admission.admitted) {
			const reason = admission.refusal?.reason ?? "cold child reload was refused";
			return {
				status: "error",
				cause: reason,
				stats: { ...EMPTY_STATS, sessionId: pathValue },
				path: pathValue,
				envelope: boundedEnvelope(reason),
			};
		}
		const running = this.startAttempt(admission.admitted, candidate, signals);
		return running.promise;
	}

	subscribe(pathValue: string, callback: (status: ChildStatus) => void): void {
		this.native.subscribeChildStatus(pathValue, callback);
	}

	private policyFor(spec: ChildSpec, depth: number): ChildPolicy {
		return {
			...resolveChildModePolicy(spec),
			cwd: spec.cwd,
			tools: spec.tools ?? spec.agent.tools,
			excludedTools: spec.excludedTools,
			mcpDirectTools: spec.mcpDirectTools ?? spec.agent.mcpDirectTools,
			skills: [...(spec.skills ?? spec.agent.skills ?? [])],
			customTools: spec.customTools,
			model: spec.model,
			thinkingLevel: spec.thinkingLevel ?? (spec.agent.thinking as ChildPolicy["thinkingLevel"]),
			intercomGroup: spec.parent?.intercomGroup,
			depth,
			...(effectiveChildMaxSubagentDepth(spec) === undefined
				? {}
				: { maxSubagentDepth: effectiveChildMaxSubagentDepth(spec) }),
		};
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

	private findSessionFile(sessionDir: string): string | undefined {
		try {
			const entry = readdirSync(sessionDir, { withFileTypes: true }).find(
				(candidate) => candidate.isFile() && candidate.name.endsWith(".jsonl"),
			);
			return entry ? join(sessionDir, entry.name) : undefined;
		} catch {
			return undefined;
		}
	}
}

export function createSubagentControl(parent: ParentContext, sessionRoot?: string): SubagentControlRuntime {
	return new SubagentControlRuntime(parent, sessionRoot);
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
	return control.runChildAttempt(
		admitted,
		candidate,
		signals,
		undefined,
		defaultFastModeForChild(
			admitted.policy.cwd,
			admitted.spec.parent?.orchestrationContext,
			admitted.spec.parent?.workflowStageSubagentGuard,
		),
	);
}

export function continue_detached(
	control: SubagentControlRuntime,
	running: RunningAttempt,
	reason: ContinuationReason,
): string {
	return control.continueDetached(running, reason);
}

export function reload_cold_child(control: SubagentControlRuntime, pathValue: string, message: string): AdmittedResult {
	return control.reloadColdChild(pathValue, message);
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

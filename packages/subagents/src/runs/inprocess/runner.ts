import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
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
import { ensureArtifactsDir, writeArtifact, writeMetadata } from "../../shared/artifacts.ts";
import {
	type AgentProgress,
	type ArtifactPaths,
	DEFAULT_MAX_OUTPUT,
	type JsonSchemaObject,
	type MaxOutputConfig,
	truncateOutput,
} from "../../shared/types.ts";
import {
	formatStructuredOutputCorrectionPrompt,
	readStructuredOutput,
	STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS,
} from "../shared/structured-output.ts";
import { type ChildModePolicy, resolveChildModePolicy } from "./child-policy.ts";
import { type InProcessNestedResumeOutcome, registerInProcessNestedAttempt } from "./nested-routing.ts";
import { createInProcessChildPromptBehavior } from "./prompt-behavior.ts";

export type ChildStatus = NativeAgentStatus;
export type ContinuationReason = "async-requested" | "intercom-coordination";
export type TerminationCauseName = NativeTerminationCause;
export type TerminalStatus = "ok" | "error" | "skipped" | "interrupted" | "continued";

export interface ParentContext {
	readonly path: string;
	readonly depth: number;
	readonly sessionId?: string;
	readonly intercomGroup?: string;
	readonly orchestrationContext?: CreateAgentSessionOptions["orchestrationContext"];
}

export interface TestSessionOptions {
	readonly output?: string;
	readonly structuredOutputAfterPrompt?: number;
	readonly promptLogPath?: string;
	/** Hold a test prompt open until the caller releases the supplied promise. */
	readonly promptGate?: Promise<void>;
	/** Match AgentSession.abort() settling an active prompt without throwing. */
	readonly abortResolvesPrompt?: boolean;
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
	readonly testSession?: boolean | TestSessionOptions;
	readonly structuredOutput?: { readonly schema: JsonSchemaObject; readonly outputPath: string };
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

export interface AttemptSignals {
	readonly abort: AbortSignal;
	readonly interrupt: AbortSignal;
}

export type AttemptStats = SessionStats;

export type AttemptOutcome =
	| {
			readonly status: "ok";
			readonly output: string;
			readonly stats: AttemptStats;
			readonly path: string;
			readonly envelope: string;
			readonly sessionFile?: string;
			readonly structuredOutput?: unknown;
			readonly model?: string;
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
			readonly attemptedModels?: readonly string[];
	  }
	| {
			readonly status: "interrupted";
			readonly stats: AttemptStats;
			readonly path: string;
			readonly envelope: string;
			readonly sessionFile?: string;
	  }
	| {
			readonly status: "continued";
			readonly childPath: string;
			readonly stats: AttemptStats;
			readonly path: string;
			readonly envelope: string;
			readonly sessionFile?: string;
	  };

export interface ResultEnvelope {
	readonly path: string;
	readonly status: TerminalStatus;
	readonly cause?: string;
	readonly stats: AttemptStats;
	readonly envelope: string;
	readonly model?: string;
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

function createTestSession(sessionManager: SessionManager, spec: ChildSpec): AgentSession {
	const listeners = new Set<AgentSessionEventListener>();
	const testOptions = typeof spec.testSession === "object" ? spec.testSession : {};
	let lastAssistantText = "";
	let aborted = false;
	let settlePromptAbort: (() => void) | undefined;
	const promptAbort = new Promise<"aborted">((resolve, reject) => {
		settlePromptAbort = () => {
			if (testOptions.abortResolvesPrompt) resolve("aborted");
			else reject(new Error("aborted"));
		};
	});
	let promptCount = 0;
	let userMessages = 0;
	let assistantMessages = 0;
	const zeroTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const zeroCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	return {
		sessionFile: sessionManager.getSessionFile(),
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
			promptCount += 1;
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
			if (
				spec.structuredOutput &&
				testOptions.structuredOutputAfterPrompt !== undefined &&
				promptCount >= testOptions.structuredOutputAfterPrompt
			) {
				writeFileSync(spec.structuredOutput.outputPath, JSON.stringify({ answer: "ok" }), "utf8");
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

export interface RunningAttempt {
	readonly id: number;
	readonly child: AdmittedChild;
	readonly candidate: ModelCandidate;
	readonly startedAt: number;
	status: "running" | ChildStatus;
	promise: Promise<AttemptOutcome>;
	terminate?: (cause: TerminationCauseName) => Promise<void>;
	attemptToken?: number;
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
	): Promise<AttemptOutcome> {
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
						}
					: {
							status,
							cause: waitResult,
							stats,
							path: admitted.identity.path,
							envelope: boundedEnvelope(waitResult),
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
			};
		}
		const token = guard.token;
		this.attemptTokens.set(admitted.identity.path, token);
		let session: AgentSession | undefined;
		let activeSessionManager: SessionManager | undefined;
		let termination: TerminationCauseName | undefined;
		let terminating: Promise<void> | undefined;
		let unsubscribe: (() => void) | undefined;
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
			const settingsManager = SettingsManager.create(admitted.policy.cwd, getAgentDir());
			const agentPrompt = admitted.spec.agent.systemPrompt?.trim();
			const resourceLoader = new DefaultResourceLoader({
				cwd: admitted.policy.cwd,
				agentDir: getAgentDir(),
				settingsManager,
				...(agentPrompt && admitted.spec.agent.systemPromptMode === "append"
					? { appendSystemPrompt: [agentPrompt] }
					: agentPrompt
						? { systemPrompt: agentPrompt }
						: {}),
			});
			await resourceLoader.reload();
			const promptBehavior = createInProcessChildPromptBehavior(admitted.policy);
			const created = admitted.spec.testSession
				? { session: createTestSession(sessionManager, admitted.spec) }
				: await createAgentSession({
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
						systemPromptTransform: promptBehavior.systemPromptTransform,
						initialContextTransform: promptBehavior.initialContextTransform,
					});
			session = created.session;
			if (session.sessionFile) this.sessionFiles.set(admitted.identity.path, session.sessionFile);
			this.sessions.set(admitted.identity.path, session);
			const initialModelId =
				candidate.modelId ??
				(candidate.model ? `${candidate.model.provider}/${candidate.model.id}` : undefined) ??
				(admitted.policy.model ? `${admitted.policy.model.provider}/${admitted.policy.model.id}` : undefined);
			let effectiveModelId = initialModelId;
			const attemptedModels: string[] = initialModelId ? [initialModelId] : [];
			const progressState: AgentProgress = {
				index: 0,
				agent: admitted.spec.agent.name,
				status: "running",
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
				if (event.type === "agent_start") {
					this.native.publishChildStatus(admitted.identity.path, nativeStatus("running"));
					emitProgress(true);
				} else if (event.type === "tool_execution_start") {
					progressState.toolCount += 1;
					progressState.currentTool = event.toolName;
					progressState.currentToolArgs = safeArgsPreview(event.args);
					progressState.currentToolStartedAt = Date.now();
					emitProgress(true);
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
					emitProgress(true);
				} else if (event.type === "message_end") {
					const message = (event as { message?: { role?: string; usage?: { input?: number; output?: number } } })
						.message;
					if (message?.role === "assistant") {
						progressState.turnCount = (progressState.turnCount ?? 0) + 1;
						const usage = message.usage;
						if (usage) progressState.tokens += (usage.input ?? 0) + (usage.output ?? 0);
					}
					emitProgress(false);
				} else {
					emitProgress(false);
				}
				if (event.type === "model_fallback_start") {
					if (!attemptedModels.includes(event.to)) attemptedModels.push(event.to);
					effectiveModelId = event.to;
				}
			});
			if (signals.abort.aborted) await terminate("abort");
			if (signals.interrupt.aborted) await terminate("interrupt");
			let structuredOutput: unknown;
			let prompt = admitted.spec.task;
			for (let correction = 0; ; correction += 1) {
				await session.prompt(prompt);
				if (!admitted.spec.structuredOutput) break;
				const structured = readStructuredOutput({
					schema: admitted.spec.structuredOutput.schema,
					schemaPath: "",
					outputPath: admitted.spec.structuredOutput.outputPath,
				});
				if (structured.value !== undefined) {
					structuredOutput = structured.value;
					break;
				}
				const error = structured.error ?? "Structured output contract failed.";
				if (correction >= STRUCTURED_OUTPUT_MAX_CORRECTIVE_PROMPTS) throw new Error(error);
				prompt = formatStructuredOutputCorrectionPrompt({
					originalTask: admitted.spec.task,
					error,
					attempt: correction + 1,
				});
			}
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
					...(attemptedModels.length > 1 ? { attemptedModels: [...attemptedModels] } : {}),
					...(structuredOutput === undefined ? {} : { structuredOutput }),
				};
			return {
				status,
				cause: termination ?? "agent session ended without a successful completion",
				stats,
				path: admitted.identity.path,
				envelope,
				sessionFile,
				...(status === "error" && effectiveModelId !== undefined ? { model: effectiveModelId } : {}),
				...(status === "error" && attemptedModels.length > 1 ? { attemptedModels: [...attemptedModels] } : {}),
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
					}
				: {
						status,
						cause,
						stats,
						path: admitted.identity.path,
						envelope: boundedEnvelope(cause),
						sessionFile: session?.sessionFile,
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

	startAttempt(admitted: AdmittedChild, candidate: ModelCandidate, signals: AttemptSignals): RunningAttempt {
		const running: RunningAttempt = {
			id: this.nextAttemptId++,
			child: admitted,
			candidate,
			status: "running",
			startedAt: Date.now(),
			promise: Promise.resolve({
				status: "error",
				cause: "uninitialized",
				stats: { ...EMPTY_STATS, sessionId: admitted.identity.path },
				path: admitted.identity.path,
				envelope: "uninitialized",
			}),
		};
		running.promise = this.runChildAttempt(admitted, candidate, signals).then((result) => {
			running.status = result.status;
			this.runningAttempts.delete(running.id);
			return result;
		});
		running.terminate = (cause) => this.terminateRunningAttempt(running, cause);
		running.promise.catch(() => undefined);
		this.runningAttempts.set(running.id, running);
		return running;
	}

	continueInBackground(running: RunningAttempt, _reason: ContinuationReason): string {
		if (running.status !== "running") throw new Error("continue_in_background requires a running attempt");
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
	return control.runChildAttempt(admitted, candidate, signals);
}

export function continue_in_background(
	control: SubagentControlRuntime,
	running: RunningAttempt,
	reason: ContinuationReason,
): string {
	return control.continueInBackground(running, reason);
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

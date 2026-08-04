import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import {
	type AgentSession,
	type AgentSessionEvent,
	type CreateAgentSessionOptions,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	SessionManager,
	type SessionStats,
	SettingsManager,
} from "@bastani/atomic";
import {
	type ChildIdentity,
	type NativeAdmissionResult,
	type AgentStatus as NativeAgentStatus,
	type TerminationCause as NativeTerminationCause,
	SubagentControl,
} from "@bastani/atomic-natives";
import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { AgentConfig } from "../../agents/agent-types.ts";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact, writeMetadata } from "../../shared/artifacts.ts";
import { DEFAULT_MAX_OUTPUT, type MaxOutputConfig, truncateOutput } from "../../shared/types.ts";

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
	readonly artifactJsonlPath?: string;
}

export interface ChildPolicy {
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
	  }
	| {
			readonly status: "error";
			readonly cause: string;
			readonly stats: AttemptStats;
			readonly path: string;
			readonly envelope: string;
			readonly sessionFile?: string;
			readonly fallbackSignal?: string;
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
		return { ...EMPTY_STATS, sessionId: fallbackSessionId, sessionFile: session.sessionFile };
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
	mkdirSync(child, { recursive: true });
	return root;
}

function sessionDirectory(root: string, pathValue: string): string {
	validatePath(pathValue);
	const directory = resolve(root, ...pathValue.split("/"));
	if (relative(root, directory).startsWith("..")) throw new Error("child session path escapes trusted root");
	return directory;
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
	private readonly runningAttempts = new Map<number, RunningAttempt>();
	private readonly attemptTokens = new Map<string, number>();
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
			return { refusal: { kind: "invalidCwd", reason: `cwd is not a directory: ${spec.cwd}` } };
		}
		const native = this.native.admitChildSession(
			{ taskName: spec.taskName, agentName: spec.agent.name, cwd: spec.cwd },
			{ path: parent.path, depth: parent.depth },
		);
		if (!native.child) return refusal(native);
		const identity = native.child;
		const sessionDir = sessionDirectory(this.sessionRoot, identity.path);
		mkdirSync(sessionDir, { recursive: true });
		this.specs.set(identity.path, spec);
		return {
			admitted: AdmittedChild.create({
				identity,
				spec,
				policy: {
					cwd: spec.cwd,
					tools: spec.tools ?? spec.agent.tools,
					excludedTools: spec.excludedTools,
					mcpDirectTools: spec.mcpDirectTools ?? spec.agent.mcpDirectTools,
					skills: [...(spec.skills ?? spec.agent.skills ?? [])],
					customTools: spec.customTools,
					model: spec.model,
					thinkingLevel: spec.thinkingLevel ?? (spec.agent.thinking as ChildPolicy["thinkingLevel"]),
					intercomGroup: parent.intercomGroup,
					depth: identity.depth,
				},
				sessionDir,
				control: this,
			}),
		};
	}

	async runChildAttempt(
		admitted: AdmittedChild,
		candidate: ModelCandidate,
		signals: AttemptSignals,
	): Promise<AttemptOutcome> {
		const guard = this.native.beginChildAttempt(admitted.identity.path);
		if (!guard.token) {
			const stats = { ...EMPTY_STATS, sessionId: admitted.identity.path };
			return {
				status: "error",
				cause: guard.refusal?.reason ?? "child execution was refused",
				stats,
				path: admitted.identity.path,
				envelope: boundedEnvelope(guard.refusal?.reason ?? "child execution was refused"),
			};
		}
		const token = guard.token;
		this.attemptTokens.set(admitted.identity.path, token);
		let session: AgentSession | undefined;
		let termination: TerminationCauseName | undefined;
		let terminating: Promise<void> | undefined;
		const terminate = async (cause: TerminationCauseName): Promise<void> => {
			if (terminating) return terminating;
			termination = cause;
			terminating = (async () => {
				try {
					await session?.abort();
				} finally {
					try {
						this.native.terminateChildAttempt(token, nativeCause(cause));
					} catch {
						// The attempt may have completed between signal delivery and termination.
					}
				}
			})();
			return terminating;
		};
		const abortListener = () => void terminate("abort");
		const interruptListener = () => void terminate("interrupt");
		signals.abort.addEventListener("abort", abortListener, { once: true });
		signals.interrupt.addEventListener("abort", interruptListener, { once: true });
		try {
			const sessionManager = admitted.sessionFile
				? SessionManager.open(admitted.sessionFile, admitted.sessionDir, admitted.policy.cwd)
				: SessionManager.create(admitted.policy.cwd, admitted.sessionDir, { internal: true });
			const settingsManager = SettingsManager.create(admitted.policy.cwd, getAgentDir());
			const resourceLoader = new DefaultResourceLoader({
				cwd: admitted.policy.cwd,
				agentDir: getAgentDir(),
				settingsManager,
			});
			await resourceLoader.reload();
			const created = await createAgentSession({
				cwd: admitted.policy.cwd,
				model: candidate.model ?? admitted.policy.model,
				thinkingLevel: candidate.thinkingLevel ?? admitted.policy.thinkingLevel,
				tools: admitted.policy.tools ? [...admitted.policy.tools] : undefined,
				excludedTools: admitted.policy.excludedTools ? [...admitted.policy.excludedTools] : undefined,
				customTools: admitted.policy.customTools,
				resourceLoader,
				sessionManager,
				settingsManager,
				orchestrationContext: admitted.spec.parent?.orchestrationContext,
			});
			session = created.session;
			this.sessions.set(admitted.identity.path, session);
			const unsubscribe = session.subscribe((event) => {
				writeEvent(admitted.spec.artifactJsonlPath, event);
				if (event.type === "agent_start")
					this.native.publishChildStatus(admitted.identity.path, nativeStatus("running"));
			});
			if (signals.abort.aborted) await terminate("abort");
			if (signals.interrupt.aborted) await terminate("interrupt");
			await session.prompt(admitted.spec.task);
			await terminating;
			unsubscribe();
			const stats = statsFor(session, admitted.identity.path);
			const sessionFile = session.sessionFile;
			const output = outputFor(session);
			const status: "ok" | "error" | "interrupted" =
				termination === "interrupt" ? "interrupted" : termination ? "error" : "ok";
			this.native.publishChildStatus(admitted.identity.path, nativeStatus(status));
			this.native.finishChildAttempt(token, nativeStatus(status));
			const envelope = boundedEnvelope(output || termination || "(no output)", undefined);
			if (status === "ok") return { status, output, stats, path: admitted.identity.path, envelope, sessionFile };
			return {
				status,
				cause: termination ?? "agent session ended without a successful completion",
				stats,
				path: admitted.identity.path,
				envelope,
				sessionFile,
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
						envelope: boundedEnvelope(cause),
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
			this.sessions.delete(admitted.identity.path);
			if (this.attemptTokens.get(admitted.identity.path) === token)
				this.attemptTokens.delete(admitted.identity.path);
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
			return { refusal: { kind: "invalidCwd", reason: error instanceof Error ? error.message : String(error) } };
		}
		const identity = this.native.listChildren().find((child) => child.path === pathValue);
		if (!identity) return { refusal: { kind: "unknownAgent", reason: "unknown child identity" } };
		const sessionFile = this.findSessionFile(sessionDir);
		if (!sessionFile) return { refusal: { kind: "invalidCwd", reason: "child session file is missing" } };
		const native = this.native.reloadColdChild(pathValue, message);
		if (!native.child) return refusal(native);
		const previous = this.specs.get(pathValue);
		if (!previous) return { refusal: { kind: "unknownAgent", reason: "child policy is not resident" } };
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

	async terminateChildAttempt(running: RunningAttempt, cause: TerminationCauseName): Promise<void> {
		if (running.status !== "running" && running.status !== "continued") return;
		await running.terminate?.(cause);
		await running.promise;
	}

	async deliverChildResult(
		envelope: ResultEnvelope,
		options?: { readonly artifactsDir?: string; readonly maxOutput?: MaxOutputConfig },
	): Promise<void> {
		if (this.delivered.has(envelope.path)) return;
		this.delivered.add(envelope.path);
		this.deliveredEnvelopes.set(envelope.path, envelope);
		const artifactDir = options?.artifactsDir ?? envelope.artifactsDir;
		if (!artifactDir) return;
		ensureArtifactsDir(artifactDir);
		const paths = getArtifactPaths(artifactDir, envelope.path.replaceAll("/", "_"), envelope.path);
		const bounded = boundedEnvelope(envelope.envelope, paths.outputPath, options?.maxOutput);
		writeArtifact(paths.outputPath, envelope.envelope);
		writeMetadata(paths.metadataPath, { ...envelope, envelope: bounded, outputPath: paths.outputPath });
		appendFileSync(
			join(artifactDir, "run-history.jsonl"),
			`${JSON.stringify({ ...envelope, envelope: bounded })}\n`,
			"utf8",
		);
	}

	getDeliveredResult(pathValue: string): ResultEnvelope | undefined {
		return this.deliveredEnvelopes.get(pathValue);
	}

	subscribe(pathValue: string, callback: (status: ChildStatus) => void): void {
		this.native.subscribeChildStatus(pathValue, callback);
	}

	private policyFor(spec: ChildSpec, depth: number): ChildPolicy {
		return {
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
		const token = running.attemptToken ?? this.attemptTokens.get(running.child.identity.path);
		if (token === undefined) {
			await running.promise;
			return;
		}
		running.attemptToken = token;
		try {
			this.native.terminateChildAttempt(token, nativeCause(cause));
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
	options?: { readonly artifactsDir?: string; readonly maxOutput?: MaxOutputConfig },
): Promise<void> {
	return control.deliverChildResult(envelope, options);
}

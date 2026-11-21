import { join } from "node:path";
import {
	type Cleanup,
	formatNoUsableModelMessage,
	isSessionStartTimeoutError,
	parseSessionStartTimeoutMs,
	type SessionStartTimeoutError,
	type SkippedModel,
	serializeSessionStartError,
	sessionStartStepText,
	spanElapsedMs,
	type TaskElapsedSpan,
} from "@bastani/atomic";
import type { AgentConfig } from "../../agents/agent-types.js";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact } from "../../shared/artifacts.js";
import { childSessionLocator } from "../../shared/child-session-store.js";
import { checkLaunchCwd } from "../../shared/launch-cwd.js";
import { splitKnownThinkingSuffix, splitUnknownThinkingSuffix, THINKING_LEVELS } from "../../shared/model-info.js";
import type {
	AgentProgress,
	ArtifactPaths,
	Details,
	ModelAttempt,
	RunSyncOptions,
	SingleResult,
	SubagentToolResult,
	TaskExecutionHooks,
	Usage,
} from "../../shared/types.js";
import { resolveTopLevelParallelRunningCapacity } from "../../shared/types.js";
import { getOrCreateSubagentControl, unregisterSubagentControl } from "../inprocess/control-registry.js";
import type { AttemptOutcome, ChildSpec, ParentContext, SubagentControlRuntime } from "../inprocess/runner.js";
import type { SessionStartProgress } from "../inprocess/session-start-budget.js";
import { isParentCancellation } from "../shared/cancellation-recovery.js";
import { finishElapsedSpan } from "../shared/elapsed.js";
import { filterSpawnableModelCandidates, skippedModelAttempt } from "../shared/model-candidate-filter.js";
import { buildModelCandidates, launchRequestedModel, resolveModelCandidate } from "../shared/model-fallback.js";
import {
	captureSingleOutputSnapshot,
	formatSavedOutputReference,
	resolveSingleOutput,
	type SingleOutputSnapshot,
} from "../shared/single-output.js";
import { SUBAGENT_START_ATTEMPTS, type SubagentStartProgress } from "../shared/start-progress.js";
import { registerExecutionIntercomDetach } from "./execution-intercom-detach.js";
import { registerExecutionParentAskHandoff } from "./execution-parent-ask-handoff.js";
import { missingCwdMessage } from "./subagent-executor-cwd.js";

function defaultTestSession(): boolean {
	if (process.env.NODE_TEST_CONTEXT !== undefined) return true;
	// Bracket lookup so Bun.build cannot inline `process.env.NODE_ENV` at
	// bundle time. Packed Node consumers must not inherit a compile-time stub.
	return process.env["NODE_ENV"] === "test";
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
}

function usageFromStats(stats: AttemptOutcome["stats"]): Usage {
	return {
		input: stats.tokens.input,
		output: stats.tokens.output,
		cacheRead: stats.tokens.cacheRead,
		cacheWrite: stats.tokens.cacheWrite,
		cost: stats.cost,
		turns: stats.assistantMessages,
	};
}

function progressFor(
	agent: AgentConfig,
	task: string,
	outcome: AttemptOutcome,
	durationMs: number,
	index: number,
): AgentProgress {
	const status =
		outcome.status === "ok"
			? "completed"
			: outcome.status === "killed"
				? "killed"
				: outcome.status === "interrupted" && isParentCancellation(outcome.cause)
					? "interrupted"
					: "failed";
	return {
		index,
		agent: agent.name,
		status,
		task,
		...(outcome.model === undefined ? {} : { model: outcome.model }),
		...(outcome.thinking === undefined ? {} : { thinking: outcome.thinking }),
		recentTools: [],
		recentOutput: outcome.envelope ? outcome.envelope.split("\n").slice(-10) : [],
		toolCount: outcome.stats.toolCalls,
		turnCount: outcome.stats.assistantMessages,
		tokens: outcome.stats.tokens.total,
		durationMs,
		lastActivityAt: Date.now(),
		...(outcome.status === "error" ? { error: outcome.cause } : {}),
		...(outcome.status === "interrupted" && isParentCancellation(outcome.cause) ? { cause: outcome.cause } : {}),
	};
}

function resultFromOutcome(
	agent: AgentConfig,
	task: string,
	outcome: AttemptOutcome,
	durationMs: number,
	artifactPaths: ArtifactPaths | undefined,
	index: number,
	place: { readonly cwd: string; readonly parentCwd: string },
	requestedModel?: string,
): SingleResult {
	const status = outcome.status;
	const output =
		outcome.status === "killed"
			? "Killed. This child cannot be resumed."
			: outcome.status === "ok"
				? outcome.output
				: outcome.envelope;
	const model = outcome.model;
	const thinking = outcome.thinking;
	const result: SingleResult = {
		agent: agent.name,
		task,
		status,
		...(outcome.status === "error"
			? {
					cause: outcome.cause,
					error: outcome.cause,
					...(outcome.startError ? { startError: serializeSessionStartError(outcome.startError) } : {}),
				}
			: outcome.status === "interrupted" && isParentCancellation(outcome.cause)
				? { cause: outcome.cause }
				: {}),
		stats: outcome.stats,
		path: outcome.path,
		envelope: outcome.status === "killed" ? output : outcome.envelope,
		interrupted: status === "interrupted" ? true : undefined,
		...(outcome.status === "interrupted" && outcome.released ? { released: outcome.released } : {}),
		...(outcome.status === "interrupted" && outcome.pendingMessages
			? {
					pendingMessages: outcome.pendingMessages,
					...(outcome.pendingTaskExpands ? { pendingTaskExpands: true } : {}),
				}
			: {}),
		messages: [],
		usage: usageFromStats(outcome.stats),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(requestedModel ? { requestedModel } : {}),
		...("attemptedModels" in outcome && outcome.attemptedModels?.length
			? { attemptedModels: [...outcome.attemptedModels] }
			: {}),
		...(outcome.skills?.length ? { skills: [...outcome.skills] } : {}),
		...(outcome.skillsWarning ? { skillsWarning: outcome.skillsWarning } : {}),
		finalOutput: output,
		sessionFile: outcome.sessionFile,
		// A session with no file of its own, in its parent's store, is read by its history URL. Without a session the
		// child's stats name its admitted path instead, which is no session to read.
		...(outcome.sessionFile || !outcome.stats.sessionId || outcome.stats.sessionId === outcome.path
			? {}
			: {
					sessionUrl: childSessionLocator({
						sessionId: outcome.stats.sessionId,
						cwd: outcome.sessionCwd ?? place.cwd,
						parentCwd: place.parentCwd,
					}),
				}),
		...(outcome.worktreeCapturedAt === undefined ? {} : { worktreeCapturedAt: outcome.worktreeCapturedAt }),
		progress: progressFor(agent, task, outcome, durationMs, index),
		progressSummary: {
			toolCount: outcome.stats.toolCalls,
			tokens: outcome.stats.tokens.total,
			durationMs,
		},
		...(artifactPaths ? { artifactPaths } : {}),
	};
	return result;
}

function refusedResult(agent: string, task: string, reason: string, options: RunSyncOptions): SingleResult {
	// Only a refusal after dispatch has an execution span. No attempt exists to finish it for us.
	const span = options.elapsedSpan;
	if (span) finishElapsedSpan(span, options.taskExecution);
	return {
		agent,
		...(span ? { progressSummary: { durationMs: spanElapsedMs(span), tokens: 0, toolCount: 0 } } : {}),
		task,
		status: "error",
		cause: reason,
		error: reason,
		stats: {
			sessionFile: undefined,
			sessionId: "",
			userMessages: 0,
			assistantMessages: 0,
			toolCalls: 0,
			toolResults: 0,
			totalMessages: 0,
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			cost: 0,
		},
		path: "",
		envelope: reason,
		messages: [],
		usage: emptyUsage(),
	};
}

function noSpawnableCandidatesMessage(skippedModels: readonly SkippedModel[]): string {
	return `No spawnable subagent model candidates after pre-spawn filtering. ${
		skippedModels.length > 0 ? formatNoUsableModelMessage(skippedModels) : ""
	}`.trim();
}

/** A launch that named a model none of whose candidates, the model and its agent's fallbacks, is available (#4188). */
function namedModelUnavailableMessage(namedModel: string, skipped: ModelAttempt[]): string {
	const reasons = skipped.map((attempt) => attempt.error).filter((reason): reason is string => reason !== undefined);
	return `Model ${namedModel} is not available${reasons.length ? ` (${reasons.join(" ")})` : ""}. No other model was used: a subagent launched on a named model runs only that model and its agent's fallbackModels.`;
}

/** A launch of `provider/model:word` whose word names no thinking level, and whose model does not resolve either. */
function unknownModelMessage(candidate: string, effort: string, baseModel: string): string {
	return `Unknown model "${candidate}": "${effort}" is not an effort level (${THINKING_LEVELS.join(", ")}), and no available model is "${baseModel}".`;
}

interface AdmissionTurn {
	readonly ahead: Promise<void> | undefined;
	release(): void;
}

const admissionQueues = new Map<string, { pending: number; tail: Promise<void> }>();

function takeAdmissionTurn(runId: string): AdmissionTurn {
	const queue = admissionQueues.get(runId) ?? { pending: 0, tail: Promise.resolve() };
	const ahead = queue.pending > 0 ? queue.tail : undefined;
	const released = Promise.withResolvers<void>();
	queue.pending += 1;
	queue.tail = queue.tail.then(() => released.promise);
	admissionQueues.set(runId, queue);
	let open = true;
	return {
		ahead,
		release() {
			if (!open) return;
			open = false;
			released.resolve();
			queue.pending -= 1;
			if (queue.pending === 0 && admissionQueues.get(runId) === queue) admissionQueues.delete(runId);
		},
	};
}

export async function runSingleInProcess(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const turn = takeAdmissionTurn(options.runId);
	try {
		return await launchSingleInProcess(runtimeCwd, agent, task, options, turn);
	} finally {
		turn.release();
	}
}

async function launchSingleInProcess(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	options: RunSyncOptions,
	turn: AdmissionTurn,
): Promise<SingleResult> {
	const elapsedSpan: TaskElapsedSpan = options.elapsedSpan ?? { dispatchedAt: Date.now() };
	const sessionStartTimeoutMs = parseSessionStartTimeoutMs(
		options.sessionStartTimeoutMs,
		"sdk",
		"sessionStartTimeoutMs",
	);
	const refuse = (reason: string, modelAttempts?: ModelAttempt[]): SingleResult => ({
		...refusedResult(agent.name, task, reason, options),
		...(modelAttempts ? { modelAttempts } : {}),
	});
	const cwd = options.cwd ?? runtimeCwd;
	const cwdVerdict = options.cwdVerdict?.path === cwd ? options.cwdVerdict : await checkLaunchCwd(cwd);
	if (cwdVerdict.state === "missing") return refuse(missingCwdMessage(cwd));
	if (cwdVerdict.state === "not-directory") return refuse(`cwd is not a directory: ${cwd}`);
	const agentModel = agent.model === "auto" ? undefined : agent.model;
	const launchModel = options.modelOverride ?? agentModel ?? "";
	// #4188: a launch that names a concrete model, in its call or its agent, runs that model and the fallbackModels its
	// agent configures, and never another model it did not opt into: not the parent's model, nor a settings or parent
	// session chain. A launch on `auto`, or one that names no model, keeps the parent's model as its last fallback.
	const namesModel = options.runsNamedModel !== false && launchModel !== "" && launchModel !== "auto";
	// The model the launch named. A restored launch that continues on a fallback named the model it was first launched
	// on: only that one runs as named, and it follows the model continued on, which must pass every gate.
	const namedModel = namesModel ? (options.requestedModel ?? launchModel) : undefined;
	const baseOf = (model: string) =>
		splitKnownThinkingSuffix(
			resolveModelCandidate(model, options.availableModels, options.preferredModelProvider) ?? model,
		).baseModel;
	const namedBase = namedModel === undefined ? undefined : baseOf(namedModel);
	const continuesOnOther = namedBase !== undefined && baseOf(launchModel) !== namedBase;
	const fallbackLevels = agent.fallbackThinkingLevels;
	const rawCandidates = buildModelCandidates(
		options.modelOverride ?? agentModel,
		[...(continuesOnOther && namedModel !== undefined ? [namedModel] : []), ...(agent.fallbackModels ?? [])],
		options.availableModels,
		options.preferredModelProvider,
		namesModel ? undefined : options.currentModel,
		continuesOnOther && fallbackLevels ? ["", ...fallbackLevels] : fallbackLevels,
	);
	let filteredCandidates = filterSpawnableModelCandidates({
		candidates: rawCandidates,
		availableModels: options.availableModels,
		knownModelProviders: options.knownModelProviders,
		currentModel: options.currentModel,
	});
	const resolveCandidate = options.resolveCandidateModel;
	if (namesModel && resolveCandidate) {
		// A named launch never starts on a model it cannot resolve: its child would run its parent's model instead.
		const named = continuesOnOther ? undefined : rawCandidates[0];
		const namedWord = named ? splitUnknownThinkingSuffix(named) : undefined;
		if (named && namedWord && !resolveCandidate(named))
			return refuse(unknownModelMessage(named, namedWord.effort, namedWord.baseModel));
		const unavailable = filteredCandidates.candidates.filter((entry) => resolveCandidate(entry) === undefined);
		filteredCandidates = {
			candidates: filteredCandidates.candidates.filter((entry) => !unavailable.includes(entry)),
			skippedAttempts: [
				...filteredCandidates.skippedAttempts,
				...unavailable.map((entry) =>
					skippedModelAttempt(entry, `Skipped ${entry}: no available model matches it.`),
				),
			],
			skippedModels: filteredCandidates.skippedModels,
		};
		if (filteredCandidates.candidates.length === 0)
			return refuse(
				namedModelUnavailableMessage(namedModel ?? launchModel, filteredCandidates.skippedAttempts),
				filteredCandidates.skippedAttempts,
			);
	}
	if (rawCandidates.length > 0 && filteredCandidates.candidates.length === 0)
		return refuse(noSpawnableCandidatesMessage(filteredCandidates.skippedModels), filteredCandidates.skippedAttempts);
	const listedCandidate = filteredCandidates.candidates[0];
	const fallbackCandidates = filteredCandidates.candidates.slice(1);
	// Upstream pi #7897: a subagent that pins no model of its own inherits the
	// dispatching session's model AND thinking level. Atomic resolves the
	// parent's model as the trailing candidate, so the parent's thinking level
	// applies only when nothing the agent configured can outrank it: no
	// frontmatter `model`, no `fallbackModels` (an agent whose fallback chain
	// selects its own first candidate runs on that model, not the parent's),
	// and no per-call override. An agent's own `thinking` still wins over the
	// inherited level, and a candidate `:level` suffix wins over both.
	const inheritsDispatchConfig =
		agentModel === undefined &&
		(agent.fallbackModels === undefined || agent.fallbackModels.length === 0) &&
		options.modelOverride === undefined;
	// The candidate is only a string. `createAgentSession` selects a model from a
	// `Model<Api>` object and otherwise restores the model persisted in the
	// session file — which, for a fork-context child, is the parent's model.
	// Resolving the candidate here is what makes the agent's configured model win.
	const resolvedCandidate = listedCandidate ? options.resolveCandidateModel?.(listedCandidate) : undefined;
	// `provider/model:word` with a word that names no level runs that model at its default level, as at an effort it
	// lacks, and is reported without the word; when its model does not resolve either, it never runs another model.
	const unknownEffort = listedCandidate ? splitUnknownThinkingSuffix(listedCandidate) : undefined;
	if (listedCandidate && unknownEffort && options.resolveCandidateModel && !resolvedCandidate)
		return refuse(unknownModelMessage(listedCandidate, unknownEffort.effort, unknownEffort.baseModel));
	const candidate =
		resolvedCandidate?.unknownEffort !== undefined && unknownEffort ? unknownEffort.baseModel : listedCandidate;
	// The effort a `provider/model:effort` launch asked for explicitly, a level or a word that names none.
	const requestedModel = launchRequestedModel(agent, options);
	const requestedSuffix = splitKnownThinkingSuffix(launchModel).thinkingSuffix.slice(1);
	const requestedThinking =
		THINKING_LEVELS.find((level) => level === requestedSuffix) ??
		(launchModel ? options.resolveCandidateModel?.(launchModel)?.unknownEffort : undefined);
	const outputSnapshot = options.outputPath ? await captureSingleOutputSnapshot(options.outputPath) : undefined;

	const parent: ParentContext = {
		path: options.runId,
		depth: options.parentDepth ?? 0,
		getChildSessionOptions: options.getChildSessionOptions,
		resourceLoaderInheritanceSnapshot: options.resourceLoaderInheritanceSnapshot,
		...(options.intercomGroup ? { intercomGroup: options.intercomGroup } : {}),
	};
	const sessionRoot = options.sessionDir ?? join(options.artifactsDir ?? cwd, ".atomic", "subagents");
	const control = getOrCreateSubagentControl(
		parent,
		sessionRoot,
		resolveTopLevelParallelRunningCapacity(options.runningCapacity),
	);
	control.registerAgents([agent]);
	const artifactsDir =
		options.artifactsDir && options.artifactConfig?.enabled !== false ? options.artifactsDir : undefined;
	const artifactPaths = artifactsDir
		? getArtifactPaths(artifactsDir, options.runId, agent.name, options.index)
		: undefined;
	const artifactsDisabled =
		options.artifactConfig?.enabled === false ||
		(options.artifactsDir === undefined && options.artifactConfig === undefined);
	if (artifactsDir && artifactPaths && options.artifactConfig?.includeInput !== false) {
		await ensureArtifactsDir(artifactsDir);
		await writeArtifact(artifactPaths.inputPath, `# Task for ${agent.name}\n\n${task}`);
	}
	const testSession = options.testSession ?? defaultTestSession();
	// Where the child is in its start, across its attempts, until its first turn starts: never merely "running".
	const launchedAt = elapsedSpan.dispatchedAt;
	let startAttempt = 1;
	let stalledStart: SubagentStartProgress["stalled"];
	const reportStart = (progress: SessionStartProgress | undefined, awaitingRelease = false) =>
		options.taskExecution?.reportStart?.(
			progress === undefined
				? undefined
				: {
						...progress,
						attempt: startAttempt,
						launchedAt,
						...(stalledStart === undefined ? {} : { stalled: stalledStart }),
						...(awaitingRelease ? { awaitingRelease: true } : {}),
					},
		);
	const spec: ChildSpec = {
		elapsedSpan,
		onElapsedSpanChanged: options.onElapsedSpanChanged,
		taskName: agent.name,
		childId: `${options.runId}:${options.index ?? 0}`,
		task,
		agent,
		cwd,
		testSession: testSession,
		sessionManager: options.sessionManager,
		...(options.sessionStore && !options.sessionManager ? { sessionStore: options.sessionStore } : {}),
		parentCwd: runtimeCwd,
		...(options.resumeSession ? { resumeSession: true } : {}),
		...(options.resumeFollowUps?.length ? { resumeFollowUps: options.resumeFollowUps } : {}),
		...(options.resumeTaskLiteral ? { resumeTaskLiteral: true } : {}),
		...(options.releaseWhenWaiting ? { releaseWhenWaiting: options.releaseWhenWaiting } : {}),
		...(options.onBeforeRelease ? { onBeforeRelease: options.onBeforeRelease } : {}),
		...(options.resumeToolResults?.length ? { resumeToolResults: options.resumeToolResults } : {}),
		...(options.skipTaskPrompt ? { skipTaskPrompt: true } : {}),
		...(options.resumeTaskFallback ? { resumeTaskFallback: true } : {}),
		...(options.resumePaused ? { resumePaused: true } : {}),
		...(options.redispatchDetachedCalls ? { redispatchDetachedCalls: true } : {}),
		...(options.onChildSession ? { onChildSession: options.onChildSession } : {}),
		...(options.onChildLaunch ? { onChildLaunch: options.onChildLaunch } : {}),
		...(options.progressPath ? { progressPath: options.progressPath } : {}),
		...(options.progressArtifactPath
			? { progressArtifactPath: options.progressArtifactPath }
			: options.progressPath && artifactsDir
				? { progressArtifactPath: options.progressPath }
				: {}),
		...(artifactPaths?.outputPath ? { outputArtifactPath: artifactPaths.outputPath } : {}),
		sessionStartTimeoutMs,
		onStartProgress: (progress) => reportStart(progress),
		...(requestedThinking === undefined ? {} : { requestedThinking }),
		...(options.resolveCandidateModel ? { resolveCandidateModel: options.resolveCandidateModel } : {}),
		tools: agent.tools,
		mcpDirectTools: agent.mcpDirectTools,
		skills: options.skills ?? agent.skills,
		model: resolvedCandidate?.model,
		thinkingLevel: (resolvedCandidate?.thinkingLevel ??
			agent.thinking ??
			(inheritsDispatchConfig ? options.currentThinkingLevel : undefined)) as ChildSpec["thinkingLevel"],
		parent,
		intercom: options.orchestratorIntercomTarget
			? {
					orchestratorTarget: options.orchestratorIntercomTarget,
					runId: options.runId,
					agent: agent.name,
					index: options.index ?? 0,
					...(options.intercomSessionName ? { sessionName: options.intercomSessionName } : {}),
					...(options.supervisorAuthorization
						? {
								supervisor: {
									capability: options.supervisorAuthorization.capability,
									supervisorSessionId: options.supervisorAuthorization.supervisorSessionId,
								},
							}
						: {}),
				}
			: undefined,
		artifactJsonlPath: options.artifactConfig?.includeJsonl === true ? artifactPaths?.jsonlPath : undefined,
		// A named model's own chain, even an empty one, replaces any chain the child session would otherwise take up.
		...(fallbackCandidates.length || namesModel ? { fallbackModels: fallbackCandidates } : {}),
		...(namedModel === undefined ? {} : { namedModel }),
		...(requestedModel ? { requestedModel } : {}),
		onProgress: options.onUpdate
			? (progress) => {
					const liveProgress = {
						...progress,
						elapsedSpan: { ...elapsedSpan },
						taskId: options.taskExecution?.taskId,
						index: options.index ?? 0,
					};
					const liveModel = liveProgress.model ?? candidate;
					const liveThinking = liveProgress.thinking;
					const liveResult: SingleResult = {
						agent: agent.name,
						task,
						status: "continued",
						messages: [],
						usage: emptyUsage(),
						...(liveModel === undefined ? {} : { model: liveModel }),
						...(liveThinking === undefined ? {} : { thinking: liveThinking }),
						progress: liveProgress,
					};
					options.onUpdate?.({
						content: [{ type: "text", text: "running" }],
						details: {
							mode: "single",
							runId: options.runId,
							results: [liveResult],
							progress: [liveProgress],
						} satisfies Details,
					});
				}
			: undefined,
	};
	if (turn.ahead) await turn.ahead;
	const admission = control.admitCheckedChildSession(spec, cwdVerdict, parent);
	turn.release();
	if (!admission.admitted) return refuse(admission.refusal?.reason ?? "child admission refused");
	const neverAbort = new AbortController().signal;
	const attemptCandidate = { model: resolvedCandidate?.model, modelId: candidate, thinkingLevel: spec.thinkingLevel };
	const attemptSignals = {
		abort: options.taskExecution?.signal ?? options.signal ?? neverAbort,
		interrupt: options.interruptSignal ?? neverAbort,
	};
	// The task's execution is the child's start and run, a retried start included: its cleanup is the last attempt's.
	let attemptCleanup: Promise<Cleanup> | undefined;
	const attemptHooks: TaskExecutionHooks | undefined =
		options.taskExecution === undefined
			? undefined
			: {
					...options.taskExecution,
					onExecution: (execution) => {
						attemptCleanup = execution.cleanup;
					},
				};
	let running = control.startAttempt(admission.admitted, attemptCandidate, attemptSignals, attemptHooks);
	// A start that runs out of its budget is retried once, as soon as it has let go of its session; a retry that runs
	// out of its budget too fails, naming the step each attempt stalled in.
	const settled = (async (): Promise<AttemptOutcome> => {
		const first = await running.promise;
		const stall = startStall(first);
		if (stall === undefined || first.status !== "error" || startAttempt >= SUBAGENT_START_ATTEMPTS) return first;
		stalledStart = { step: stall.step, afterMs: stall.elapsedMs };
		startAttempt += 1;
		reportStart({ step: stall.step, startedAt: Date.now(), stepStartedAt: Date.now() }, true);
		const releasedInTime = await settledWithin(
			first.startReleased ?? Promise.resolve(),
			Math.min((sessionStartTimeoutMs ?? SUBAGENT_START_RELEASE_WAIT_MS) / 2, SUBAGENT_START_RELEASE_WAIT_MS),
		);
		const stopped = attemptSignals.abort.aborted || attemptSignals.interrupt.aborted;
		// A launch's retry starts in a fresh session: what the stalled start received as context for its first turn
		// goes with it. A retry that reopens the child's own session finds it there already.
		const carried = releasedInTime && spec.sessionManager === undefined ? await (first.startContext ?? []) : [];
		// Sends to the child wait for the retry, now that the stalled start registered and took the earlier ones.
		if (releasedInTime && !stopped) await options.onStartRetry?.();
		const again =
			releasedInTime && !stopped
				? await control.admitChildSession(
						carried.length === 0 ? spec : { ...spec, startContext: [...(spec.startContext ?? []), ...carried] },
						parent,
					)
				: undefined;
		if (again?.admitted === undefined) {
			reportStart(undefined);
			if (stopped) return first;
			const cause = `${first.cause} It was not retried: ${releasedInTime ? (again?.refusal?.reason ?? "its retry was refused") : "the stalled start did not let go of its session in time"}.`;
			return { ...first, cause, envelope: cause };
		}
		control.supersedeStalledStart(first.path);
		running = control.startAttempt(again.admitted, attemptCandidate, attemptSignals, attemptHooks);
		const second = await running.promise;
		const retryStall = startStall(second);
		if (retryStall === undefined || second.status !== "error") return second;
		const cause =
			`Subagent did not start: its start stalled ${sessionStartStepText(stall.step)} after ${Math.round(stall.elapsedMs / 1000)}s and was retried once; the retry stalled ${sessionStartStepText(retryStall.step)} after ${Math.round(retryStall.elapsedMs / 1000)}s. ${retryStall.hint ?? ""}`.trim();
		return { ...second, cause, envelope: cause };
	})().finally(() => finishElapsedSpan(elapsedSpan, options.taskExecution));
	if (options.onUpdate) {
		const launchModel = running.currentModel ?? candidate;
		spec.onProgress?.({
			index: options.index ?? 0,
			agent: agent.name,
			status: "running",
			task,
			...(launchModel === undefined ? {} : { model: launchModel }),
			...(running.currentThinking === undefined ? {} : { thinking: running.currentThinking }),
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			durationMs: spanElapsedMs(elapsedSpan),
			lastActivityAt: Date.now(),
		});
	}
	let detached = false;
	let resolveContinuation!: () => void;
	const continuation = new Promise<void>((resolve) => {
		resolveContinuation = resolve;
	});
	const detachCleanup = registerExecutionIntercomDetach(options, {
		isUnavailable: () => running.status !== "running",
		isDetached: () => detached,
		detach: () => {
			if (detached) return;
			detached = true;
			control.continueDetached(running, "intercom-coordination");
			resolveContinuation();
		},
	});
	const parentAskCleanup = registerExecutionParentAskHandoff(options, {
		agent: agent.name,
		isUnavailable: () => running.status !== "running" || detached,
	});
	const lastCleanup = (): Promise<Cleanup> => attemptCleanup ?? Promise.resolve({ kind: "reaped" });
	options.taskExecution?.onExecution({
		result: settled,
		cleanup: settled.then(lastCleanup, lastCleanup),
	});
	const terminal = settled.then((value) => ({ kind: "terminal" as const, value }));
	const winner = await Promise.race([terminal, continuation.then(() => ({ kind: "continued" as const }))]);
	if (winner.kind === "continued") {
		detachCleanup();
		parentAskCleanup();
		void settled
			.then(
				async (continuedOutcome) => {
					const recovered = resultFromOutcome(
						agent,
						task,
						continuedOutcome,
						spanElapsedMs(elapsedSpan),
						artifactPaths,
						options.index ?? 0,
						{ cwd, parentCwd: runtimeCwd },
						requestedModel,
					);
					try {
						const deliveredOutput = await control.deliverChildResult(
							{
								path: continuedOutcome.path,
								status: continuedOutcome.status,
								...(continuedOutcome.status === "error" ||
								(continuedOutcome.status === "interrupted" && continuedOutcome.cause)
									? { cause: continuedOutcome.cause }
									: {}),
								stats: continuedOutcome.stats,
								envelope: continuedOutcome.envelope,
								durationMs: recovered.progressSummary?.durationMs,
								...(recovered.model === undefined ? {} : { model: recovered.model }),
								...(recovered.thinking === undefined ? {} : { thinking: recovered.thinking }),
								...(requestedModel ? { requestedModel } : {}),
								sessionFile: continuedOutcome.sessionFile,
								...(recovered.sessionUrl ? { sessionUrl: recovered.sessionUrl } : {}),
								timestamp: Date.now(),
								artifactsDir: options.artifactsDir,
							},
							{
								artifactsDir: options.artifactsDir,
								artifactPaths,
								artifactsDisabled,
								maxOutput: options.maxOutput,
							},
						);
						if (deliveredOutput !== undefined) {
							recovered.envelope = deliveredOutput;
							recovered.finalOutput = deliveredOutput;
						}
						await persistRequestedOutput(recovered, options, outputSnapshot);
					} finally {
						// Failed output delivery cannot leave a finished child registered as live.
						forgetIfReleased(control, continuedOutcome);
						await options.onDetachedExit?.(recovered);
					}
				},
				async (error: unknown) => {
					await options.onDetachedExit?.(
						refusedResult(agent.name, task, String(error), { ...options, elapsedSpan }),
					);
					throw error;
				},
			)
			.catch((error: unknown) => {
				// #3981: nothing awaits a detached child's exit, and a run's async scope fails on any unhandled rejection.
				console.error("atomic-subagents: detached child exit handling failed", error);
			});
		const continuedModel = running.currentModel ?? candidate;
		const continuedThinking = running.currentThinking;
		const continuedResult: SingleResult = {
			agent: agent.name,
			task,
			status: "continued",
			path: admission.admitted.identity.path,
			envelope: "Child detached for intercom coordination.",
			detached: true,
			detachedReason: "intercom-coordination",
			messages: [],
			usage: emptyUsage(),
			...(continuedModel === undefined ? {} : { model: continuedModel }),
			...(continuedThinking === undefined ? {} : { thinking: continuedThinking }),
			...(requestedModel ? { requestedModel } : {}),
			progress: {
				index: options.index ?? 0,
				agent: agent.name,
				status: "running",
				task,
				...(continuedModel === undefined ? {} : { model: continuedModel }),
				...(continuedThinking === undefined ? {} : { thinking: continuedThinking }),
				recentTools: [],
				recentOutput: [],
				toolCount: 0,
				tokens: 0,
				durationMs: spanElapsedMs(elapsedSpan),
				lastActivityAt: Date.now(),
			},
		};
		options.onUpdate?.({
			content: [{ type: "text", text: continuedResult.envelope ?? "" }],
			details: { mode: "single", runId: options.runId, results: [continuedResult] } satisfies Details,
		});
		return continuedResult;
	}
	detachCleanup();
	parentAskCleanup();
	const outcome = winner.value;
	const result = resultFromOutcome(
		agent,
		task,
		outcome,
		spanElapsedMs(elapsedSpan),
		artifactPaths,
		options.index ?? 0,
		{ cwd, parentCwd: runtimeCwd },
		requestedModel,
	);
	if (filteredCandidates.skippedAttempts.length)
		result.modelAttempts = [...filteredCandidates.skippedAttempts, ...(result.modelAttempts ?? [])];
	const deliveredOutput = await control.deliverChildResult(
		{
			path: outcome.path,
			status: outcome.status,
			...(outcome.status === "error" || (outcome.status === "interrupted" && outcome.cause)
				? { cause: outcome.cause }
				: {}),
			stats: outcome.stats,
			envelope: outcome.envelope,
			durationMs: result.progressSummary?.durationMs,
			...(result.model === undefined ? {} : { model: result.model }),
			...(result.thinking === undefined ? {} : { thinking: result.thinking }),
			...(requestedModel ? { requestedModel } : {}),
			sessionFile: outcome.sessionFile,
			...(result.sessionUrl ? { sessionUrl: result.sessionUrl } : {}),
			timestamp: Date.now(),
			artifactsDir: options.artifactsDir,
		},
		{ artifactsDir: options.artifactsDir, artifactPaths, artifactsDisabled, maxOutput: options.maxOutput },
	);
	if (deliveredOutput !== undefined) {
		result.envelope = deliveredOutput;
		result.finalOutput = deliveredOutput;
	}
	forgetIfReleased(control, outcome);
	result.outputMode = options.outputMode ?? "inline";
	if (options.outputPath && result.status === "ok") {
		await persistRequestedOutput(result, options, outputSnapshot);
	}
	const update: SubagentToolResult = {
		content: [{ type: "text", text: result.finalOutput ?? "(no output)" }],
		details: {
			mode: "single",
			runId: options.runId,
			results: [result],
			progress: result.progress ? [result.progress] : undefined,
		} satisfies Details,
	};
	options.onUpdate?.(update);
	return result;
}

/**
 * The longest a retry waits for a stalled start to let go of its session (half its start budget, at most this). A start
 * still holding its session then, as one whose extension never returns, is not retried: two starts never share one
 * session.
 */
const SUBAGENT_START_RELEASE_WAIT_MS = 30_000;

/** The start-budget timeout an attempt failed with, if it did not start in time. */
function startStall(outcome: AttemptOutcome): SessionStartTimeoutError | undefined {
	return outcome.status === "error" &&
		outcome.startError !== undefined &&
		isSessionStartTimeoutError(outcome.startError)
		? outcome.startError
		: undefined;
}

/** Whether `promise` settled within `timeoutMs`. */
function settledWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		timer.unref?.();
		void promise.then(
			() => {
				clearTimeout(timer);
				resolve(true);
			},
			() => {
				clearTimeout(timer);
				resolve(true);
			},
		);
	});
}

function forgetIfReleased(control: SubagentControlRuntime, outcome: AttemptOutcome): void {
	if (outcome.status !== "interrupted" || outcome.released === undefined) return;
	control.forgetReleasedChild(outcome.path);
	if (control.holdsNothing()) unregisterSubagentControl(control);
}

async function persistRequestedOutput(
	result: SingleResult,
	options: RunSyncOptions,
	outputSnapshot: SingleOutputSnapshot | undefined,
): Promise<void> {
	result.outputMode = options.outputMode ?? "inline";
	if (!options.outputPath || result.status !== "ok") return;
	const resolved = await resolveSingleOutput(options.outputPath, result.finalOutput ?? "", outputSnapshot);
	result.savedOutputPath = resolved.savedPath;
	result.outputSaveError = resolved.saveError;
	if (!resolved.savedPath) return;
	result.outputReference = formatSavedOutputReference(resolved.savedPath, resolved.fullOutput);
	result.finalOutput = result.outputMode === "file-only" ? result.outputReference.message : resolved.fullOutput;
}

export async function runSync(
	runtimeCwd: string,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const agent = agents.find((candidate) => candidate.name === agentName);
	if (!agent) return refusedResult(agentName, task, `Unknown agent: ${agentName}`, options);
	return runSingleInProcess(runtimeCwd, agent, task, options);
}

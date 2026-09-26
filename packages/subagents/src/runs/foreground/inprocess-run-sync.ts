import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "../../agents/agent-types.js";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact } from "../../shared/artifacts.js";
import { splitKnownThinkingSuffix } from "../../shared/model-info.js";
import type {
	AgentProgress,
	ArtifactPaths,
	Details,
	ModelAttempt,
	RunSyncOptions,
	SingleResult,
	SubagentToolResult,
	Usage,
} from "../../shared/types.js";
import { getOrCreateSubagentControl } from "../inprocess/control-registry.js";
import type { AttemptOutcome, ChildSpec, ParentContext } from "../inprocess/runner.js";
import { isParentCancellation } from "../shared/cancellation-recovery.js";
import { filterSpawnableModelCandidates } from "../shared/model-candidate-filter.js";
import { buildModelCandidates } from "../shared/model-fallback.js";
import {
	captureSingleOutputSnapshot,
	formatSavedOutputReference,
	resolveSingleOutput,
	type SingleOutputSnapshot,
} from "../shared/single-output.js";
import { registerExecutionIntercomDetach } from "./execution-intercom-detach.js";
import { registerExecutionParentAskHandoff } from "./execution-parent-ask-handoff.js";

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

function workflowOrchestrationContext(options: RunSyncOptions): ParentContext["orchestrationContext"] | undefined {
	const workflow = options.workflowSessionMetadata;
	if (!workflow) return undefined;
	return {
		kind: "workflow-stage",
		workflowRunId: workflow.runId,
		workflowStageId: workflow.stageId,
		workflowStageName: workflow.stageName,
		constraints: {
			disableWorkflowTool: true,
		},
		...(options.intercomGroup ? { intercomGroup: options.intercomGroup } : {}),
	};
}
function progressFor(agent: AgentConfig, task: string, outcome: AttemptOutcome, startedAt: number): AgentProgress {
	const status =
		outcome.status === "ok"
			? "completed"
			: outcome.status === "killed"
				? "killed"
				: outcome.status === "interrupted" && isParentCancellation(outcome.cause)
					? "interrupted"
					: "failed";
	return {
		index: 0,
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
		durationMs: Math.max(0, Date.now() - startedAt),
		lastActivityAt: Date.now(),
		...(outcome.status === "error" ? { error: outcome.cause } : {}),
		...(outcome.status === "interrupted" && isParentCancellation(outcome.cause) ? { cause: outcome.cause } : {}),
	};
}

function resultFromOutcome(
	agent: AgentConfig,
	task: string,
	outcome: AttemptOutcome,
	startedAt: number,
	artifactPaths: ArtifactPaths | undefined,
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
			? { cause: outcome.cause, error: outcome.cause }
			: outcome.status === "interrupted" && isParentCancellation(outcome.cause)
				? { cause: outcome.cause }
				: {}),
		stats: outcome.stats,
		path: outcome.path,
		envelope: outcome.status === "killed" ? output : outcome.envelope,
		interrupted: status === "interrupted" ? true : undefined,
		messages: [],
		usage: usageFromStats(outcome.stats),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...("attemptedModels" in outcome && outcome.attemptedModels?.length
			? { attemptedModels: [...outcome.attemptedModels] }
			: {}),
		...(outcome.skills?.length ? { skills: [...outcome.skills] } : {}),
		...(outcome.skillsWarning ? { skillsWarning: outcome.skillsWarning } : {}),
		finalOutput: output,
		sessionFile: outcome.sessionFile,
		progress: progressFor(agent, task, outcome, startedAt),
		progressSummary: {
			toolCount: outcome.stats.toolCalls,
			tokens: outcome.stats.tokens.total,
			durationMs: Math.max(0, Date.now() - startedAt),
		},
		...(artifactPaths ? { artifactPaths } : {}),
	};
	return result;
}

function refusedResult(agent: AgentConfig, task: string, reason: string): SingleResult {
	return {
		agent: agent.name,
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

function noSpawnableCandidatesResult(agent: AgentConfig, task: string, skippedAttempts: ModelAttempt[]): SingleResult {
	const reason = "No spawnable subagent model candidates after pre-spawn filtering.";
	return { ...refusedResult(agent, task, reason), modelAttempts: skippedAttempts };
}

export async function runSingleInProcess(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const cwd = options.cwd ?? runtimeCwd;
	if (!existsSync(cwd)) return refusedResult(agent, task, `cwd does not exist: ${cwd}`);
	if (!statSync(cwd).isDirectory()) return refusedResult(agent, task, `cwd is not a directory: ${cwd}`);
	options.modelRoute?.assertCurrent();
	const seenModels = new Set<string>();
	const rawCandidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		[...(options.modelRoute?.fallbackModels ?? []), ...(agent.fallbackModels ?? [])],
		options.availableModels,
		options.preferredModelProvider,
		options.modelRoute && options.currentModel && options.currentThinkingLevel
			? `${options.currentModel}:${options.currentThinkingLevel}`
			: options.currentModel,
		options.modelRoute?.fallbackModels?.length
			? [...options.modelRoute.fallbackModels.map(() => "off"), ...(agent.fallbackThinkingLevels ?? [])]
			: agent.fallbackThinkingLevels,
	).filter((candidate) => {
		if (!options.modelRoute) return true;
		if (!options.modelRoute.allowsCandidate(candidate, options.modelRoute.routerSelection.effort ?? "off"))
			return false;
		const { baseModel } = splitKnownThinkingSuffix(candidate);
		if (seenModels.has(baseModel)) return false;
		seenModels.add(baseModel);
		return true;
	});
	const filteredCandidates = filterSpawnableModelCandidates({
		candidates: rawCandidates,
		availableModels: options.availableModels,
		knownModelProviders: options.knownModelProviders,
		currentModel: options.currentModel,
	});
	if (rawCandidates.length > 0 && filteredCandidates.candidates.length === 0)
		return noSpawnableCandidatesResult(agent, task, filteredCandidates.skippedAttempts);
	const candidate = filteredCandidates.candidates[0];
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
		agent.model === undefined &&
		(agent.fallbackModels === undefined || agent.fallbackModels.length === 0) &&
		options.modelOverride === undefined;
	// The candidate is only a string. `createAgentSession` selects a model from a
	// `Model<Api>` object and otherwise restores the model persisted in the
	// session file — which, for a fork-context child, is the parent's model.
	// Resolving the candidate here is what makes the agent's configured model win.
	const resolvedCandidate = candidate ? options.resolveCandidateModel?.(candidate) : undefined;
	if (options.modelRoute && !resolvedCandidate)
		throw new Error(
			"Subagent auto-selected model could not be resolved before execution. Retry explicitly with the current catalog.",
		);
	const orchestrationContext = workflowOrchestrationContext(options);
	const outputSnapshot = captureSingleOutputSnapshot(options.outputPath);

	const parent: ParentContext = {
		path: options.runId,
		depth: options.parentDepth ?? 0,
		getChildSessionOptions: options.getChildSessionOptions,
		resourceLoaderInheritanceSnapshot: options.resourceLoaderInheritanceSnapshot,
		...(options.intercomGroup ? { intercomGroup: options.intercomGroup } : {}),
		...(options.workflowStageSubagentGuard === undefined
			? {}
			: { workflowStageSubagentGuard: options.workflowStageSubagentGuard }),
		...(orchestrationContext ? { orchestrationContext } : {}),
	};
	const sessionRoot = options.sessionDir ?? join(options.artifactsDir ?? cwd, ".atomic", "subagents");
	const control = getOrCreateSubagentControl(parent, sessionRoot);
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
		ensureArtifactsDir(artifactsDir);
		writeArtifact(artifactPaths.inputPath, `# Task for ${agent.name}\n\n${task}`);
	}
	const testSession = options.testSession ?? defaultTestSession();
	const spec: ChildSpec = {
		taskName: agent.name,
		task,
		agent,
		cwd,
		testSession: testSession,
		sessionFile: options.sessionFile,
		...(options.progressPath ? { progressPath: options.progressPath } : {}),
		...(options.progressArtifactPath
			? { progressArtifactPath: options.progressArtifactPath }
			: options.progressPath && artifactsDir
				? { progressArtifactPath: options.progressPath }
				: {}),
		...(artifactPaths?.outputPath ? { outputArtifactPath: artifactPaths.outputPath } : {}),
		tools: agent.tools,
		mcpDirectTools: agent.mcpDirectTools,
		skills: options.skills ?? agent.skills,
		model: resolvedCandidate?.model,
		thinkingLevel: (options.modelRoute && resolvedCandidate?.model.reasoning === false
			? "off"
			: (resolvedCandidate?.thinkingLevel ??
				agent.thinking ??
				(inheritsDispatchConfig ? options.currentThinkingLevel : undefined))) as ChildSpec["thinkingLevel"],
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
		...(fallbackCandidates.length || options.modelRoute ? { fallbackModels: fallbackCandidates } : {}),
		...(options.modelRoute ? { isFallbackModelAllowed: options.modelRoute.allowsModel } : {}),
		onProgress: options.onUpdate
			? (progress) => {
					const liveProgress = { ...progress, index: options.index ?? 0 };
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
	const admission = control.admitChildSession(spec, parent);
	if (!admission.admitted) return refusedResult(agent, task, admission.refusal?.reason ?? "child admission refused");
	const startedAt = Date.now();
	const neverAbort = new AbortController().signal;
	const running = control.startAttempt(
		admission.admitted,
		{ model: resolvedCandidate?.model, modelId: candidate, thinkingLevel: spec.thinkingLevel },
		{
			abort: options.taskExecution?.signal ?? options.signal ?? neverAbort,
			interrupt: options.interruptSignal ?? neverAbort,
		},
		options.taskExecution,
	);
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
			durationMs: Math.max(0, Date.now() - startedAt),
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
	const terminal = running.promise.then((value) => ({ kind: "terminal" as const, value }));
	const winner = await Promise.race([terminal, continuation.then(() => ({ kind: "continued" as const }))]);
	if (winner.kind === "continued") {
		detachCleanup();
		parentAskCleanup();
		void running.promise.then(async (continuedOutcome) => {
			const recovered = resultFromOutcome(agent, task, continuedOutcome, startedAt, artifactPaths);
			await control.deliverChildResult(
				{
					path: continuedOutcome.path,
					status: continuedOutcome.status,
					...(continuedOutcome.status === "error" ||
					(continuedOutcome.status === "interrupted" && continuedOutcome.cause)
						? { cause: continuedOutcome.cause }
						: {}),
					stats: continuedOutcome.stats,
					envelope: continuedOutcome.envelope,
					...(recovered.model === undefined ? {} : { model: recovered.model }),
					...(recovered.thinking === undefined ? {} : { thinking: recovered.thinking }),
					sessionFile: continuedOutcome.sessionFile,
					timestamp: Date.now(),
					artifactsDir: options.artifactsDir,
				},
				{ artifactsDir: options.artifactsDir, artifactPaths, artifactsDisabled, maxOutput: options.maxOutput },
			);
			const delivered = control.getDeliveredResult(continuedOutcome.path);
			if (delivered) {
				recovered.envelope = delivered.envelope;
				recovered.finalOutput = delivered.envelope;
			}
			options.onDetachedExit?.(recovered);
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
				durationMs: Math.max(0, Date.now() - startedAt),
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
	const result = resultFromOutcome(agent, task, outcome, startedAt, artifactPaths);
	if (options.modelRoute) result.routerSelection = options.modelRoute.routerSelection;
	if (filteredCandidates.skippedAttempts.length)
		result.modelAttempts = [...filteredCandidates.skippedAttempts, ...(result.modelAttempts ?? [])];
	await control.deliverChildResult(
		{
			path: outcome.path,
			status: outcome.status,
			...(outcome.status === "error" || (outcome.status === "interrupted" && outcome.cause)
				? { cause: outcome.cause }
				: {}),
			stats: outcome.stats,
			envelope: outcome.envelope,
			...(result.model === undefined ? {} : { model: result.model }),
			...(result.thinking === undefined ? {} : { thinking: result.thinking }),
			sessionFile: outcome.sessionFile,
			timestamp: Date.now(),
			artifactsDir: options.artifactsDir,
		},
		{ artifactsDir: options.artifactsDir, artifactPaths, artifactsDisabled, maxOutput: options.maxOutput },
	);
	const delivered = control.getDeliveredResult(outcome.path);
	if (delivered) {
		result.envelope = delivered.envelope;
		result.finalOutput = delivered.envelope;
	}
	persistRequestedOutput(result, options, outputSnapshot);
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

function persistRequestedOutput(
	result: SingleResult,
	options: RunSyncOptions,
	outputSnapshot: SingleOutputSnapshot | undefined,
): void {
	result.outputMode = options.outputMode ?? "inline";
	if (!options.outputPath || result.status !== "ok") return;
	const resolved = resolveSingleOutput(options.outputPath, result.finalOutput ?? "", outputSnapshot);
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
	if (!agent)
		return refusedResult(
			{
				name: agentName,
				description: "",
				systemPrompt: "",
				systemPromptMode: "replace",
				inheritProjectContext: false,
				inheritSkills: false,
				source: "user",
				filePath: "",
			},
			task,
			`Unknown agent: ${agentName}`,
		);
	const route = options.modelRoute;
	if (!route) return runSingleInProcess(runtimeCwd, agent, task, options);
	const selection = route.routerSelection;
	const result = await runSingleInProcess(runtimeCwd, agent, task, {
		...options,
		onUpdate: options.onUpdate
			? (update) => {
					for (const result of update.details?.results ?? []) result.routerSelection = selection;
					options.onUpdate!(update);
				}
			: undefined,
	});
	return { ...result, routerSelection: selection };
}

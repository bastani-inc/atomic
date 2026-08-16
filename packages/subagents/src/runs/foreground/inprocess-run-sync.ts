import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CodexFastModeResolvedSettings, CodexFastModeScope } from "@bastani/atomic";
import type { AgentConfig } from "../../agents/agent-types.ts";
import { ensureArtifactsDir, getArtifactPaths, writeArtifact } from "../../shared/artifacts.ts";
import {
	getSubagentCodexFastModeSettings,
	resolveSubagentCodexFastModeScope,
	resolveSubagentModelFastMode,
} from "../../shared/fast-mode.ts";
import type {
	AgentProgress,
	ArtifactPaths,
	Details,
	ModelAttempt,
	RunSyncOptions,
	SingleResult,
	SubagentToolResult,
	Usage,
} from "../../shared/types.ts";
import { getOrCreateSubagentControl } from "../inprocess/control-registry.ts";
import type { AttemptOutcome, ChildSpec, ParentContext } from "../inprocess/runner.ts";
import { filterSpawnableModelCandidates } from "../shared/model-candidate-filter.ts";
import { buildModelCandidates } from "../shared/model-fallback.ts";
import { registerExecutionIntercomDetach } from "./execution-intercom-detach.ts";

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
			maxSubagentDepth: options.maxSubagentDepth ?? 5,
		},
		...(options.intercomGroup ? { intercomGroup: options.intercomGroup } : {}),
	};
}
function progressFor(
	agent: AgentConfig,
	task: string,
	outcome: AttemptOutcome,
	startedAt: number,
	fastMode: boolean,
): AgentProgress {
	const status = outcome.status === "ok" ? "completed" : outcome.status === "interrupted" ? "failed" : "failed";
	return {
		index: 0,
		agent: agent.name,
		status,
		task,
		...(outcome.model === undefined ? {} : { model: outcome.model }),
		...(outcome.thinking === undefined ? {} : { thinking: outcome.thinking }),
		...(fastMode ? { fastMode: true } : {}),
		recentTools: [],
		recentOutput: outcome.envelope ? outcome.envelope.split("\n").slice(-10) : [],
		toolCount: outcome.stats.toolCalls,
		turnCount: outcome.stats.assistantMessages,
		tokens: outcome.stats.tokens.total,
		durationMs: Math.max(0, Date.now() - startedAt),
		lastActivityAt: Date.now(),
		...(outcome.status === "error" ? { error: outcome.cause } : {}),
	};
}

function resultFromOutcome(
	agent: AgentConfig,
	task: string,
	outcome: AttemptOutcome,
	startedAt: number,
	artifactPaths: ArtifactPaths | undefined,
	fastMode: {
		cwd: string;
		settings: CodexFastModeResolvedSettings;
		scope: CodexFastModeScope;
	},
): SingleResult {
	const status = outcome.status;
	const output = outcome.status === "ok" ? outcome.output : outcome.envelope;
	const model = outcome.model;
	const thinking = outcome.thinking;
	const fastModeEnabled = resolveSubagentModelFastMode({
		model,
		cwd: fastMode.cwd,
		settings: fastMode.settings,
		scope: fastMode.scope,
	});
	const result: SingleResult = {
		agent: agent.name,
		task,
		status,
		...(outcome.status === "error" ? { cause: outcome.cause, error: outcome.cause } : {}),
		stats: outcome.stats,
		path: outcome.path,
		envelope: outcome.envelope,
		interrupted: status === "interrupted" ? true : undefined,
		messages: [],
		usage: usageFromStats(outcome.stats),
		...(model === undefined ? {} : { model }),
		...(thinking === undefined ? {} : { thinking }),
		...(fastModeEnabled ? { fastMode: true } : {}),
		...(outcome.status === "ok" || outcome.status === "error"
			? outcome.attemptedModels?.length
				? { attemptedModels: [...outcome.attemptedModels] }
				: {}
			: {}),
		...(outcome.skills?.length ? { skills: [...outcome.skills] } : {}),
		...(outcome.skillsWarning ? { skillsWarning: outcome.skillsWarning } : {}),
		finalOutput: output,
		sessionFile: outcome.sessionFile,
		progress: progressFor(agent, task, outcome, startedAt, fastModeEnabled),
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
	const rawCandidates = buildModelCandidates(
		options.modelOverride ?? agent.model,
		agent.fallbackModels,
		options.availableModels,
		options.preferredModelProvider,
		options.currentModel,
		agent.fallbackThinkingLevels,
	);
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
	const fastModeSettings = getSubagentCodexFastModeSettings(cwd);
	const orchestrationContext = workflowOrchestrationContext(options);
	const fastModeScope = resolveSubagentCodexFastModeScope(
		options.workflowStageSubagentGuard ?? orchestrationContext?.kind === "workflow-stage",
	);
	const fastModeForModel = (model: string | undefined): boolean =>
		resolveSubagentModelFastMode({
			model,
			cwd,
			settings: fastModeSettings,
			scope: fastModeScope,
		});
	const parent: ParentContext = {
		path: options.runId,
		depth: options.parentDepth ?? 0,
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
	const testSession =
		options.testSession ?? (process.env.NODE_TEST_CONTEXT !== undefined || process.env.NODE_ENV === "test");
	const spec: ChildSpec = {
		taskName: agent.name,
		task,
		agent,
		cwd,
		testSession: testSession,
		sessionFile: options.sessionFile,
		...(options.maxSubagentDepth === undefined ? {} : { maxSubagentDepth: options.maxSubagentDepth }),
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
		artifactJsonlPath: artifactPaths?.jsonlPath,
		...(fallbackCandidates.length ? { fallbackModels: fallbackCandidates } : {}),
		onProgress: options.onUpdate
			? (progress) => {
					const liveProgress = { ...progress, index: options.index ?? 0 };
					const liveModel = liveProgress.model ?? candidate;
					const liveThinking = liveProgress.thinking;
					const liveFastMode = fastModeForModel(liveModel);
					const liveResult: SingleResult = {
						agent: agent.name,
						task,
						status: "continued",
						messages: [],
						usage: emptyUsage(),
						...(liveModel === undefined ? {} : { model: liveModel }),
						...(liveThinking === undefined ? {} : { thinking: liveThinking }),
						...(liveFastMode ? { fastMode: true } : {}),
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
			abort: options.signal ?? neverAbort,
			interrupt: options.interruptSignal ?? neverAbort,
		},
		{ fastModeForModel },
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
			fastMode: running.currentFastMode ?? fastModeForModel(launchModel),
			recentTools: [],
			recentOutput: [],
			toolCount: 0,
			tokens: 0,
			durationMs: Math.max(0, Date.now() - startedAt),
			lastActivityAt: Date.now(),
		});
	}
	control.registerNestedAttempt(options.runId, running, {
		model: resolvedCandidate?.model,
		modelId: candidate,
		thinkingLevel: spec.thinkingLevel,
	});
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
	const terminal = running.promise.then((value) => ({ kind: "terminal" as const, value }));
	const winner = await Promise.race([terminal, continuation.then(() => ({ kind: "continued" as const }))]);
	if (winner.kind === "continued") {
		detachCleanup();
		void running.promise.then(async (continuedOutcome) => {
			const recovered = resultFromOutcome(agent, task, continuedOutcome, startedAt, artifactPaths, {
				cwd,
				settings: fastModeSettings,
				scope: fastModeScope,
			});
			await control.deliverChildResult(
				{
					path: continuedOutcome.path,
					status: continuedOutcome.status,
					...(continuedOutcome.status === "error" ? { cause: continuedOutcome.cause } : {}),
					stats: continuedOutcome.stats,
					envelope: continuedOutcome.envelope,
					...(recovered.model === undefined ? {} : { model: recovered.model }),
					...(recovered.thinking === undefined ? {} : { thinking: recovered.thinking }),
					...(recovered.fastMode ? { fastMode: true } : {}),
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
		const continuedFastMode = fastModeForModel(continuedModel);
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
			...(continuedFastMode ? { fastMode: true } : {}),
			progress: {
				index: options.index ?? 0,
				agent: agent.name,
				status: "running",
				task,
				...(continuedModel === undefined ? {} : { model: continuedModel }),
				...(continuedThinking === undefined ? {} : { thinking: continuedThinking }),
				fastMode: continuedFastMode,
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
	const outcome = winner.value;
	const result = resultFromOutcome(agent, task, outcome, startedAt, artifactPaths, {
		cwd,
		settings: fastModeSettings,
		scope: fastModeScope,
	});
	if (filteredCandidates.skippedAttempts.length)
		result.modelAttempts = [...filteredCandidates.skippedAttempts, ...(result.modelAttempts ?? [])];
	await control.deliverChildResult(
		{
			path: outcome.path,
			status: outcome.status,
			...(outcome.status === "error" ? { cause: outcome.cause } : {}),
			stats: outcome.stats,
			envelope: outcome.envelope,
			...(result.model === undefined ? {} : { model: result.model }),
			...(result.thinking === undefined ? {} : { thinking: result.thinking }),
			...(result.fastMode ? { fastMode: true } : {}),
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
	return runSingleInProcess(runtimeCwd, agent, task, options);
}

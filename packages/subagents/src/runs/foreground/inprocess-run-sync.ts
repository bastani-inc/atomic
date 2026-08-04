import { join } from "node:path";
import type { AgentConfig } from "../../agents/agent-types.ts";
import { getArtifactPaths } from "../../shared/artifacts.ts";
import type {
	AgentProgress,
	ArtifactPaths,
	Details,
	RunSyncOptions,
	SingleResult,
	SubagentToolResult,
	Usage,
} from "../../shared/types.ts";
import { type AttemptOutcome, type ChildSpec, createSubagentControl, type ParentContext } from "../inprocess/runner.ts";

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
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

function progressFor(agent: AgentConfig, task: string, outcome: AttemptOutcome, startedAt: number): AgentProgress {
	const status = outcome.status === "ok" ? "completed" : outcome.status === "interrupted" ? "failed" : "failed";
	return {
		index: 0,
		agent: agent.name,
		status,
		task,
		recentTools: [],
		recentOutput: outcome.envelope ? outcome.envelope.split("\n").slice(-10) : [],
		toolCount: outcome.stats.toolCalls,
		turnCount: outcome.stats.assistantMessages,
		tokens: outcome.stats.tokens.total,
		durationMs: Math.max(0, Date.now() - startedAt),
		lastActivityAt: Date.now(),
	};
}

function resultFromOutcome(
	agent: AgentConfig,
	task: string,
	outcome: AttemptOutcome,
	startedAt: number,
	artifactPaths?: ArtifactPaths,
): SingleResult {
	const status = outcome.status;
	const output = outcome.status === "ok" ? outcome.output : outcome.envelope;
	const result: SingleResult = {
		agent: agent.name,
		task,
		status,
		...(outcome.status === "error" ? { cause: outcome.cause, error: outcome.cause } : {}),
		stats: outcome.stats,
		path: outcome.path,
		envelope: outcome.envelope,
		exitCode: status === "ok" ? 0 : status === "interrupted" ? 130 : 1,
		interrupted: status === "interrupted" ? true : undefined,
		messages: [],
		usage: usageFromStats(outcome.stats),
		model: undefined,
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
		exitCode: 1,
		messages: [],
		usage: emptyUsage(),
	};
}

export async function runSingleInProcess(
	runtimeCwd: string,
	agent: AgentConfig,
	task: string,
	options: RunSyncOptions,
): Promise<SingleResult> {
	const cwd = options.cwd ?? runtimeCwd;
	const parent: ParentContext = { path: options.runId, depth: 0 };
	const sessionRoot = options.sessionDir ?? join(options.artifactsDir ?? cwd, ".atomic", "subagents");
	const control = createSubagentControl(parent, sessionRoot);
	control.registerAgents([agent]);
	const artifactPaths =
		options.artifactsDir && options.artifactConfig?.enabled !== false
			? getArtifactPaths(options.artifactsDir, options.runId, agent.name, options.index)
			: undefined;
	const spec: ChildSpec = {
		taskName: agent.name,
		task,
		agent,
		cwd,
		tools: agent.tools,
		mcpDirectTools: agent.mcpDirectTools,
		skills: options.skills ?? agent.skills,
		model: undefined,
		thinkingLevel: agent.thinking as ChildSpec["thinkingLevel"],
		parent,
		artifactJsonlPath: artifactPaths?.jsonlPath,
	};
	const admission = control.admitChildSession(spec, parent);
	if (!admission.admitted) return refusedResult(agent, task, admission.refusal?.reason ?? "child admission refused");
	const neverAbort = new AbortController().signal;
	const startedAt = Date.now();
	const outcome = await control.runChildAttempt(
		admission.admitted,
		{ modelId: options.modelOverride, thinkingLevel: spec.thinkingLevel },
		{
			abort: options.signal ?? neverAbort,
			interrupt: options.interruptSignal ?? neverAbort,
		},
	);
	const result = resultFromOutcome(agent, task, outcome, startedAt, artifactPaths);
	if (artifactPaths) {
		await control.deliverChildResult(
			{
				path: outcome.path,
				status: outcome.status,
				...(outcome.status === "error" ? { cause: outcome.cause } : {}),
				stats: outcome.stats,
				envelope: outcome.envelope,
				sessionFile: outcome.sessionFile,
				timestamp: Date.now(),
				artifactsDir: options.artifactsDir,
			},
			{ artifactsDir: options.artifactsDir, maxOutput: options.maxOutput },
		);
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

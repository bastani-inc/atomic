import {
	type AgentTaskHost,
	type ExtensionContext,
	resumableSubagentResult,
	type TaskId,
	type ToolScriptAccess,
} from "@bastani/atomic";
import type { JsonValue } from "@bastani/atomic-ai";
import { Type } from "@bastani/atomic-ai";
import { admittedSubagentChild } from "../runs/foreground/released-child-resume.js";
import {
	currentChildWorktreeNote,
	finishingWorktreeStatus,
	worktreeWaitDeadline,
} from "../runs/foreground/run-worktrees.js";
import { subagentChildCardRecord } from "../runs/foreground/subagent-child-card-state.js";
import { subagentChildId, subagentChildOwner } from "../runs/foreground/subagent-child-records.js";
import type { SubagentParamsLike } from "../runs/foreground/subagent-executor-types.js";
import { readSettledOutput } from "../runs/foreground/task-execution.js";
import type { SubagentToolResult } from "../shared/types.js";

export const SUBAGENT_SCRIPT_ACTIONS: readonly string[] = [
	"list",
	"get",
	"models",
	"status",
	"wait",
	"pause",
	"resume",
	"quit",
];
const string = Type.String();
const optionalString = Type.Optional(string);
const resumeCall = Type.Optional(Type.Object({ action: Type.Literal("resume"), id: string }));
const identity = { childId: string, agent: string, taskId: optionalString, intercomTarget: optionalString };
const summary = {
	name: string,
	description: string,
	scope: string,
	package: optionalString,
	executable: Type.Boolean(),
	model: optionalString,
	defaultContext: optionalString,
};

export const subagentScriptAccess: ToolScriptAccess<{
	action?: string;
	id?: string;
	all?: boolean;
	runId?: string;
	budgetMs?: number;
}> = {
	description: `Launch specialists with {agent, task?} or {tasks:[{agent,task,count?}, ...], concurrency?}. Launch returns ordered tasks at admission, not completion. Keep childId for resume after restart, taskId for wait, and intercomTarget for peer messages. A child keeps running after the script ends and notifies the owning session.
Inspect definitions with list/get and the configured model catalog with models. status lists owned children; pass id for one. wait takes a task id and optional budgetMs (owner budget, default 30000); ending the wait never stops the child. pause/quit take id or all:true for this session; resume takes id and optional message. create/update/delete are model-only.`,
	outputSchema: Type.Union([
		Type.Object({
			action: Type.Literal("launch"),
			tasks: Type.Array(
				Type.Union([
					Type.Object({
						...identity,
						taskId: string,
						state: Type.Union([Type.Literal("admitted"), Type.Literal("queued")]),
					}),
					Type.Object({ agent: string, state: Type.Literal("refused"), reason: string }),
				]),
			),
		}),
		Type.Object({
			action: Type.Literal("wait"),
			taskId: string,
			outcome: Type.Union([Type.Literal("running"), Type.Literal("settled"), Type.Literal("stopped-waiting")]),
			childId: optionalString,
			resumeCall,
			worktreeNote: optionalString,
			result: Type.Optional(
				Type.Object({ status: string, output: optionalString, outputPath: optionalString, reason: optionalString }),
			),
		}),
		Type.Object({
			action: Type.Literal("status"),
			children: Type.Array(
				Type.Object({
					...identity,
					state: string,
					resumable: Type.Boolean(),
					worktreeNote: optionalString,
					resumeCall,
				}),
			),
		}),
		Type.Object({
			action: Type.Union([Type.Literal("pause"), Type.Literal("resume"), Type.Literal("quit")]),
			children: Type.Array(Type.Object({ ...identity, state: string })),
			worktreeNotes: Type.Optional(Type.Array(string)),
		}),
		Type.Object({ action: Type.Literal("list"), agents: Type.Array(Type.Object(summary)) }),
		Type.Object({
			action: Type.Literal("get"),
			definitions: Type.Array(
				Type.Object({
					...summary,
					systemPrompt: string,
					systemPromptMode: string,
					inheritProjectContext: Type.Boolean(),
					inheritSkills: Type.Boolean(),
					tools: Type.Optional(Type.Array(string)),
					mcpDirectTools: Type.Optional(Type.Array(string)),
					fallbackModels: Type.Optional(Type.Array(string)),
					skills: Type.Array(string),
				}),
			),
		}),
		Type.Object({
			action: Type.Literal("models"),
			models: Type.Array(
				Type.Object({
					provider: string,
					id: string,
					fullId: string,
					isCurrent: Type.Boolean(),
					availableThinkingLevels: Type.Array(string),
				}),
			),
		}),
	]),
	refuse({ action, id, all, runId, budgetMs }) {
		if (action !== undefined && !SUBAGENT_SCRIPT_ACTIONS.includes(action))
			return `subagent "${action}" is model-only: call the subagent tool directly, not from a script.`;
		if (runId !== undefined) return "Use id instead of runId in subagent scripts.";
		if (all && action !== "pause" && action !== "quit") return "Only pause and quit accept all: true.";
		if (
			(action === "wait" || action === "resume" || ((action === "pause" || action === "quit") && !all)) &&
			!id?.trim()
		)
			return `subagent "${action}" requires a child or task id.`;
		if (action === "wait" && budgetMs !== undefined && (!Number.isSafeInteger(budgetMs) || budgetMs < 0))
			return "budgetMs must be a non-negative integer.";
		return undefined;
	},
};

/** A result for the nested caller only; direct calls keep their existing text and details. */
export function scriptResult(structuredContent: JsonValue): SubagentToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(structuredContent) }],
		structuredContent,
		details: { mode: "management", results: [] },
	};
}

function childForTask(host: AgentTaskHost, owner: string, taskId: TaskId) {
	const lease = host.resolveTask(taskId);
	return lease.ok ? admittedSubagentChild(lease.value, owner) : undefined;
}

export async function waitForScriptChild(ctx: ExtensionContext, params: SubagentParamsLike, signal: AbortSignal) {
	const taskId = params.id as TaskId;
	const host = ctx.getAgentTaskHost?.();
	const owned = host && childForTask(host, subagentChildOwner(ctx).sessionId, taskId);
	if (!host || !owned) throw new Error(`Unknown subagent task in this session: ${taskId}`);
	const member = subagentChildCardRecord(owned.childId, taskId);
	const tree = member?.taskId === taskId ? member : undefined;
	const deadline = tree && worktreeWaitDeadline(tree);
	const waitSignal = deadline ? AbortSignal.any([signal, deadline.signal]) : signal;
	const observed = await host
		.waitForTask(taskId, params.budgetMs ?? host.boundedAgentWaitBudgetMs, undefined, waitSignal)
		.finally(() => deadline?.dispose());
	const note = () => tree && currentChildWorktreeNote(tree.runId, tree.index);
	const observing = (outcome: "running" | "stopped-waiting") => {
		const worktreeNote = tree && finishingWorktreeStatus(tree) && note();
		return scriptResult({ action: "wait", taskId, outcome, ...(worktreeNote ? { worktreeNote } : {}) });
	};
	if (!observed.ok) {
		if (observed.error.code === "ObserverCancelled")
			return observing(!signal.aborted && deadline?.signal.aborted ? "running" : "stopped-waiting");
		throw new Error(observed.error.message);
	}
	if (observed.value.kind === "yielded") return observing("running");
	const { result } = observed.value;
	const output = await readSettledOutput(host, observed.value, host.taskRecords(new Set([taskId]))[0]);
	const worktreeNote = note();
	return scriptResult({
		action: "wait",
		taskId,
		outcome: "settled",
		// A settled child that stays resumable names the call that continues it, in the shape `status` uses.
		childId: owned.childId,
		...(resumableSubagentResult(result) ? { resumeCall: { action: "resume", id: owned.childId } } : {}),
		...(worktreeNote ? { worktreeNote } : {}),
		result: {
			status:
				result.kind === "cancelled" && (result.cause === "pause" || result.cause === "quit") && !result.released
					? "paused"
					: result.kind,
			...(result.kind === "failed"
				? { reason: result.message }
				: result.kind === "cancelled"
					? { reason: result.cause }
					: {}),
			...(output && "head" in output
				? {
						output: output.head,
						...(output.requestedPath
							? { outputPath: output.requestedPath }
							: output.path && output.shown < output.total
								? { outputPath: output.path }
								: {}),
					}
				: output
					? { reason: output.unavailable }
					: {}),
		},
	});
}

export function scriptControlResult(result: SubagentToolResult): SubagentToolResult {
	const control = result.details?.runControl;
	if (control && !result.isError)
		return scriptResult({
			action: control.action,
			...(control.worktreeNotes?.length ? { worktreeNotes: [...control.worktreeNotes] } : {}),
			children: control.children.map(({ childId, agent, taskId, intercomTarget, state }) => ({
				childId,
				agent,
				state,
				...(taskId ? { taskId } : {}),
				...(intercomTarget ? { intercomTarget } : {}),
			})),
		});
	return result;
}

/** Project an actual admission from its expanded slots, even if a fast child's task has already been evicted. */
export function scriptLaunchReceipt(
	runId: string,
	params: SubagentParamsLike,
	result: SubagentToolResult,
): SubagentToolResult {
	const response = result.details?.taskResponse;
	if (!response) return result;
	const outcomes = response.kind === "parallel" ? response.slots.map((slot) => slot.outcome) : [response];
	const records = new Map(result.details?.taskRecords?.map((record) => [record.ref.taskId, record]));
	const tasks = outcomes.map((outcome, index): JsonValue => {
		const agent = params.tasks?.[index]?.agent ?? params.agent!;
		if (outcome.kind === "unstarted")
			return {
				agent,
				state: "refused",
				reason: outcome.reason.kind === "rejected" ? outcome.reason.error.message : outcome.reason.cause,
			};
		const { taskId } = outcome.observation;
		return {
			taskId,
			agent,
			childId: subagentChildId(runId, index),
			state: records.get(taskId)?.execution.kind === "queued" ? "queued" : "admitted",
			...("intercomTarget" in outcome && typeof outcome.intercomTarget === "string"
				? { intercomTarget: outcome.intercomTarget }
				: {}),
		};
	});
	return { ...result, structuredContent: { action: "launch", tasks } };
}

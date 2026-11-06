/**
 * Checks the invariants of a finished waiting-stage chaos run (#4309) in the shared database and prints one JSON line:
 * the run completed once, every stage completed once from the session it started, each stage's transcript starts with
 * its one prompt and is never prompted again mid-turn, every tool call has exactly one result and no result precedes
 * its call, every stage ends on a final answer, and every session belongs to this run.
 *
 *   node --import jiti/register test/fixtures/waiting-stage-chaos-check.ts
 *
 * Uses the same ATOMIC_CHAOS_* environment as waiting-stage-chaos.ts.
 */
import { SqlSessionStore } from "../../packages/coding-agent/src/core/storage/session/sql-session-store.js";
import { openChaosDatabase } from "./waiting-stage-chaos-database.js";
import { JournalDurableBackend } from "../../packages/workflows/src/durable/journal/journal-backend.js";
import { SqlRunJournal } from "../../packages/workflows/src/durable/journal/sql-run-journal.js";
import type { DurableStageCheckpoint } from "../../packages/workflows/src/durable/types.js";

const runId = process.env.ATOMIC_CHAOS_RUN_ID;
const url = process.env.ATOMIC_CHAOS_DB_URL;
const stages = Number(process.env.ATOMIC_CHAOS_STAGES ?? "10");
if (runId === undefined || url === undefined) throw new Error("ATOMIC_CHAOS_RUN_ID and ATOMIC_CHAOS_DB_URL are required");
const tokenFile = process.env.ATOMIC_CHAOS_DB_TOKEN_FILE;
const database = await openChaosDatabase(url, tokenFile);
const backend = await JournalDurableBackend.open(await SqlRunJournal.open(database));
const sessions = await SqlSessionStore.open(database);
const violations: string[] = [];
const reentries: string[] = [];
try {
	const status = backend.getWorkflow(runId)?.status;
	if (status !== "completed") violations.push(`run status is ${status}`);
	const checkpoints = backend
		.listCheckpoints(runId)
		.filter((checkpoint): checkpoint is DurableStageCheckpoint => checkpoint.kind === "stage");
	// A stage's completion is recorded under stable ids, the stage's own result and then its task's result, so a stage
	// completes at most once by construction. A stage whose process died between the two is replayed from the first
	// without running again; either one shows that the stage completed.
	const completedIds = new Map<string, Set<string>>();
	for (const checkpoint of checkpoints) {
		const kind = checkpoint.checkpointId.split(":", 1)[0];
		if ((kind !== "task" && kind !== "stage") || checkpoint.output === undefined) continue;
		const ids = completedIds.get(checkpoint.replayKey) ?? new Set<string>();
		if (ids.has(checkpoint.checkpointId)) violations.push(`stage ${checkpoint.replayKey} completed twice`);
		ids.add(checkpoint.checkpointId);
		completedIds.set(checkpoint.replayKey, ids);
	}
	const completed = new Set(completedIds.keys());
	if (completed.size !== stages) violations.push(`${completed.size} of ${stages} stages completed`);
	const sessionIds = new Map<string, string>();
	for (const checkpoint of checkpoints)
		if (checkpoint.sessionId !== undefined) sessionIds.set(checkpoint.replayKey, checkpoint.sessionId);
	for (const replayKey of completed) {
		const sessionId = sessionIds.get(replayKey);
		if (sessionId === undefined) {
			violations.push(`stage ${replayKey} has no session`);
			continue;
		}
		const snapshot = await sessions.load(sessionId);
		const header = snapshot.header as { readonly workflow?: { readonly runId?: string } };
		if (header.workflow?.runId !== runId) violations.push(`stage ${replayKey} session belongs to ${header.workflow?.runId}`);
		const messages = snapshot.entries.flatMap((entry) =>
			entry.type === "message"
				? [
						entry.message as {
							role: string;
							toolCallId?: string;
							stopReason?: string;
							content?: readonly { readonly type: string; readonly id?: string }[] | string;
						},
					]
				: [],
		);
		const conversation = messages.filter((message) => message.role !== "system");
		for (const [index, message] of conversation.entries()) {
			if (message.role !== "user" || index === 0) continue;
			const before = conversation[index - 1];
			// Durable resume re-enters a stage whose turn finished before its completion was checkpointed with a
			// continuation prompt, for every stage alike; that predates waiting stages and is reported on its own.
			if (before?.role === "assistant" && before.stopReason === "stop") reentries.push(replayKey);
			else violations.push(`stage ${replayKey} was prompted again after ${before?.role}/${before?.stopReason}`);
		}
		if (conversation[0]?.role !== "user") violations.push(`stage ${replayKey} does not start with its prompt`);
		const issued = new Set<string>();
		const results = new Map<string, number>();
		for (const message of conversation) {
			if (message.role === "assistant" && Array.isArray(message.content))
				for (const part of message.content) if (part.type === "toolCall" && part.id !== undefined) issued.add(part.id);
			if (message.role !== "toolResult" || message.toolCallId === undefined) continue;
			if (!issued.has(message.toolCallId))
				violations.push(`stage ${replayKey} has a result for ${message.toolCallId} before its call`);
			results.set(message.toolCallId, (results.get(message.toolCallId) ?? 0) + 1);
		}
		for (const toolCallId of issued)
			if (results.get(toolCallId) !== 1)
				violations.push(`stage ${replayKey} call ${toolCallId} has ${results.get(toolCallId) ?? 0} results`);
		const last = conversation.at(-1);
		if (last?.role !== "assistant" || last.stopReason !== "stop")
			violations.push(`stage ${replayKey} ends with ${last?.role}/${last?.stopReason}`);
	}
	console.log(
		JSON.stringify({
			runId,
			ok: violations.length === 0,
			completedStages: completed.size,
			violations,
			reentriesAfterCompletedTurn: reentries,
		}),
	);
} finally {
	await backend.close();
	await sessions.close();
}
process.exit(violations.length === 0 ? 0 : 1);

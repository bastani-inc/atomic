import { type SubagentChildRecord, summarizeSubagentTask, TASK_SUMMARY_LIMIT } from "./subagent-child-records.js";

/** A launch task up to this long is put into the relaunch call as it was written. */
const FULL_TASK_LIMIT = 2_000;

type RecordedTask =
	| { readonly kind: "complete"; readonly text: string }
	| { readonly kind: "cut"; readonly text: string }
	| { readonly kind: "unrecorded" };

/** What the record keeps of the task: its full text, a one-line summary that fits, a summary that was cut, or nothing. */
export function recordedTask(record: SubagentChildRecord): RecordedTask {
	const launched = record.launch?.intentTask ?? record.launch?.task;
	if (launched) {
		return launched.length <= FULL_TASK_LIMIT
			? { kind: "complete", text: launched }
			: { kind: "cut", text: summarizeSubagentTask(launched) };
	}
	if (!record.task) return { kind: "unrecorded" };
	return record.task === summarizeSubagentTask(record.task) && record.task.endsWith("…")
		? { kind: "cut", text: record.task }
		: { kind: "complete", text: record.task };
}

function shellWord(value: string): string {
	return /^[\w./:@%+=,-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * What a restart left of a child that cannot be restored, as one agent-facing passage: the facts its record holds,
 * the `subagent` call that launches it again, and where to look at what it left behind (#4660).
 */
export function describeLostSubagentChild(record: SubagentChildRecord): string {
	const task = recordedTask(record);
	const worktree = record.worktree;
	const cwd = worktree?.path ?? record.cwd;
	const launchHint = `the \`subagent\` call that launched run ${record.runId} is in this session's history`;
	const facts = [
		`agent ${record.agent}`,
		task.kind === "unrecorded"
			? `task: not recorded (${launchHint})`
			: `task: ${task.kind === "cut" ? `${task.text} (cut to ${TASK_SUMMARY_LIMIT} characters; the full text is in the launching call)` : summarizeSubagentTask(task.text)}`,
		`run ${record.runId}, child ${record.childId}`,
		`cwd ${record.cwd}`,
		...(worktree ? [`worktree ${worktree.path} (branch ${worktree.branch})`] : []),
		...(record.childSessionId ? [`session ${record.childSessionId}`] : []),
		...(record.childSessionFile ? [`session file ${record.childSessionFile}`] : []),
	];
	const relaunch =
		task.kind === "complete"
			? `To relaunch it: \`subagent({ agent: ${JSON.stringify(record.agent)}, task: ${JSON.stringify(task.text)}, cwd: ${JSON.stringify(cwd)} })\`.`
			: task.kind === "cut"
				? `To relaunch it, take its task from the launching call (${launchHint}) and run \`subagent({ agent: ${JSON.stringify(record.agent)}, task: <its task>, cwd: ${JSON.stringify(cwd)} })\`.`
				: `To relaunch it, take its task from the launching call and run it with agent ${JSON.stringify(record.agent)} in ${JSON.stringify(cwd)}.`;
	const inspect = worktree
		? `Inspect what it left behind with \`git -C ${shellWord(worktree.path)} status\` and \`git -C ${shellWord(worktree.path)} log ${worktree.baseCommit}..${worktree.branch}\`; relaunching in its worktree continues from that work.`
		: `Inspect what it left behind in ${record.cwd}.`;
	return `Facts: ${facts.join("; ")}. ${relaunch} ${inspect}`;
}

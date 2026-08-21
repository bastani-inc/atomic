import { computeFileHash, type SnapshotStore } from "./hashline-engine/index.ts";

/**
 * Stable token carried inside every conflict message.
 *
 * It lives in the message text, not only on the class, because nothing typed survives the
 * trip from a tool to a workflow: a subagent result reports `cause`/`error` as strings, a
 * workflow task result has no error field at all, and the Goal runner reduces a failure to
 * `err.message`. Matching this token is how Goal recognises a conflict it should count
 * against its budget rather than treat as an ordinary tool error.
 *
 * It is placed at the start of the message so it survives truncation of the tail as the
 * message is relayed. Never change it without updating every consumer that matches on it.
 */
export const FILE_MUTATION_CONFLICT_CODE = "FILE_MUTATION_CONFLICT";

/**
 * Reasons report a {@link FileMutationLiveState} wherever the live target can be described,
 * which is everywhere except `target_unreadable`: that one exists precisely because the target
 * could not be read, so claiming a size or a tag for it would be invention.
 *
 * Only the reasons that have something to compare against also report a
 * {@link FileMutationConflictEvidence} diff: `no_prior_observation` never read the file, and
 * `foreign_snapshot` presented a tag naming content this session has never seen, so in both
 * cases there is no prior side to diff.
 */
export type FileMutationConflictReason =
	/** Live content moved between the mutation being prepared and the write being attempted. */
	| "changed_before_write"
	/** Overwrite attempted with no prior read of this file in this session. */
	| "no_prior_observation"
	/** Overwrite attempted, but what this session observed is no longer the live content. */
	| "changed_since_observation"
	/** Exclusive create lost: the target already exists. */
	| "target_exists"
	/** The target no longer exists: removed between preparing the mutation and writing it. */
	| "target_missing"
	/**
	 * The target still exists but can no longer be read: replaced by a directory, made
	 * unreadable, locked, or rewritten as content this reader cannot parse. Distinct from a
	 * content change because there is nothing to diff, and from a deletion because the path is
	 * still occupied.
	 */
	| "target_unreadable"
	/** The presented tag was never minted in this session's snapshot store. */
	| "foreign_snapshot";

/**
 * Correlation only.
 *
 * Flora, 2026-08-13: identity "must never grant permission or identify a current owner or
 * culprit". So this describes the writer being *rejected*, never a winner, and nothing in
 * this module reads it to decide whether a mutation is admitted. A record of the last Atomic
 * writer could not prove ownership anyway, because shell commands, external programs, other
 * Atomic processes and symlink changes all bypass this coordinator.
 */
export interface MutationRequester {
	readonly sessionId: string;
	/** Session that spawned this one, from the child's `supervisor.supervisorSessionId`. */
	readonly parentSessionId?: string;
	readonly workflowRunId?: string;
	readonly workflowStageId?: string;
	readonly workflowStageName?: string;
	readonly subagentRunId?: string;
	readonly subagentAgent?: string;
	/**
	 * Position within a fan-out. Needed to tell siblings apart: a child's intercom address is
	 * `agent + runId + index` (`resolveSubagentIntercomTarget`), so a stage that spawns several
	 * children of one agent onto one file yields identical identity without it.
	 */
	readonly subagentIndex?: number;
	/** Opaque per-attempt UUID. Diagnostic only; never an authority. */
	readonly attemptId?: string;
	/** The specific tool call rejected. Narrower than the attempt, which makes many calls. */
	readonly toolCallId?: string;
}

/**
 * Resolved per execution rather than captured once.
 *
 * Mirrors `sessionTempDir` in the session tool registry, which is a thunk "so bash spill
 * files follow the live transcript session across fork/branch/resume". A requester captured
 * at tool-construction time would keep a stale session id through exactly those transitions,
 * which is the relaunch case this feature exists to make legible.
 *
 * Takes the tool call id rather than leaving callers to merge it in, because it has a
 * different lifetime from the rest: session identity belongs to the session, the call id is
 * an argument of the single `execute` being rejected.
 */
export type MutationRequesterResolver = (toolCallId: string) => MutationRequester | undefined;

/**
 * What actually diverged, so a conflict can be acted on without a second round trip.
 *
 * Flora, 2026-08-19: a conflict that exhausts Goal's budget moves to `needs_human` "with
 * evidence". A reason and a path are not evidence; they say a race happened, not what it did.
 *
 * The span is computed by trimming the common prefix and suffix rather than comparing line by
 * line positionally, so inserting one line at the top reports one changed region and not every
 * following line.
 */
export interface FileMutationConflictEvidence {
	/** 1-based line of the first divergence. */
	readonly line: number;
	/** Lines the rejected mutation assumed occupied the divergent span. */
	readonly assumedLines: number;
	/** Lines actually occupying it now. */
	readonly foundLines: number;
	/** First assumed line, clamped. Absent when the span is pure insertion. */
	readonly assumed?: string;
	/** First live line, clamped. Absent when the span is pure deletion. */
	readonly found?: string;
}

/**
 * Excerpts are clamped because a conflict travels as message text through channels that
 * truncate, and because file content copied into an error outlives the turn in ledger records.
 * One line per side is enough to tell the model whether its plan still holds.
 */
const EVIDENCE_LINE_CHARS = 120;

function clampLine(line: string): string {
	return line.length <= EVIDENCE_LINE_CHARS ? line : `${line.slice(0, EVIDENCE_LINE_CHARS)}...`;
}

/**
 * The target as it stood at the moment of refusal, independent of any comparison.
 *
 * Kept separate from {@link FileMutationConflictEvidence} because the two answer different
 * questions and only one of them can be unanswerable. A conflict may have nothing to diff
 * against, as when the session never read the file, but there is still always something worth
 * reporting about what the mutation was aimed at. Size in particular is the difference between
 * clobbering an empty placeholder and clobbering four hundred lines of production code.
 */
export interface FileMutationLiveState {
	/** Lines currently in the file. Zero when it is empty or does not exist. */
	readonly lines: number;
	/** Tag of the live content, so a rejected tag can be told apart from the real one. */
	readonly tag?: string;
	/** First line, clamped. Absent when the file is missing, empty, or starts with a blank line. */
	readonly firstLine?: string;
}

/** Describe live content, or a missing target when `live` is `undefined`. */
export function computeLiveState(live: string | undefined): FileMutationLiveState {
	if (live === undefined) return { lines: 0 };
	// Trailing newline terminates the last line rather than starting an empty one.
	const lines = live === "" ? [] : live.replace(/\n$/, "").split("\n");
	const first = lines[0];
	return {
		lines: lines.length,
		tag: computeFileHash(live),
		...(first ? { firstLine: clampLine(first) } : {}),
	};
}

/**
 * Compare what a mutation assumed against what is live, returning `undefined` when they agree.
 *
 * Both sides must already share a line-ending convention. `Snapshot.text` is normalized to LF,
 * so a caller passing raw live bytes on Windows would report every line as divergent.
 */
export function computeConflictEvidence(assumed: string, found: string): FileMutationConflictEvidence | undefined {
	if (assumed === found) return undefined;
	const assumedLines = assumed.split("\n");
	const foundLines = found.split("\n");
	let start = 0;
	while (start < assumedLines.length && start < foundLines.length && assumedLines[start] === foundLines[start]) {
		start++;
	}
	let endAssumed = assumedLines.length;
	let endFound = foundLines.length;
	while (endAssumed > start && endFound > start && assumedLines[endAssumed - 1] === foundLines[endFound - 1]) {
		endAssumed--;
		endFound--;
	}
	return {
		line: start + 1,
		assumedLines: endAssumed - start,
		foundLines: endFound - start,
		...(start < endAssumed ? { assumed: clampLine(assumedLines[start] ?? "") } : {}),
		...(start < endFound ? { found: clampLine(foundLines[start] ?? "") } : {}),
	};
}

export interface FileMutationConflictDetails {
	readonly reason: FileMutationConflictReason;
	/** Display path, as the model referred to it. */
	readonly path: string;
	/** Symlink-resolved key, from `canonicalMutationKey`. */
	readonly canonicalKey: string;
	readonly requester?: MutationRequester;
	/** The tag the rejected mutation presented, when it had one. */
	readonly presentedTag?: string;
	/** Absent when the reason carries no comparison, as with `no_prior_observation`. */
	readonly evidence?: FileMutationConflictEvidence;
	/** What the mutation was aimed at. Absent only when it could not be read at all. */
	readonly liveState?: FileMutationLiveState;
	/**
	 * Filesystem error code that classified the conflict, such as `EISDIR` or `EACCES`. For a
	 * target that became unreadable this is the whole diagnosis, since nothing else about the
	 * file can be reported once the read fails.
	 */
	readonly causeCode?: string;
}

interface ReasonCopy {
	/** Why the mutation was refused. */
	readonly diagnosis: string;
	/** What to do about it. */
	readonly instruction: string;
}

/**
 * Paired so the instruction cannot contradict the diagnosis it follows.
 *
 * A single shared instruction cannot be true of all six reasons. "Read the file again" is
 * false for the two that fail precisely because the file was never read, and impossible for
 * `target_missing`, where there is nothing left to read.
 */
const REASON_COPY: Record<FileMutationConflictReason, ReasonCopy> = {
	changed_before_write: {
		diagnosis: "the file changed after this edit was prepared",
		instruction: "Read the file again and rebuild this edit from what it says now; do not resend it unchanged.",
	},
	no_prior_observation: {
		diagnosis: "this session has not read the file it is overwriting",
		instruction: "Read the file first, then decide whether this overwrite is still the change you want.",
	},
	changed_since_observation: {
		diagnosis: "the file changed since this session last read it",
		instruction: "Read the file again and reconcile this change with what is there now.",
	},
	target_exists: {
		diagnosis: "the file already exists",
		instruction: "Read the existing file and edit it in place, or write to a different path.",
	},
	target_missing: {
		diagnosis: "the file no longer exists",
		instruction: "Do not read it; confirm the removal was intended, then recreate the file or drop this change.",
	},
	target_unreadable: {
		diagnosis: "the file still exists but could no longer be read",
		instruction:
			"Something replaced or locked the path rather than editing it. Inspect what is there now before retrying; a second identical edit will fail the same way.",
	},
	foreign_snapshot: {
		diagnosis: "the snapshot tag was not issued in this session",
		instruction: "Read the file in this session to obtain a valid tag before editing it.",
	},
};

function describeRequester(requester: MutationRequester | undefined): string {
	if (!requester) return "";
	const parts = [`session=${requester.sessionId}`];
	if (requester.parentSessionId) parts.push(`parent=${requester.parentSessionId}`);
	if (requester.workflowRunId) parts.push(`run=${requester.workflowRunId}`);
	if (requester.workflowStageId) parts.push(`stage=${requester.workflowStageId}`);
	// Quoted: a stage name is free text and the field separator here is a space.
	if (requester.workflowStageName) parts.push(`stageName="${requester.workflowStageName}"`);
	if (requester.subagentRunId) parts.push(`child=${requester.subagentRunId}`);
	if (requester.subagentAgent) parts.push(`agent=${requester.subagentAgent}`);
	// Presence, not truthiness: the first child of a fan-out is index 0.
	if (requester.subagentIndex !== undefined) parts.push(`index=${requester.subagentIndex}`);
	if (requester.attemptId) parts.push(`attempt=${requester.attemptId}`);
	if (requester.toolCallId) parts.push(`call=${requester.toolCallId}`);
	return ` [${parts.join(" ")}]`;
}

/**
 * Quote an excerpt of file content for inclusion in a single-line message.
 *
 * `JSON.stringify` rather than wrapping in backticks or quotes of our own: source lines
 * routinely contain both, and a template literal in a TypeScript file would otherwise close
 * the delimiter early and leave the excerpt unreadable. It also escapes control characters,
 * so a stray CR from a file this module was handed unnormalized shows up as `\r` rather than
 * silently rearranging the message.
 */
function quoteExcerpt(text: string): string {
	return JSON.stringify(text);
}

function describeEvidence(evidence: FileMutationConflictEvidence | undefined): string {
	if (!evidence) return "";
	const span =
		evidence.assumedLines === 1 && evidence.foundLines === 1
			? ""
			: ` (${evidence.assumedLines} lines replaced by ${evidence.foundLines})`;
	const at = ` First divergence at line ${evidence.line}`;
	if (evidence.assumed !== undefined && evidence.found !== undefined) {
		return `${at}: assumed ${quoteExcerpt(evidence.assumed)}, found ${quoteExcerpt(evidence.found)}${span}.`;
	}
	if (evidence.found !== undefined) {
		return `${at}: found ${quoteExcerpt(evidence.found)} where this mutation expected nothing${span}.`;
	}
	return `${at}: assumed ${quoteExcerpt(evidence.assumed ?? "")}, which is no longer present${span}.`;
}

function describeLiveState(state: FileMutationLiveState | undefined): string {
	if (!state) return "";
	if (!state.tag) return " The target does not exist.";
	const first = state.firstLine ? `, starting ${quoteExcerpt(state.firstLine)}` : "";
	return ` Target now holds ${state.lines} lines, #${state.tag}${first}.`;
}

/**
 * Raised instead of a bare `Error` so a conflict is countable rather than merely readable.
 * The message is the wire format; see {@link FILE_MUTATION_CONFLICT_CODE}.
 */
export class FileMutationConflict extends Error {
	readonly reason: FileMutationConflictReason;
	readonly path: string;
	readonly canonicalKey: string;
	readonly requester: MutationRequester | undefined;
	readonly presentedTag: string | undefined;
	/** Structured alongside the message so a ledger can record it without re-parsing text. */
	readonly evidence: FileMutationConflictEvidence | undefined;
	readonly liveState: FileMutationLiveState | undefined;
	readonly causeCode: string | undefined;

	constructor(details: FileMutationConflictDetails) {
		super(FileMutationConflict.formatMessage(details));
		// Subclassing Error does not set this, and consumers match on it.
		this.name = "FileMutationConflict";
		this.reason = details.reason;
		this.path = details.path;
		this.canonicalKey = details.canonicalKey;
		this.requester = details.requester;
		this.presentedTag = details.presentedTag;
		this.evidence = details.evidence;
		this.liveState = details.liveState;
		this.causeCode = details.causeCode;
	}

	/**
	 * Ordered by what must survive truncation: the code first, then the reason and guidance,
	 * then the divergence, and the live-state summary last. The tail is the most expendable
	 * because it is the part a reader can always recover by opening the file.
	 */
	static formatMessage(details: FileMutationConflictDetails): string {
		const tag = details.presentedTag ? ` (presented #${details.presentedTag})` : "";
		const copy = REASON_COPY[details.reason];
		const cause = details.causeCode ? ` (${details.causeCode})` : "";
		return (
			`${FILE_MUTATION_CONFLICT_CODE}:${details.reason} ${details.path}${tag}: ` +
			`${copy.diagnosis}${cause}.${describeRequester(details.requester)} ` +
			copy.instruction +
			describeEvidence(details.evidence) +
			describeLiveState(details.liveState)
		);
	}
}

/** Whether a thrown value is an exclusive-create collision reported by the filesystem. */
export function isExclusiveCreateCollision(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

/**
 * Whether a thrown value says the target is gone. `ENOTDIR` counts because a parent directory
 * replaced by a file makes the path unreachable for the same reason a deletion does.
 */
export function isMissingTargetError(error: unknown): boolean {
	const code = filesystemErrorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

/** The `code` a filesystem rejection carries, when it carries one. */
export function filesystemErrorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}

/**
 * Guard for the window between preparing a mutation and committing it, called under the
 * mutation queue.
 *
 * `prepared` is the content the mutation was computed against, which for a hashline edit is
 * the file as `prepare` read it, NOT what the session originally observed, since `prepare`
 * re-reads and may have recovered onto drifted content. Naming that honestly matters: this
 * closes a time-of-check window, it does not prove the session read the file.
 *
 * Full text rather than tags: a hashline tag is 16 bits and the engine documents that it can
 * collide, so it is a label for the model to recognise, never proof of identity.
 */
export function assertLiveMatchesPrepared(args: {
	readonly canonicalKey: string;
	readonly path: string;
	readonly prepared: string;
	readonly live: string;
	readonly requester?: MutationRequester;
	readonly presentedTag?: string;
}): void {
	if (args.live === args.prepared) return;
	const evidence = computeConflictEvidence(args.prepared, args.live);
	throw new FileMutationConflict({
		reason: "changed_before_write",
		path: args.path,
		canonicalKey: args.canonicalKey,
		requester: args.requester,
		presentedTag: args.presentedTag,
		liveState: computeLiveState(args.live),
		...(evidence ? { evidence } : {}),
	});
}

/**
 * Guard for `write` overwriting an existing file: this session must already have observed the
 * exact content it is about to replace.
 *
 * Asks the session's own store and never another session's, which is what keeps cross-session
 * rejection strict. `byHashAndText` answers both halves of the requirement at once, since a
 * hit means this session recorded exactly this content for this path.
 *
 * `storeKey` is the snapshot store's own key convention, the normalized absolute path, which
 * is NOT symlink-resolved unlike `canonicalKey`. Passing the wrong one makes a symlinked path
 * miss and report a false `no_prior_observation`.
 *
 * The tag is derived here rather than accepted. Unlike the engine's own use of
 * `byHashAndText`, where the hash is the independent claim a section presented, `write` has no
 * presented tag: it replaces the whole file. Any tag is therefore just `live` hashed, and
 * taking it as a parameter only creates a way for the two to disagree silently.
 */
export function assertPriorSessionObservation(args: {
	readonly canonicalKey: string;
	readonly storeKey: string;
	readonly path: string;
	readonly store: SnapshotStore;
	readonly live: string;
	readonly requester?: MutationRequester;
}): void {
	if (args.store.byHashAndText(args.storeKey, computeFileHash(args.live), args.live)) return;
	// The last version this session recorded is what it believed it was overwriting, so the
	// divergence from live is the evidence. Without one there is nothing to diff, but the live
	// state still reports what was about to be clobbered sight unseen, which is the part a
	// human reviewing a `needs_human` stop actually needs.
	const head = args.store.head(args.storeKey);
	const evidence = head ? computeConflictEvidence(head.text, args.live) : undefined;
	throw new FileMutationConflict({
		reason: head ? "changed_since_observation" : "no_prior_observation",
		path: args.path,
		canonicalKey: args.canonicalKey,
		requester: args.requester,
		liveState: computeLiveState(args.live),
		...(evidence ? { evidence } : {}),
	});
}

/**
 * Build a requester from parts already present on a session. Kept pure so it is testable
 * without constructing an `AgentSession`, and so this module never imports one.
 */
export function buildMutationRequester(parts: {
	readonly sessionId: string;
	readonly orchestration?: {
		readonly kind: string;
		readonly workflowRunId: string;
		readonly workflowStageId: string;
		readonly workflowStageName: string;
	};
	readonly intercom?: {
		readonly runId: string;
		readonly agent: string;
		readonly index?: number;
		readonly supervisor?: { readonly supervisorSessionId: string };
	};
	readonly attemptId?: string;
	readonly toolCallId?: string;
}): MutationRequester {
	const workflow = parts.orchestration?.kind === "workflow-stage" ? parts.orchestration : undefined;
	const supervisorSessionId = parts.intercom?.supervisor?.supervisorSessionId;
	const subagentIndex = parts.intercom?.index;
	return {
		sessionId: parts.sessionId,
		...(supervisorSessionId ? { parentSessionId: supervisorSessionId } : {}),
		...(workflow ? { workflowRunId: workflow.workflowRunId } : {}),
		...(workflow ? { workflowStageId: workflow.workflowStageId } : {}),
		...(workflow ? { workflowStageName: workflow.workflowStageName } : {}),
		...(parts.intercom ? { subagentRunId: parts.intercom.runId } : {}),
		...(parts.intercom ? { subagentAgent: parts.intercom.agent } : {}),
		// Presence, not truthiness: index 0 is the first child, and `0 ? … : {}` drops it.
		...(subagentIndex !== undefined ? { subagentIndex } : {}),
		...(parts.attemptId ? { attemptId: parts.attemptId } : {}),
		...(parts.toolCallId ? { toolCallId: parts.toolCallId } : {}),
	};
}

// @generated vendored verbatim from oh-my-pi packages/hashline @ 15b5c1397fc -- DO NOT EDIT.
// Parity source for the Atomic hashline edit engine (issue #1483); adapted only for Atomic's Node runtime (relative imports, Bun->Node host calls, erasable constructor syntax).
/**
 * Recover from a stale section snapshot tag by replaying the would-be edit
 * against a cached pre-edit snapshot of the file and 3-way-merging the
 * result onto the current on-disk content.
 *
 * The patcher consults this when a section tag resolves to a snapshot that no
 * longer matches the live file content. The recovery class is stateless apart
 * from the {@link SnapshotStore} it queries; the snapshot store is the seam
 * lets you plug in your own caching strategy.
 */
import * as Diff from "diff";
import { applyEdits } from "./apply.js";
import { RECOVERY_EXTERNAL_WARNING, RECOVERY_SESSION_CHAIN_WARNING, RECOVERY_SESSION_REPLAY_WARNING } from "./messages.js";
import type { Snapshot, SnapshotStore } from "./snapshots.js";
import type { Anchor, ApplyResult, Edit } from "./types.js";

// Section tags are line-precise; never let Diff.applyPatch slide a hunk
// onto a duplicate closer 100+ lines away. If snapshot replay does not
// align exactly, refuse and let the caller re-read.
const RECOVERY_FUZZ_FACTOR = 0;

export interface RecoveryArgs {
	path: string;
	currentText: string;
	fileHash: string;
	edits: readonly Edit[];
}

export interface RecoveryResult {
	/** Post-recovery text. */
	text: string;
	/** First changed line (1-indexed) relative to the live `currentText`, or `undefined`. */
	firstChangedLine: number | undefined;
	/** Warnings collected during recovery, including the user-facing recovery banner. */
	warnings: string[];
}

function applyEditsToSnapshot(
	previousText: string,
	currentText: string,
	edits: readonly Edit[],
	recoveryWarning: string,
): RecoveryResult | null {
	let applied: ApplyResult;
	try {
		applied = applyEdits(previousText, [...edits]);
	} catch {
		return null;
	}
	if (applied.text === previousText) return null;

	const patch = Diff.structuredPatch("file", "file", previousText, applied.text, "", "", { context: 3 });
	const merged = Diff.applyPatch(currentText, patch, { fuzzFactor: RECOVERY_FUZZ_FACTOR });
	if (typeof merged !== "string" || merged === currentText) return null;

	const firstChangedLine = findFirstChangedLine(currentText, merged) ?? applied.firstChangedLine;
	const hasNetChange = firstChangedLine !== undefined;
	const warnings = hasNetChange ? [recoveryWarning, ...(applied.warnings ?? [])] : [...(applied.warnings ?? [])];

	return { text: merged, firstChangedLine, warnings };
}

function collectAnchorLines(edits: readonly Edit[]): number[] {
	const lines: number[] = [];
	for (const edit of edits) {
		for (const anchor of getEditAnchors(edit)) lines.push(anchor.line);
	}
	return lines;
}

function getEditAnchors(edit: Edit): Anchor[] {
	if (edit.kind === "delete") return [edit.anchor];
	// Recovery only ever receives already-resolved edits (no `block`); this arm
	// exists for type-exhaustiveness over the full `Edit` union.
	if (edit.kind === "block") return [edit.anchor];
	return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor" ? [edit.cursor.anchor] : [];
}

/**
 * Returns true when every anchor line in `edits` has identical content in
 * `previousText` and `currentText`. The session-chain replay fast-path
 * requires this: if the prior in-session edit rewrote the line the model is
 * now re-targeting with a stale hash, replaying onto current would silently
 * overwrite the new content with whatever the model authored against the
 * old content — a corruption window, not a recovery.
 */
function verifyAnchorContent(previousText: string, currentText: string, edits: readonly Edit[]): boolean {
	const lines = collectAnchorLines(edits);
	if (lines.length === 0) return true;
	const prev = previousText.split("\n");
	const curr = currentText.split("\n");
	for (const line of lines) {
		const idx = line - 1;
		if (idx < 0 || idx >= prev.length || idx >= curr.length) return false;
		if (prev[idx] !== curr[idx]) return false;
	}
	return true;
}

function replaySessionChainOnCurrent(
	previousText: string,
	currentText: string,
	edits: readonly Edit[],
): RecoveryResult | null {
	// Two guards narrow the corruption window. Neither alone is sufficient,
	// and even together they don't fully prove correctness — replay is the
	// less-certain recovery mode and emits RECOVERY_SESSION_REPLAY_WARNING
	// so the caller can verify the diff.
	//   - Equal line counts: every line number in `edits` still resolves to
	//     SOME logical row (no net shift across the prior chain). A
	//     coincidental insert+delete pair can still leave indices pointing
	//     at different logical rows than the model anchored against.
	//   - Anchor-content alignment: the row at each anchor's line index has
	//     identical content in previous and current. Catches the common
	//     case of a prior edit rewriting the targeted line; can still be
	//     coincidentally satisfied by a duplicated row at the shifted
	//     index.
	if (previousText.split("\n").length !== currentText.split("\n").length) return null;
	if (!verifyAnchorContent(previousText, currentText, edits)) return null;
	let applied: ApplyResult;
	try {
		applied = applyEdits(currentText, [...edits]);
	} catch {
		return null;
	}
	if (applied.text === currentText) return null;
	return {
		text: applied.text,
		firstChangedLine: applied.firstChangedLine,
		warnings: [RECOVERY_SESSION_REPLAY_WARNING, ...(applied.warnings ?? [])],
	};
}

/** First 1-indexed line at which `a` and `b` diverge, or `undefined` if equal. */
function findFirstChangedLine(a: string, b: string): number | undefined {
	if (a === b) return undefined;
	const aLines = a.split("\n");
	const bLines = b.split("\n");
	const max = Math.max(aLines.length, bLines.length);
	for (let i = 0; i < max; i++) {
		if (aLines[i] !== bLines[i]) return i + 1;
	}
	return undefined;
}

function isHeadSnapshot(head: Snapshot | null, snapshot: Snapshot): boolean {
	return head === snapshot;
}

/**
 * Stateless recovery driver over a {@link SnapshotStore}. Construct once and
 * call {@link Recovery.tryRecover} per stale-tag incident. The default
 * implementation tries two strategies in order:
 *
 * 1. Apply the edits on the full-file version the tag names, then 3-way-merge
 *    the resulting patch onto the live content (handles external writes).
 * 2. (Session chain) If that version wasn't the head, replay the edits onto
 *    the live content directly when line counts match AND every edit's anchor
 *    line content is unchanged between version and current — a prior in-session
 *    edit advanced the tag and the model's anchors still name the same logical
 *    rows. Emits a dedicated {@link RECOVERY_SESSION_REPLAY_WARNING} because
 *    even with both guards a coincidental insert+delete pair on duplicate rows
 *    can still land the edit on the wrong row; see {@link replaySessionChainOnCurrent}.
 */
export class Recovery {
	readonly store: SnapshotStore;
	constructor(store: SnapshotStore) { this.store = store; }
	/**
	 * Attempt recovery. Returns `null` when no path forward is found — the
	 * caller should then surface a {@link MismatchError}.
	 */
	tryRecover(args: RecoveryArgs): RecoveryResult | null {
		const { path, currentText, fileHash, edits } = args;
		const snapshot = this.store.byHash(path, fileHash);
		if (!snapshot) return null;
		const isHead = isHeadSnapshot(this.store.head(path), snapshot);
		const recoveryWarning = isHead ? RECOVERY_EXTERNAL_WARNING : RECOVERY_SESSION_CHAIN_WARNING;
		const merged = applyEditsToSnapshot(snapshot.text, currentText, edits, recoveryWarning);
		if (merged !== null) return merged;
		// Session-chain fallback: the 3-way merge on the version refused.
		// Replay onto current is gated by line-count equality AND
		// anchor-content alignment — see `replaySessionChainOnCurrent`
		// for why both guards together still don't fully prove correctness.
		if (!isHead) return replaySessionChainOnCurrent(snapshot.text, currentText, edits);
		return null;
	}
}

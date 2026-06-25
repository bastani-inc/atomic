// @generated vendored verbatim from oh-my-pi packages/hashline @ 15b5c1397fc -- DO NOT EDIT.
// Parity source for the Atomic hashline edit engine (issue #1483); adapted only for Atomic's Node runtime (relative imports, Bun->Node host calls, erasable constructor syntax).
/**
 * High-level patch orchestrator. Reads each section's target file via the
 * configured {@link Filesystem}, strips BOM and normalizes line endings,
 * validates the section snapshot tag (with {@link Recovery}), applies the
 * result back through the same {@link Filesystem}.
 *
 * Two layers:
 * - {@link Patcher.apply} — high-level, preflight-atomic. It validates and
 *   applies every section in memory before any write hits disk, then commits
 *   in order. It is not write-transactional: a mid-batch filesystem failure
 *   can leave earlier sections already written, and the thrown error reports
 *   which sections landed.
 * - {@link Patcher.prepare} / {@link Patcher.commit} — granular primitives
 *   for callers that need per-section control (e.g. batched LSP flush,
 *   custom interleaving). `prepare` performs all the read-side work,
 *   validates the section snapshot tag (with recovery), and applies the
 *   edits in memory. `commit` writes the prepared result and records a
 *   fresh snapshot.
 *
 * Because `prepare` already runs the full apply, a multi-section batch fails
 * before any write when parsing, stale-tag validation, or in-memory apply fails.
 *
 * The patcher itself is stateless across calls; reuse one instance per
 * filesystem configuration.
 */
import { applyEdits } from "./apply.js";
import { hasBlockEdit, resolveBlockEdits } from "./block.js";
import { computeFileHash, formatHashlineHeader } from "./format.js";
import type { Filesystem, WriteResult } from "./fs.js";
import { isNotFound } from "./fs.js";
import type { Patch, PatchSection } from "./input.js";
import { HEADTAIL_DRIFT_WARNING, missingSnapshotTagMessage } from "./messages.js";
import { MismatchError } from "./mismatch.js";
import { detectLineEnding, type LineEnding, normalizeToLF, restoreLineEndings, stripBom } from "./normalize.js";
import { Recovery, type RecoveryResult } from "./recovery.js";
import type { SnapshotStore } from "./snapshots.js";
import type { ApplyResult, BlockResolution, BlockResolver, Edit } from "./types.js";

export interface PatcherOptions {
	/** Storage backend used for all reads and writes. */
	fs: Filesystem;
	/** Snapshot store that minted and resolves hashline section tags. Required. */
	snapshots: SnapshotStore;
	/**
	 * Resolves `replace block N:` anchors to concrete line spans via tree-sitter.
	 * Optional: when omitted, any `replace block N:` edit throws on apply (the
	 * host did not wire a resolver). Plain line-range ops never need it.
	 */
	blockResolver?: BlockResolver;
}

/** Per-section result returned by {@link Patcher.apply} / {@link Patcher.commit}. */
export interface PatchSectionResult {
	/** Section path (as authored, after cwd-resolution at parse time). */
	path: string;
	/** Filesystem-canonical key for this section (e.g. absolute path). */
	canonicalPath: string;
	/** `"noop"` when the apply produced no change; otherwise `"create"` / `"update"`. */
	op: "create" | "update" | "noop";
	/** Pre-edit text (LF-normalized, BOM-stripped). */
	before: string;
	/** Post-edit text (LF-normalized, BOM-stripped). For `"noop"` equals `before`. */
	after: string;
	/** Same text as `after` but with the original BOM and line ending restored. */
	persisted: string;
	/** Final text that the {@link Filesystem} actually wrote (may differ if the FS transformed it). */
	written: string;
	/** 4-hex content-hash tag for `after`. Use to anchor follow-up edits. */
	fileHash: string;
	/** Hashline section header (`[path#tag]`) of the post-edit content. */
	header: string;
	/** 1-indexed first changed line in `after`, or `undefined` for noops. */
	firstChangedLine?: number;
	/** Warnings collected by the parser, applier, and (optionally) recovery. */
	warnings: string[];
	/**
	 * Resolved spans for any `replace block`/`delete block` ops, present when the
	 * apply matched the tagged content. Undefined for patches with no block ops
	 * (and for resolutions routed through drift recovery, where numbers shift).
	 */
	blockResolutions?: BlockResolution[];
}

export interface PatcherApplyResult {
	sections: PatchSectionResult[];
}

/**
 * Opaque token returned by {@link Patcher.prepare}. Carries the section, the
 * raw file content read off disk, and the in-memory apply result.
 * {@link Patcher.commit} just writes the {@link PreparedSection.applyResult}.
 */
export class PreparedSection {
	readonly section: PatchSection;
	readonly canonicalPath: string;
	readonly exists: boolean;
	readonly rawContent: string;
	readonly bom: string;
	readonly lineEnding: LineEnding;
	readonly normalized: string;
	readonly applyResult: ApplyResult;
	readonly parseWarnings: readonly string[];
	/** @internal */
	constructor(
		section: PatchSection,
		canonicalPath: string,
		exists: boolean,
		rawContent: string,
		bom: string,
		lineEnding: LineEnding,
		normalized: string,
		applyResult: ApplyResult,
		parseWarnings: readonly string[],
	) {
		this.section = section;
		this.canonicalPath = canonicalPath;
		this.exists = exists;
		this.rawContent = rawContent;
		this.bom = bom;
		this.lineEnding = lineEnding;
		this.normalized = normalized;
		this.applyResult = applyResult;
		this.parseWarnings = parseWarnings;
	}

	/** Convenience: returns true when the apply produced no change. */
	get isNoop(): boolean {
		return this.applyResult.text === this.normalized;
	}
}

function hasAnchorScopedEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => {
		if (edit.kind === "delete") return true;
		// A `replace block N:` edit anchors to concrete content on line N.
		if (edit.kind === "block") return true;
		return edit.cursor.kind === "before_anchor" || edit.cursor.kind === "after_anchor";
	});
}

function assertSectionHashPresent(sectionPath: string, fileHash: string | undefined): void {
	if (fileHash !== undefined) return;
	throw new Error(missingSnapshotTagMessage(sectionPath));
}

function recoveryToApplyResult(result: RecoveryResult): ApplyResult {
	return {
		text: result.text,
		firstChangedLine: result.firstChangedLine,
		warnings: result.warnings,
	};
}
function mergeWarnings(...sources: ReadonlyArray<readonly string[] | undefined>): string[] {
	const out: string[] = [];
	for (const source of sources) {
		if (!source) continue;
		for (const warning of source) out.push(warning);
	}
	return out;
}

function assertUniqueCanonicalPaths(prepared: readonly PreparedSection[]): void {
	const seen = new Map<string, string>();
	for (const entry of prepared) {
		const previous = seen.get(entry.canonicalPath);
		if (previous !== undefined) {
			throw new Error(
				`Multiple hashline sections resolve to the same file (${previous} and ${entry.section.path}). Merge their ops under one header before applying.`,
			);
		}
		seen.set(entry.canonicalPath, entry.section.path);
	}
}

/**
 * High-level patcher. Wires a {@link Filesystem} and a required
 * {@link SnapshotStore} together with the parsing + applying core.
 *
 * Construct once per FS configuration; reuse across patches.
 */
export class Patcher {
	readonly fs: Filesystem;
	readonly snapshots: SnapshotStore;
	readonly recovery: Recovery;
	readonly blockResolver: BlockResolver | undefined;

	constructor(options: PatcherOptions) {
		if (!options.snapshots) {
			throw new Error("Hashline Patcher requires a SnapshotStore; section tags are opaque store pointers.");
		}
		this.fs = options.fs;
		this.snapshots = options.snapshots;
		this.recovery = new Recovery(options.snapshots);
		this.blockResolver = options.blockResolver;
	}

	/**
	 * Apply every section in `patch`. `prepare` runs the full apply for each
	 * section in memory before any write hits the filesystem, so a
	 * multi-section batch fails before writing on parse/validation/apply errors.
	 * Write commits are sequential rather than transactional; if a write fails,
	 * earlier sections may already be on disk and are listed in the thrown error.
	 * Returns one {@link PatchSectionResult} per section in the original patch order.
	 */
	async apply(patch: Patch): Promise<PatcherApplyResult> {
		// Single-section fast path.
		if (patch.sections.length === 1) {
			const prepared = await this.prepare(patch.sections[0]);
			return { sections: [await this.commit(prepared)] };
		}

		// Prepare every section first so any failure (stale hash, missing
		// file, parse error, in-memory no-op) surfaces before any write.
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section));
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) {
				throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}
		}

		const results: PatchSectionResult[] = [];
		for (let index = 0; index < prepared.length; index++) {
			try {
				results.push(await this.commit(prepared[index]));
			} catch (error) {
				// A mid-batch write failure leaves earlier sections on disk with no
				// rollback; report exactly which sections landed so the caller can
				// re-issue only the missing ones instead of double-applying.
				const written = prepared.slice(0, index).map(entry => entry.section.path);
				const notWritten = prepared.slice(index + 1).map(entry => entry.section.path);
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(
					`Failed to write ${prepared[index].section.path}: ${message}` +
						(written.length > 0 ? ` Sections already written: ${written.join(", ")}.` : "") +
						(notWritten.length > 0 ? ` Sections not written: ${notWritten.join(", ")}.` : ""),
					{ cause: error },
				);
			}
		}
		return { sections: results };
	}

	/**
	 * Run the preflight pass only: read, parse, validate, apply-in-memory.
	 * No writes hit the filesystem. Use for CI checks and dry runs.
	 */
	async preflight(patch: Patch): Promise<void> {
		const prepared: PreparedSection[] = [];
		for (const section of patch.sections) prepared.push(await this.prepare(section));
		assertUniqueCanonicalPaths(prepared);
		for (const entry of prepared) {
			if (entry.isNoop) {
				throw new Error(`Edits to ${entry.section.path} resulted in no changes being made.`);
			}
		}
	}

	/**
	 * Read a section's target file, parse the section, validate the snapshot
	 * tag (with recovery), and apply the edits in memory. Returns a
	 * {@link PreparedSection} which can be fed to {@link commit} to land
	 * the result on the filesystem.
	 *
	 * Throws on parse error, missing-file-for-anchored-edit, or unrecovered
	 * tag mismatch ({@link MismatchError}).
	 */
	async prepare(section: PatchSection): Promise<PreparedSection> {
		const { edits, warnings: parseWarnings } = section.parse();
		assertSectionHashPresent(section.path, section.fileHash);

		const canonicalPath = this.fs.canonicalPath(section.path);
		await this.fs.preflightWrite(section.path);
		const { exists, rawContent } = await this.#tryRead(section.path);
		if (!exists) {
			throw new Error(`File not found: ${section.path}. Use the write tool to create new files.`);
		}

		const { bom, text } = stripBom(rawContent);
		const lineEnding = detectLineEnding(text);
		const normalized = normalizeToLF(text);

		const applyResult = this.#applyWithRecovery({
			section,
			canonicalPath,
			exists,
			normalized,
			edits,
		});

		return new PreparedSection(
			section,
			canonicalPath,
			exists,
			rawContent,
			bom,
			lineEnding,
			normalized,
			applyResult,
			parseWarnings,
		);
	}

	/**
	 * Commit a previously {@link prepare}d section to the filesystem.
	 * Restores line endings and BOM, writes via the {@link Filesystem}, and
	 * records a fresh snapshot in the {@link SnapshotStore} keyed by the
	 * filesystem-canonical path.
	 */
	async commit(prepared: PreparedSection): Promise<PatchSectionResult> {
		const { section, normalized, bom, lineEnding, parseWarnings, exists, applyResult, canonicalPath } = prepared;
		const after = applyResult.text;
		const warnings = mergeWarnings(parseWarnings, applyResult.warnings);

		if (after === normalized) {
			const hash = this.#recordFullSnapshot(canonicalPath, normalized);
			return {
				path: section.path,
				canonicalPath,
				op: "noop",
				before: normalized,
				after: normalized,
				persisted: prepared.rawContent,
				written: prepared.rawContent,
				fileHash: hash,
				header: formatHashlineHeader(section.path, hash),
				warnings,
			};
		}

		const persisted = bom + restoreLineEndings(after, lineEnding);
		const write: WriteResult = await this.fs.writeText(section.path, persisted);
		const fileHash = this.#recordFullSnapshot(canonicalPath, after);
		const op = exists ? "update" : "create";

		return {
			path: section.path,
			canonicalPath,
			op,
			before: normalized,
			after,
			persisted,
			written: write.text,
			fileHash,
			header: formatHashlineHeader(section.path, fileHash),
			firstChangedLine: applyResult.firstChangedLine,
			blockResolutions: applyResult.blockResolutions,
			warnings,
		};
	}

	async #tryRead(path: string): Promise<{ exists: boolean; rawContent: string }> {
		try {
			const content = await this.fs.readText(path);
			return { exists: true, rawContent: content };
		} catch (error) {
			if (isNotFound(error)) return { exists: false, rawContent: "" };
			throw error;
		}
	}

	#recordFullSnapshot(canonicalPath: string, normalized: string): string {
		return this.snapshots.record(canonicalPath, normalized);
	}
	#mismatchError(
		section: PatchSection,
		canonicalPath: string,
		normalized: string,
		expected: string,
		hashRecognized: boolean,
	): MismatchError {
		const actualFileHash = this.#recordFullSnapshot(canonicalPath, normalized);
		return new MismatchError({
			path: section.path,
			expectedFileHash: expected,
			actualFileHash,
			fileLines: normalized.split("\n"),
			anchorLines: section.collectAnchorLines(),
			hashRecognized,
		});
	}

	#applyWithRecovery(args: {
		section: PatchSection;
		canonicalPath: string;
		exists: boolean;
		normalized: string;
		edits: readonly Edit[];
	}): ApplyResult {
		const { section, canonicalPath, exists, normalized, edits } = args;
		const expected = exists ? section.fileHash : undefined;
		const expectedSnapshot = expected === undefined ? null : this.snapshots.byHash(canonicalPath, expected);
		const liveHashMatches = expected !== undefined && computeFileHash(normalized) === expected;
		const liveSnapshot = expected === undefined ? null : this.snapshots.byHashAndText(canonicalPath, expected, normalized);
		const liveMatches = liveHashMatches && liveSnapshot !== null;
		if (liveHashMatches && !liveMatches) {
			throw this.#mismatchError(section, canonicalPath, normalized, expected, expectedSnapshot !== null);
		}

		// Resolve `replace block N:` edits to concrete ranges before recovery
		// runs. Block anchors are expressed against the snapshot the section tag
		// names, so resolve against that exact text:
		//   - live content matches the tag (or there is no tag) → resolve against
		//     the live, normalized content;
		//   - the file drifted → resolve against the tagged snapshot's text so the
		//     resulting ranges flow through the 3-way-merge recovery below.
		// When a block edit needs the tagged snapshot but it is unavailable, the
		// range cannot be placed safely — reject with a MismatchError (re-read).
		const blockResolutions: BlockResolution[] = [];
		const resolveWarnings: string[] = [];
		let resolved: readonly Edit[] = edits;
		if (hasBlockEdit(edits)) {
			const baseText =
				expected === undefined || liveMatches ? normalized : expectedSnapshot?.text;
			if (baseText === undefined) {
				throw this.#mismatchError(section, canonicalPath, normalized, expected ?? "", false);
			}
			resolved = resolveBlockEdits(edits, baseText, section.path, this.blockResolver, {
				onUnresolved: "throw",
				onResolved: resolution => blockResolutions.push(resolution),
				onWarning: warning => resolveWarnings.push(warning),
			});
		}
		const withResolveWarnings = (result: ApplyResult): ApplyResult =>
			resolveWarnings.length === 0
				? result
				: { ...result, warnings: [...resolveWarnings, ...(result.warnings ?? [])] };

		// No tag, or the tag still names the live content: an edit anchored at any
		// line is safe to apply, and the resolved block spans line up with what
		// the caller read, so echo them back. (A drifted file falls through to
		// recovery below, where line numbers shift, so resolutions are dropped.)
		if (expected === undefined || liveMatches) {
			const result = applyEdits(normalized, resolved);
			return withResolveWarnings(blockResolutions.length > 0 ? { ...result, blockResolutions } : result);
		}
		// Head/tail-only inserts are position-stable: "start"/"end" cannot move
		// with content drift, so a stale tag is non-fatal. Apply onto the live
		// content and warn instead of hard-failing — unlike an anchored
		// mismatch, which cannot be safely relocated and must reject.
		if (!hasAnchorScopedEdit(resolved)) {
			const result = applyEdits(normalized, resolved);
			return withResolveWarnings({ ...result, warnings: [HEADTAIL_DRIFT_WARNING, ...(result.warnings ?? [])] });
		}
		// File drifted: try to replay the edit against the version the tag
		// names and 3-way-merge it onto the live content.
		const recovered = this.recovery.tryRecover({
			path: canonicalPath,
			currentText: normalized,
			fileHash: expected,
			edits: resolved,
		});
		if (recovered) return withResolveWarnings(recoveryToApplyResult(recovered));
		const hashRecognized = expectedSnapshot !== null;
		throw this.#mismatchError(section, canonicalPath, normalized, expected, hashRecognized);
	}
}

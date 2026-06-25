// @generated vendored verbatim from oh-my-pi packages/hashline @ 15b5c1397fc -- DO NOT EDIT.
// Parity source for the Atomic hashline edit engine (issue #1483); adapted only for Atomic's Node runtime (relative imports, Bun->Node host calls, erasable constructor syntax).
/**
 * Expand deferred block edits (`replace block N:` / `delete block N` /
 * `insert after block N:`) into concrete inserts + deletes.
 *
 * The hashline parser cannot expand a block edit on its own — the line span is
 * unknown until file text + path (→ language) are available. This transform
 * runs at every apply/preview boundary that has text: it calls the injected
 * {@link BlockResolver} to resolve each block's `[start, end]` span, then emits
 * the exact same edits the concrete form produces in the parser: `replace
 * start..end:` inserts + deletes for a replace, a pure range delete for a
 * delete, and plain `after_anchor` inserts at `end` for an insert-after. After
 * it runs, no `block` edits remain, so {@link applyEdits} (and recovery) only
 * ever see resolved edits.
 */
import { STRUCTURAL_CLOSER_RE } from "./apply.js";
import {
	BLOCK_RESOLVER_UNAVAILABLE,
	blockUnresolvedMessage,
	insertAfterBlockCloserLoweredWarning,
	insertAfterBlockUnresolvedLoweredWarning,
} from "./messages.js";
import type { BlockResolution, BlockResolver, Cursor, Edit } from "./types.js";

export interface ResolveBlockEditsOptions {
	/**
	 * How to handle a replace/delete block edit that cannot be resolved
	 * (missing resolver or a `null` span). `"throw"` (default) raises a
	 * `blockUnresolvedMessage` error — used by the authoritative apply + final
	 * preview paths. `"drop"` silently skips the edit — used by the streaming
	 * preview, where a half-written file or transient parse error must not
	 * throw. Unresolvable `insert after block N:` edits never reach this: they
	 * are lowered to plain `insert after N:` with a warning.
	 */
	onUnresolved?: "throw" | "drop";
	/**
	 * Invoked once per successfully resolved block edit, in patch order, with
	 * the anchor line and the concrete span it resolved to. Lets the host echo
	 * the resolution back to the caller. Never fired for dropped/unresolvable
	 * edits.
	 */
	onResolved?: (resolution: BlockResolution) => void;
	/**
	 * Invoked once per diagnostic produced while resolving — currently the
	 * `insert after block N:` lowerings (closer anchor or unresolvable block).
	 * Hosts should surface these on the apply result's `warnings`.
	 */
	onWarning?: (message: string) => void;
}

/** True when at least one edit is an unresolved deferred block edit. */
export function hasBlockEdit(edits: readonly Edit[]): boolean {
	return edits.some(edit => edit.kind === "block");
}

/**
 * Resolve every deferred block edit in `edits` against `text` (parsed as the
 * language inferred from `path`). Non-block edits pass through untouched.
 * Returns a fresh edit list with no `block` variants. The fast path returns the
 * input unchanged when there is nothing to resolve.
 *
 * Synthesized inserts/deletes carry sequential `index` values for readability
 * only — {@link applyEdits} re-derives every edit's index from array order, so
 * the passthrough edits keeping their original indices is harmless.
 */
export function resolveBlockEdits(
	edits: readonly Edit[],
	text: string,
	path: string,
	resolver: BlockResolver | undefined,
	options: ResolveBlockEditsOptions = {},
): readonly Edit[] {
	if (!hasBlockEdit(edits)) return edits;
	const onUnresolved = options.onUnresolved ?? "throw";
	const resolved: Edit[] = [];
	let synthIndex = 0;
	for (const edit of edits) {
		if (edit.kind !== "block") {
			resolved.push(edit);
			continue;
		}
		const op = edit.mode === "insert_after" ? "insert_after" : edit.payloads.length === 0 ? "delete" : "replace";
		const span = resolver ? resolver({ path, text, line: edit.anchor.line }) : null;
		if (span === null) {
			// `insert after block N:` never fails the patch — lower it to plain
			// `insert after N:` with a warning instead. Two flavors:
			// - anchored on a pure closing-delimiter line: no block begins
			//   there, but line N IS the end of one, and "after the end of the
			//   block" is exactly the plain form — warn with the opener rule.
			// - otherwise (unsupported language, blank line, unparsable block,
			//   or no resolver wired): "after the block at N" degrades to
			//   "after line N" — warn to verify the landing line.
			if (op === "insert_after") {
				const anchorText = text.split("\n")[edit.anchor.line - 1];
				const isCloser = anchorText !== undefined && STRUCTURAL_CLOSER_RE.test(anchorText);
				options.onWarning?.(
					isCloser
						? insertAfterBlockCloserLoweredWarning(edit.anchor.line)
						: insertAfterBlockUnresolvedLoweredWarning(edit.anchor.line),
				);
				for (const payload of edit.payloads) {
					const cursor: Cursor = { kind: "after_anchor", anchor: { line: edit.anchor.line } };
					resolved.push({ kind: "insert", cursor, text: payload, lineNum: edit.lineNum, index: synthIndex++ });
				}
				continue;
			}
			if (onUnresolved === "drop") continue;
			throw new Error(
				`line ${edit.lineNum}: ${
					resolver ? blockUnresolvedMessage(edit.anchor.line, op, text.split("\n")) : BLOCK_RESOLVER_UNAVAILABLE
				}`,
			);
		}
		options.onResolved?.({
			anchorLine: edit.anchor.line,
			start: span.start,
			end: span.end,
			op,
		});
		if (op === "insert_after") {
			// Mirror the parser's `insert after N:` lowering: one `after_anchor`
			// insert per payload row, anchored on the block's last line. The
			// `blockStart` tag lets the applier's landing correction slide a
			// body that claims a depth inside the block back across the block's
			// trailing closer lines.
			for (const payload of edit.payloads) {
				const cursor: Cursor = { kind: "after_anchor", anchor: { line: span.end } };
				resolved.push({
					kind: "insert",
					cursor,
					text: payload,
					lineNum: edit.lineNum,
					index: synthIndex++,
					blockStart: span.start,
				});
			}
			continue;
		}
		// Mirror the parser's `replace start..end:` expansion exactly: one
		// `before_anchor` replacement insert per payload row at `span.start`,
		// then one delete per line across `[span.start, span.end]`. An empty
		// `payloads` (from `delete block N`) emits no inserts — a pure deletion.
		for (const payload of edit.payloads) {
			const cursor: Cursor = { kind: "before_anchor", anchor: { line: span.start } };
			resolved.push({
				kind: "insert",
				cursor,
				text: payload,
				lineNum: edit.lineNum,
				index: synthIndex++,
				mode: "replacement",
			});
		}
		for (let line = span.start; line <= span.end; line++) {
			resolved.push({ kind: "delete", anchor: { line }, lineNum: edit.lineNum, index: synthIndex++ });
		}
	}
	return resolved;
}

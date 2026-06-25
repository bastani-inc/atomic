// @generated vendored from oh-my-pi packages/hashline @ 15b5c1397fc with Atomic parity adaptations -- DO NOT EDIT.
// Parity source for the Atomic hashline edit engine (issue #1483); adapted for Atomic's Node runtime plus CR-only line-ending round trips.
/**
 * Minimal text-shape normalization: line-ending detection / round-trip and
 * BOM stripping. The patcher uses these to canonicalize text to LF before
 * applying edits and to restore the original shape on write-back.
 */

export type LineEnding = "\r\n" | "\n" | "\r";

/** Detect the first line ending style in `content`. Defaults to LF when neither is present. */
export function detectLineEnding(content: string): LineEnding {
	for (let i = 0; i < content.length; i++) {
		const ch = content[i];
		if (ch === "\n") return "\n";
		if (ch === "\r") return content[i + 1] === "\n" ? "\r\n" : "\r";
	}
	return "\n";
}

/** Normalize every line ending to LF. */
export function normalizeToLF(text: string): string {
	return text.replace(/\r\n?/g, "\n");
}

/** Re-encode LF text with the requested line ending. */
export function restoreLineEndings(text: string, ending: LineEnding): string {
	if (ending === "\r\n") return text.replace(/\n/g, "\r\n");
	return ending === "\r" ? text.replace(/\n/g, "\r") : text;
}

export interface BomResult {
	/** Either the empty string or the BOM sequence (currently UTF-8 BOM). */
	bom: string;
	/** Text with any leading BOM removed. */
	text: string;
}

/** Strip a UTF-8 BOM if present and return both the BOM and the trailing text. */
export function stripBom(content: string): BomResult {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

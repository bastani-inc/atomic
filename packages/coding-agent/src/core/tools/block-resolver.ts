/**
 * Host-provided block resolver for the hashline engine.
 *
 * Resolves `replace block N:` / `delete block N` / `insert after block N:`
 * anchors with the Rust tree-sitter `blockRangeAt` primitive in
 * `@bastani/atomic-natives` (mirrors oh-my-pi's native resolver): it infers the
 * language from the path and returns the 1-indexed line span of the syntactic
 * block beginning on line N, or `null` when none resolves (blank line, pure
 * closing delimiter, unsupported language, or a syntax error in the subtree).
 * A small brace/indent heuristic is used only when the native binding is
 * unavailable.
 */
import type { BlockResolver, BlockResolverRequest, BlockSpan } from "./hashline-engine/index.ts";
import { loadNativeSearchBinding } from "./search-native.ts";

const PURE_CLOSER_RE = /^[)\]}]+[;,]?\s*$/;

/** Strip line comments and same-line string literals so delimiters inside them are not counted. */
function stripNonCode(line: string): string {
	let out = "";
	let quote = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i]!;
		if (quote) {
			if (ch === "\\") { i++; continue; }
			if (ch === quote) quote = "";
			continue;
		}
		if (ch === '"' || ch === "'" || ch === "`") { quote = ch; continue; }
		if (ch === "/" && line[i + 1] === "/") break;
		if (ch === "#") break;
		out += ch;
	}
	return out;
}

/** Fallback: resolve a brace-delimited block by `{`/`}` balance, or an indented block. */
function heuristicResolve(request: BlockResolverRequest): BlockSpan | null {
	const lines = request.text.split("\n");
	const startIndex = request.line - 1;
	const opener = lines[startIndex];
	if (opener === undefined || opener.trim() === "" || PURE_CLOSER_RE.test(opener.trim())) return null;
	if (stripNonCode(opener).includes("{")) {
		let balance = 0;
		for (let i = startIndex; i < lines.length; i++) {
			for (const ch of stripNonCode(lines[i]!)) {
				if (ch === "{") balance++;
				else if (ch === "}") { balance--; if (balance === 0) return { start: request.line, end: i + 1 }; }
			}
		}
		return null;
	}
	const baseIndent = opener.length - opener.trimStart().length;
	let end = startIndex;
	for (let i = startIndex + 1; i < lines.length; i++) {
		const line = lines[i]!;
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		if (indent <= baseIndent) break;
		end = i;
	}
	return end > startIndex ? { start: request.line, end: end + 1 } : null;
}

/** Tree-sitter-backed block resolver wired into the hashline {@link Patcher}. */
export const nativeBlockResolver: BlockResolver = (request: BlockResolverRequest): BlockSpan | null => {
	const native = loadNativeSearchBinding();
	if (native?.blockRangeAt) {
		const range = native.blockRangeAt({ code: request.text, path: request.path, line: request.line });
		return range ? { start: range.startLine, end: range.endLine } : null;
	}
	return heuristicResolve(request);
};

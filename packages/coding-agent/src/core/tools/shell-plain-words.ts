export type ShellDialect = "posix" | "powershell";

/** `paren` is a `$(…)` substitution or a `(` inside one, and `param` a `${…}` parameter expansion. */
type Nesting = "double" | "paren" | "param" | "backtick";

/** PowerShell delimits strings with typographic quotes too: ‘ ’ ‚ ‛ like `'`, and “ ” „ like `"`. */
const POWERSHELL_SINGLE_QUOTES = "'\u2018\u2019\u201a\u201b";
const POWERSHELL_DOUBLE_QUOTES = '"\u201c\u201d\u201e';

interface PendingHeredoc {
	readonly tag: string;
	readonly stripTabs: boolean;
}

/** Whether a word starts at `index`: a shell word ends at whitespace and at every operator character. */
function isWordBoundary(text: string, index: number): boolean {
	return index === 0 || /[\s;|&()<>]/.test(text[index - 1] ?? "");
}

function readHeredocTag(text: string, from: number): { tag: string; end: number } | undefined {
	let index = from;
	while (text[index] === " " || text[index] === "\t") index++;
	const quote = text[index] === "'" || text[index] === '"' ? text[index] : undefined;
	if (quote) {
		const close = text.indexOf(quote, index + 1);
		return close < 0 ? undefined : { tag: text.slice(index + 1, close), end: close + 1 };
	}
	const start = index;
	if (text[index] === "\\") index++;
	while (index < text.length && /[A-Za-z0-9_.-]/.test(text[index] ?? "")) index++;
	const tag = text.slice(start, index).replace(/^\\/, "");
	return tag ? { tag, end: index } : undefined;
}

function skipHeredocBodies(text: string, from: number, pending: PendingHeredoc[]): number {
	let cursor = from;
	for (const { tag, stripTabs } of pending) {
		while (cursor < text.length) {
			const lineEnd = text.indexOf("\n", cursor);
			const end = lineEnd < 0 ? text.length : lineEnd;
			const line = text.slice(cursor, end);
			cursor = lineEnd < 0 ? text.length : lineEnd + 1;
			if ((stripTabs ? line.replace(/^\t+/, "") : line) === tag) break;
		}
	}
	return cursor;
}

/**
 * Marks, for each character of `text`, whether it sits in a plain shell word: outside quotes, escapes, command
 * substitutions, heredoc bodies and comments. This is a scanner for that one question, not a shell parser; whatever
 * it cannot classify stays unmarked, so callers leave it unchanged. Where the shell reads text without word quoting
 * (arithmetic, array subscripts and compound array assignments in POSIX shells, PowerShell's stop-parsing token)
 * nothing from there to the end of `text` is plain.
 */
export function plainShellWordMask(text: string, dialect: ShellDialect = "posix"): Uint8Array {
	const mask = new Uint8Array(text.length);
	const powershell = dialect === "powershell";
	const escapeChar = powershell ? "`" : "\\";
	const singleQuotes = powershell ? POWERSHELL_SINGLE_QUOTES : "'";
	const doubleQuotes = powershell ? POWERSHELL_DOUBLE_QUOTES : '"';
	const nesting: Nesting[] = [];
	const heredocs: PendingHeredoc[] = [];
	let single = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] ?? "";
		const next = text[index + 1] ?? "";
		if (single) {
			if (singleQuotes.includes(char)) single = false;
			continue;
		}
		const top = nesting.at(-1);
		if (char === escapeChar) {
			index++;
			continue;
		}
		if (powershell && top !== "double" && text.startsWith("--%", index)) break;
		if (char === "\n" && heredocs.length > 0 && top === undefined) {
			index = skipHeredocBodies(text, index + 1, heredocs.splice(0)) - 1;
			continue;
		}
		if (powershell && top !== "double" && char === "<" && next === "#") {
			const close = text.indexOf("#>", index + 2);
			if (close < 0) break;
			index = close + 1;
			continue;
		}
		// PowerShell starts a comment at a `#` after most tokens, not only between words, so every `#` starts one.
		if (top !== "double" && char === "#" && (powershell || isWordBoundary(text, index))) {
			while (index < text.length && text[index] !== "\n") index++;
			index--;
			continue;
		}
		if (powershell && char === "@" && next && (singleQuotes.includes(next) || doubleQuotes.includes(next))) {
			const hereString = /^@.[ \t]*\r?\n/.exec(text.slice(index));
			if (hereString) {
				// The body ends at a line that starts with a quote of the same kind followed by `@`.
				const closer = new RegExp(`\\n[${singleQuotes.includes(next) ? singleQuotes : doubleQuotes}]@`, "g");
				closer.lastIndex = index + hereString[0].length - 1;
				const close = closer.exec(text);
				if (!close) break;
				index = close.index + 2;
				continue;
			}
		}
		if (singleQuotes.includes(char) && top !== "double") {
			single = true;
			continue;
		}
		if (doubleQuotes.includes(char)) {
			if (top === "double") nesting.pop();
			else nesting.push("double");
			continue;
		}
		if (!powershell && char === "$" && next === "'" && top !== "double") {
			index += 2;
			while (index < text.length && text[index] !== "'") index += text[index] === "\\" ? 2 : 1;
			continue;
		}
		if (char === "$" && (next === "(" || next === "{")) {
			nesting.push(next === "(" ? "paren" : "param");
			index++;
			continue;
		}
		if (!powershell && char === "`") {
			if (top === "backtick") nesting.pop();
			else nesting.push("backtick");
			continue;
		}
		if (top === "paren") {
			// Braces inside a substitution are words or groups of its command, such as `{a,b}` or a literal `{`, and
			// never end it.
			if (char === ")") nesting.pop();
			else if (char === "(") nesting.push("paren");
			continue;
		}
		if (top === "param") {
			// A parameter expansion ends at its first `}`; parentheses and braces before it are its text.
			if (char === "}") nesting.pop();
			continue;
		}
		if (top !== undefined) continue;
		if (!powershell) {
			// `((…))` and `=(…)` hold arithmetic and array subscripts, which expand `$(…)` even inside quotes.
			if (char === "(" && (next === "(" || text[index - 1] === "=")) break;
			// Only the test commands `[` and `[[` are words; any other `[` opens a subscript, `$[…]` or a pattern.
			if (char === "[") {
				const test = isWordBoundary(text, index) ? /^\[\[?(?=\s)/.exec(text.slice(index)) : null;
				if (!test) break;
				index += test[0].length - 1;
				continue;
			}
			if (char === "<" && next === "<" && text[index + 2] !== "<") {
				const stripTabs = text[index + 2] === "-";
				const heredoc = readHeredocTag(text, index + (stripTabs ? 3 : 2));
				if (heredoc) {
					heredocs.push({ tag: heredoc.tag, stripTabs });
					index = heredoc.end - 1;
					continue;
				}
			}
		}
		// Braces can join a URL to a brace expansion or group, so a token touching one is not a plain word.
		if (char === "{" || char === "}") continue;
		mask[index] = 1;
	}
	return mask;
}

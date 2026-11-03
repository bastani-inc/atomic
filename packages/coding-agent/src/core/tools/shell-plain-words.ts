export type ShellDialect = "posix" | "powershell";

type Nesting = "double" | "substitution" | "backtick";

interface PendingHeredoc {
	readonly tag: string;
	readonly stripTabs: boolean;
}

function isWordBoundary(text: string, index: number): boolean {
	return index === 0 || /[\s;|&(]/.test(text[index - 1] ?? "");
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
 * it cannot classify stays unmarked, so callers leave it unchanged.
 */
export function plainShellWordMask(text: string, dialect: ShellDialect = "posix"): Uint8Array {
	const mask = new Uint8Array(text.length);
	const escapeChar = dialect === "powershell" ? "`" : "\\";
	const nesting: Nesting[] = [];
	const heredocs: PendingHeredoc[] = [];
	let single = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index] ?? "";
		const next = text[index + 1];
		if (single) {
			if (char === "'") single = false;
			continue;
		}
		const top = nesting.at(-1);
		if (char === escapeChar) {
			index++;
			continue;
		}
		if (char === "\n" && heredocs.length > 0 && top === undefined) {
			index = skipHeredocBodies(text, index + 1, heredocs.splice(0)) - 1;
			continue;
		}
		if (top !== "double" && char === "#" && isWordBoundary(text, index)) {
			while (index < text.length && text[index] !== "\n") index++;
			index--;
			continue;
		}
		if (dialect === "powershell" && char === "@" && (next === "'" || next === '"')) {
			const hereString = /^@['"][ \t]*\r?\n/.exec(text.slice(index));
			if (hereString) {
				const close = text.indexOf(`\n${next}@`, index + hereString[0].length - 1);
				index = close < 0 ? text.length : close + 2;
				continue;
			}
		}
		if (char === "'" && top !== "double") {
			single = true;
			continue;
		}
		if (char === '"') {
			if (top === "double") nesting.pop();
			else nesting.push("double");
			continue;
		}
		if (dialect === "posix" && char === "$" && next === "'" && top !== "double") {
			index += 2;
			while (index < text.length && text[index] !== "'") index += text[index] === "\\" ? 2 : 1;
			continue;
		}
		if (char === "$" && (next === "(" || next === "{")) {
			nesting.push("substitution");
			index++;
			continue;
		}
		if (dialect === "posix" && char === "`") {
			if (top === "backtick") nesting.pop();
			else nesting.push("backtick");
			continue;
		}
		if (top === "substitution") {
			if (char === ")" || char === "}") nesting.pop();
			else if (char === "(") nesting.push("substitution");
			continue;
		}
		if (top !== undefined) continue;
		if (dialect === "posix" && char === "<" && next === "<" && text[index + 2] !== "<") {
			const stripTabs = text[index + 2] === "-";
			const heredoc = readHeredocTag(text, index + (stripTabs ? 3 : 2));
			if (heredoc) {
				heredocs.push({ tag: heredoc.tag, stripTabs });
				index = heredoc.end - 1;
				continue;
			}
		}
		// Braces can join a URL to a brace expansion or group, so a token touching one is not a plain word.
		if (char === "{" || char === "}") continue;
		mask[index] = 1;
	}
	return mask;
}

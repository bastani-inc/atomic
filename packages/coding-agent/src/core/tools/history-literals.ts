import { normalizeSearchPattern } from "./resource-selectors.ts";

export type LiteralQuery = readonly (readonly string[])[];

const MIN_LITERAL_CHARS = 3;
const MAX_SETS = 16;
const MAX_LITERALS_PER_SET = 8;

type Requirement = string[][] | undefined;

class UnsupportedPattern extends Error {}

function isCasedNonAscii(char: string): boolean {
	return char.codePointAt(0)! > 0x7f && char.toLowerCase() !== char.toUpperCase();
}

function breaksLiteral(char: string, ignoreCase: boolean): boolean {
	const code = char.codePointAt(0)!;
	if (code === 0x0a || code === 0x0d || code === 0x00 || (code >= 0xd800 && code <= 0xdfff)) return true;
	return ignoreCase && isCasedNonAscii(char);
}

function charCount(text: string): number {
	return Array.from(text).length;
}

function andCombine(sets: string[][], required: string[][]): string[][] {
	if (sets.length * required.length > MAX_SETS) return sets;
	return sets.flatMap((set) => required.map((other) => [...set, ...other]));
}

function strongest(set: readonly string[]): string[] {
	return [...new Set(set)].sort((a, b) => charCount(b) - charCount(a)).slice(0, MAX_LITERALS_PER_SET);
}

class PatternReader {
	private readonly chars: string[];
	private index = 0;
	private readonly ignoreCase: boolean;

	constructor(pattern: string, ignoreCase: boolean) {
		this.chars = Array.from(pattern);
		this.ignoreCase = ignoreCase;
	}

	readAll(): Requirement {
		const requirement = this.alternation();
		if (this.index < this.chars.length) throw new UnsupportedPattern();
		return requirement;
	}

	private peek(offset = 0): string | undefined {
		return this.chars[this.index + offset];
	}

	private consume(): string {
		const char = this.chars[this.index++];
		if (char === undefined) throw new UnsupportedPattern();
		return char;
	}

	private alternation(): Requirement {
		const branches: Requirement[] = [this.sequence()];
		while (this.peek() === "|") {
			this.index++;
			branches.push(this.sequence());
		}
		if (branches.some((branch) => branch === undefined)) return undefined;
		const union = (branches as string[][][]).flat();
		return union.length > MAX_SETS ? undefined : union;
	}

	private sequence(): Requirement {
		let sets: string[][] = [[]];
		let run = "";
		const flush = () => {
			if (charCount(run) >= MIN_LITERAL_CHARS) sets = sets.map((set) => [...set, run]);
			run = "";
		};
		for (let next = this.peek(); next !== undefined && next !== "|" && next !== ")"; next = this.peek()) {
			const atom = this.atom();
			const minimum = this.quantifier();
			if (atom.kind === "char" && minimum === undefined && !breaksLiteral(atom.char, this.ignoreCase)) {
				run += atom.char;
				continue;
			}
			flush();
			if (atom.kind === "group" && atom.requirement !== undefined && (minimum ?? 1) >= 1)
				sets = andCombine(sets, atom.requirement);
		}
		flush();
		return sets.some((set) => set.length === 0) ? undefined : sets;
	}

	private quantifier(): number | undefined {
		const next = this.peek();
		let minimum: number | undefined;
		if (next === "*" || next === "?") minimum = 0;
		else if (next === "+") minimum = 1;
		else if (next === "{") {
			const bounds = /^\{(\d+)(?:,(\d*))?\}/.exec(this.chars.slice(this.index, this.index + 24).join(""));
			if (!bounds) return undefined;
			this.index += Array.from(bounds[0]).length;
			minimum = Number(bounds[1]);
			if (this.peek() === "?") this.index++;
			return minimum;
		} else return undefined;
		this.index++;
		if (this.peek() === "?") this.index++;
		return minimum;
	}

	private atom(): { kind: "char"; char: string } | { kind: "group"; requirement: Requirement } | { kind: "any" } {
		const char = this.consume();
		switch (char) {
			case "\\":
				return this.escape();
			case "[":
				this.characterClass();
				return { kind: "any" };
			case "(":
				return this.group();
			case ".":
			case "^":
			case "$":
			case "{":
				return { kind: "any" };
			case "*":
			case "+":
			case "?":
				throw new UnsupportedPattern();
			default:
				return { kind: "char", char };
		}
	}

	private escape(): { kind: "char"; char: string } | { kind: "any" } {
		const char = this.consume();
		if (/^[^A-Za-z0-9]$/.test(char)) return { kind: "char", char };
		if (char === "t") return { kind: "char", char: "\t" };
		if (/^[0-9]$/.test(char)) {
			while (/^[0-9]$/.test(this.peek() ?? "")) this.index++;
			return { kind: "any" };
		}
		if (char === "x" || char === "u") {
			if (this.peek() === "{") this.skipPast("}");
			else
				for (let digits = 0; digits < (char === "x" ? 2 : 4) && /^[0-9A-Fa-f]$/.test(this.peek() ?? ""); digits++)
					this.index++;
			return { kind: "any" };
		}
		if (char === "p" || char === "P") {
			if (this.peek() === "{") this.skipPast("}");
			else this.consume();
			return { kind: "any" };
		}
		if (char === "k" && this.peek() === "<") {
			this.skipPast(">");
			return { kind: "any" };
		}
		if (char === "c") {
			this.consume();
			return { kind: "any" };
		}
		return { kind: "any" };
	}

	private skipPast(closing: string): void {
		while (this.consume() !== closing);
	}

	private characterClass(): void {
		if (this.peek() === "^") this.index++;
		if (this.peek() === "]") throw new UnsupportedPattern();
		for (;;) {
			const char = this.consume();
			if (char === "\\") this.consume();
			else if (char === "[") throw new UnsupportedPattern();
			else if (char === "]") return;
		}
	}

	private group(): { kind: "group"; requirement: Requirement } | { kind: "any" } {
		let lookaround = false;
		if (this.peek() === "?") {
			this.index++;
			const marker = this.consume();
			if (marker === "=" || marker === "!") lookaround = true;
			else if (marker === "<" && (this.peek() === "=" || this.peek() === "!")) {
				this.index++;
				lookaround = true;
			} else if (marker === "<" || marker === "'") this.skipPast(marker === "<" ? ">" : "'");
			else if (marker === "P" && this.peek() === "<") this.skipPast(">");
			else if (marker !== ":") {
				let flags = marker;
				while (this.peek() !== ")" && this.peek() !== ":") flags += this.consume();
				if (/[^imsU-]/.test(flags)) throw new UnsupportedPattern();
				if (this.consume() === ")") return { kind: "any" };
			}
		}
		const requirement = this.alternation();
		if (this.consume() !== ")") throw new UnsupportedPattern();
		return lookaround ? { kind: "any" } : { kind: "group", requirement };
	}
}

export function indexLiterals(pattern: string, ignoreCase: boolean, literal: boolean): LiteralQuery | undefined {
	const normalized = normalizeSearchPattern(pattern, ignoreCase);
	const folded = normalized.flags.includes("i");
	if (literal) {
		const runs: string[] = [];
		let run = "";
		for (const char of normalized.pattern) {
			if (breaksLiteral(char, folded)) {
				runs.push(run);
				run = "";
			} else run += char;
		}
		runs.push(run);
		const required = runs.filter((text) => charCount(text) >= MIN_LITERAL_CHARS);
		return required.length === 0 ? undefined : [strongest(required)];
	}
	try {
		const requirement = new PatternReader(normalized.pattern, folded).readAll();
		return requirement === undefined || requirement.length === 0 ? undefined : requirement.map(strongest);
	} catch (error) {
		if (error instanceof UnsupportedPattern) return undefined;
		throw error;
	}
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseSource } from "@babel/parser";
import { type Node as SourceNode, traverseFast } from "@babel/types";
import { type AST, RegExpParser } from "@eslint-community/regexpp";
import {
	Chars,
	getConsumedChars,
	getFirstConsumedChar,
	getLengthRange,
	isStrictBackreference,
	type ReadonlyFlags,
	toUnicodeSet,
} from "regexp-ast-analysis";

export type RegexRiskKind = "exponential" | "polynomial";

export interface RegexRisk {
	readonly kind: RegexRiskKind;
	readonly subPattern: string;
	readonly reason: string;
}

export interface RegexSource {
	readonly file: string;
	readonly line: number;
	readonly pattern: string;
	readonly flags: string;
}

const MAX_EXPANDED_OPTIONAL_REPETITIONS = 16;
const MAX_EXPANDED_POSITIONS = 256;
const AMBIGUOUS = 2;
const MAX_PAIRED_EDGES = 4_000_000;

type CharSet = ReturnType<typeof Chars.all>;
type Direction = "ltr" | "rtl";

interface Guard {
	readonly prev: CharSet;
	readonly atStart: boolean;
	readonly next: CharSet;
	readonly atEnd: boolean;
	readonly boundary: "any" | "word" | "nonword";
	readonly conditional: boolean;
}

interface Position {
	readonly chars: CharSet;
	readonly origin: AST.Node;
}

interface Edge {
	readonly from: number;
	readonly to: number;
	readonly label: CharSet;
	readonly prev: CharSet;
	readonly boundary: Guard["boundary"];
	count: number;
	readonly via: AST.Node[];
}

interface Entry {
	readonly position: number;
	readonly guard: Guard;
	readonly count: number;
}

interface EmptyPath {
	readonly guard: Guard;
	readonly count: number;
}

interface Fragment {
	readonly first: readonly Entry[];
	readonly last: readonly Entry[];
	readonly empty: readonly EmptyPath[];
}

interface Context {
	readonly positions: Position[];
	readonly edges: Map<string, Edge>;
	readonly lookarounds: Set<AST.LookaroundAssertion>;
	readonly all: CharSet;
	readonly none: CharSet;
	readonly word: CharSet;
	readonly lineTerminator: CharSet;
	readonly open: Guard;
	readonly reversed: boolean;
}

interface Finding {
	readonly kind: RegexRiskKind;
	readonly start: number;
	readonly end: number;
	readonly reason: string;
}

const parser = new RegExpParser({ ecmaVersion: 2025 });

export function findBacktrackingRisks(pattern: string, flags: string): RegexRisk[] {
	const parsedFlags = parser.parseFlags(flags);
	const ast = parser.parsePattern(pattern, 0, pattern.length, {
		unicode: parsedFlags.unicode,
		unicodeSets: parsedFlags.unicodeSets,
	});
	const readonlyFlags: ReadonlyFlags = {
		dotAll: parsedFlags.dotAll,
		global: parsedFlags.global,
		hasIndices: parsedFlags.hasIndices,
		ignoreCase: parsedFlags.ignoreCase,
		multiline: parsedFlags.multiline,
		sticky: parsedFlags.sticky,
		unicode: parsedFlags.unicode,
		unicodeSets: parsedFlags.unicodeSets,
	};
	const findings: Finding[] = [];
	const pending: { readonly alternatives: readonly AST.Alternative[]; readonly reversed: boolean }[] = [
		{ alternatives: ast.alternatives, reversed: false },
	];
	const analysed = new Set<readonly AST.Alternative[]>();
	while (pending.length > 0) {
		const { alternatives, reversed } = pending.pop()!;
		if (analysed.has(alternatives)) continue;
		analysed.add(alternatives);
		const context = createContext(readonlyFlags, reversed);
		const body = union(
			context,
			alternatives.map((alternative) => sequence(context, alternative, readonlyFlags)),
		);
		findings.push(...analyse(context, body, pattern));
		for (const lookaround of context.lookarounds) {
			pending.push({ alternatives: lookaround.alternatives, reversed: lookaround.kind === "lookbehind" });
		}
	}
	return dedupe(findings).map((finding) => ({
		kind: finding.kind,
		subPattern: pattern.slice(finding.start, finding.end),
		reason: finding.reason,
	}));
}

function createContext(flags: ReadonlyFlags, reversed: boolean): Context {
	const all = Chars.all(flags);
	const none = Chars.empty(flags);
	return {
		positions: [],
		edges: new Map(),
		lookarounds: new Set(),
		all,
		none,
		word: Chars.word(flags),
		lineTerminator: Chars.lineTerminator(flags),
		open: { prev: all, atStart: true, next: all, atEnd: true, boundary: "any", conditional: false },
		reversed,
	};
}

const charSetKeys = new WeakMap<CharSet, string>();
function charSetKey(chars: CharSet): string {
	let key = charSetKeys.get(chars);
	if (key === undefined) {
		key = chars.toRangesString();
		charSetKeys.set(chars, key);
	}
	return key;
}

const guardKeys = new WeakMap<Guard, string>();
function guardKey(guard: Guard): string {
	let key = guardKeys.get(guard);
	if (key === undefined) {
		key = [
			charSetKey(guard.prev),
			guard.atStart,
			charSetKey(guard.next),
			guard.atEnd,
			guard.boundary,
			guard.conditional,
		].join("|");
		guardKeys.set(guard, key);
	}
	return key;
}

function combine(context: Context, a: Guard, b: Guard): Guard | undefined {
	if (a === context.open) return b;
	if (b === context.open) return a;
	let boundary = a.boundary;
	if (b.boundary !== "any") {
		if (boundary !== "any" && boundary !== b.boundary) return undefined;
		boundary = b.boundary;
	}
	const prev = a.prev.intersect(b.prev);
	const atStart = a.atStart && b.atStart;
	const next = a.next.intersect(b.next);
	const atEnd = a.atEnd && b.atEnd;
	if ((prev.isEmpty && !atStart) || (next.isEmpty && !atEnd)) return undefined;
	return { prev, atStart, next, atEnd, boundary, conditional: a.conditional || b.conditional };
}

function transition(
	context: Context,
	prevChars: CharSet,
	guard: Guard,
	nextChars: CharSet,
): { readonly prev: CharSet; readonly label: CharSet } | undefined {
	const prev = prevChars.intersect(guard.prev);
	if (prev.isEmpty) return undefined;
	let label = nextChars.intersect(guard.next);
	if (guard.boundary !== "any") {
		const prevIsWord = prev.isSubsetOf(context.word) ? true : prev.isDisjointWith(context.word) ? false : undefined;
		if (prevIsWord !== undefined) {
			const nextIsWord = guard.boundary === "word" ? !prevIsWord : prevIsWord;
			label = nextIsWord ? label.intersect(context.word) : label.without(context.word);
		}
	}
	return label.isEmpty ? undefined : { prev, label };
}

function capped(count: number): number {
	return Math.min(count, AMBIGUOUS);
}

function addEdge(context: Context, from: Entry, to: Entry, via: AST.Node): void {
	const guard = combine(context, from.guard, to.guard);
	if (!guard) return;
	const step = transition(
		context,
		context.positions[from.position]!.chars,
		guard,
		context.positions[to.position]!.chars,
	);
	if (!step) return;
	const { prev, label } = step;
	const key = `${from.position}>${to.position}:${charSetKey(label)}:${charSetKey(prev)}:${guard.boundary}`;
	const count = from.count * to.count;
	const existing = context.edges.get(key);
	if (existing) {
		existing.count = capped(existing.count + count);
		if (!existing.via.includes(via)) existing.via.push(via);
		return;
	}
	context.edges.set(key, {
		from: from.position,
		to: to.position,
		label,
		prev,
		boundary: guard.boundary,
		count: capped(count),
		via: [via],
	});
}

function readsRun(edge: Edge, char: number): boolean {
	return edge.label.has(char) && edge.prev.has(char) && edge.boundary !== "word";
}

function mergeEntries(entries: readonly Entry[]): Entry[] {
	const merged = new Map<string, Entry>();
	for (const entry of entries) {
		const key = `${entry.position}:${guardKey(entry.guard)}`;
		const existing = merged.get(key);
		merged.set(key, existing ? { ...existing, count: capped(existing.count + entry.count) } : entry);
	}
	return [...merged.values()];
}

function mergeEmpty(paths: readonly EmptyPath[]): EmptyPath[] {
	const merged = new Map<string, EmptyPath>();
	for (const path of paths) {
		const key = guardKey(path.guard);
		const existing = merged.get(key);
		merged.set(key, existing ? { ...existing, count: capped(existing.count + path.count) } : path);
	}
	return [...merged.values()];
}

function epsilon(context: Context, guard: Guard = context.open): Fragment {
	return { first: [], last: [], empty: [{ guard, count: 1 }] };
}

function leaf(context: Context, chars: CharSet, origin: AST.Node): Fragment {
	const position = context.positions.length;
	context.positions.push({ chars, origin });
	const entry: Entry = { position, guard: context.open, count: 1 };
	return { first: [entry], last: [entry], empty: [] };
}

function union(context: Context, fragments: readonly Fragment[]): Fragment {
	if (fragments.length === 0) return epsilon(context);
	if (fragments.length === 1) return fragments[0]!;
	return {
		first: mergeEntries(fragments.flatMap((fragment) => fragment.first)),
		last: mergeEntries(fragments.flatMap((fragment) => fragment.last)),
		empty: mergeEmpty(fragments.flatMap((fragment) => fragment.empty)),
	};
}

function concat(context: Context, a: Fragment, b: Fragment, via: AST.Node): Fragment {
	for (const from of a.last) for (const to of b.first) addEdge(context, from, to, via);
	const first: Entry[] = [...a.first];
	for (const skipped of a.empty) {
		for (const entry of b.first) {
			const guard = combine(context, skipped.guard, entry.guard);
			if (guard) first.push({ position: entry.position, guard, count: capped(skipped.count * entry.count) });
		}
	}
	const last: Entry[] = [...b.last];
	for (const entry of a.last) {
		for (const skipped of b.empty) {
			const guard = combine(context, entry.guard, skipped.guard);
			if (guard) last.push({ position: entry.position, guard, count: capped(entry.count * skipped.count) });
		}
	}
	const empty: EmptyPath[] = [];
	for (const left of a.empty) {
		for (const right of b.empty) {
			const guard = combine(context, left.guard, right.guard);
			if (guard) empty.push({ guard, count: capped(left.count * right.count) });
		}
	}
	return { first: mergeEntries(first), last: mergeEntries(last), empty: mergeEmpty(empty) };
}

function optional(context: Context, fragment: Fragment): Fragment {
	return { first: fragment.first, last: fragment.last, empty: [{ guard: context.open, count: 1 }] };
}

function sequence(context: Context, alternative: AST.Alternative, flags: ReadonlyFlags): Fragment {
	let fragment = epsilon(context);
	const elements = context.reversed ? [...alternative.elements].reverse() : alternative.elements;
	for (const element of elements) {
		fragment = concat(context, fragment, build(context, element, flags), alternative);
	}
	return fragment;
}

function alternatives(context: Context, list: readonly AST.Alternative[], flags: ReadonlyFlags): Fragment {
	return union(
		context,
		list.map((alternative) => sequence(context, alternative, flags)),
	);
}

function build(context: Context, node: AST.Element, flags: ReadonlyFlags): Fragment {
	switch (node.type) {
		case "Character":
		case "CharacterClass":
		case "CharacterSet":
		case "ExpressionCharacterClass":
			return characters(context, node, flags);
		case "Group":
			return alternatives(context, node.alternatives, withModifiers(node, flags));
		case "CapturingGroup":
			return alternatives(context, node.alternatives, flags);
		case "Assertion":
			return assertion(context, node, flags);
		case "Quantifier":
			return repeat(
				context,
				node.min,
				node.max,
				() => build(context, node.element, flags),
				size(node.element),
				node,
			);
		case "Backreference":
			return backreference(context, node, flags);
	}
}

function characters(
	context: Context,
	node: AST.Character | AST.CharacterClass | AST.CharacterSet | AST.ExpressionCharacterClass,
	flags: ReadonlyFlags,
): Fragment {
	const set = toUnicodeSet(node, flags);
	if (set.accept.isEmpty) return leaf(context, set.chars, node);
	const parts: Fragment[] = set.chars.isEmpty ? [] : [leaf(context, set.chars, node)];
	for (const word of set.accept.wordSets) {
		let fragment = epsilon(context);
		for (const chars of context.reversed ? [...word].reverse() : word) {
			fragment = concat(context, fragment, leaf(context, chars, node), node);
		}
		parts.push(fragment);
	}
	return union(context, parts);
}

function withModifiers(group: AST.Group, flags: ReadonlyFlags): ReadonlyFlags {
	const modifiers = group.modifiers;
	if (!modifiers) return flags;
	const pick = (key: "dotAll" | "ignoreCase" | "multiline"): boolean =>
		modifiers.add[key] ? true : modifiers.remove?.[key] ? false : (flags[key] ?? false);
	return { ...flags, dotAll: pick("dotAll"), ignoreCase: pick("ignoreCase"), multiline: pick("multiline") };
}

function oriented(context: Context, guard: Guard): Guard {
	if (!context.reversed) return guard;
	return { ...guard, prev: guard.next, atStart: guard.atEnd, next: guard.prev, atEnd: guard.atStart };
}

function assertion(context: Context, node: AST.Assertion, flags: ReadonlyFlags): Fragment {
	const base = { ...context.open, conditional: true };
	switch (node.kind) {
		case "start":
			return epsilon(
				context,
				oriented(context, { ...base, prev: flags.multiline ? context.lineTerminator : context.none }),
			);
		case "end":
			return epsilon(
				context,
				oriented(context, { ...base, next: flags.multiline ? context.lineTerminator : context.none }),
			);
		case "word":
			return epsilon(context, { ...base, boundary: node.negate ? "nonword" : "word" });
		case "lookahead":
		case "lookbehind": {
			context.lookarounds.add(node);
			const direction: Direction = node.kind === "lookahead" ? "ltr" : "rtl";
			const first = getFirstConsumedChar(node.alternatives, direction, flags);
			let chars = context.all;
			let edge = true;
			if (!node.negate) {
				if (!first.empty) {
					chars = first.char;
					edge = false;
				}
			} else {
				const length = getLengthRange(node.alternatives, flags);
				if (length.min === 1 && length.max === 1 && first.exact) chars = context.all.without(first.char);
			}
			return epsilon(
				context,
				oriented(
					context,
					direction === "ltr" ? { ...base, next: chars, atEnd: edge } : { ...base, prev: chars, atStart: edge },
				),
			);
		}
	}
}

function backreference(context: Context, node: AST.Backreference, flags: ReadonlyFlags): Fragment {
	const groups = Array.isArray(node.resolved) ? node.resolved : [node.resolved];
	let chars = context.none;
	let shortest = Number.POSITIVE_INFINITY;
	let longest = 0;
	for (const group of groups) {
		chars = chars.union(getConsumedChars(group, flags).chars);
		const length = getLengthRange(group.alternatives, flags);
		shortest = Math.min(shortest, length.min);
		longest = Math.max(longest, length.max);
	}
	const skip: EmptyPath = { guard: { ...context.open, conditional: true }, count: 1 };
	if (chars.isEmpty || longest === 0) return { first: [], last: [], empty: [skip] };
	const min = isStrictBackreference(node) ? shortest : 0;
	const repeated = repeat(context, min, longest, () => leaf(context, chars, node), 1, node);
	return min === 0 ? { ...repeated, empty: [skip] } : repeated;
}

function size(node: AST.Element | AST.Alternative): number {
	switch (node.type) {
		case "Alternative":
			return node.elements.reduce((total, element) => total + size(element), 0);
		case "Group":
		case "CapturingGroup":
			return node.alternatives.reduce((total, alternative) => total + size(alternative), 0);
		case "Quantifier": {
			const inner = size(node.element);
			return expands(node.min, node.max, inner) ? node.max * inner : inner;
		}
		default:
			return 1;
	}
}

function expands(min: number, max: number, inner: number): boolean {
	return (
		Number.isFinite(max) && max - min <= MAX_EXPANDED_OPTIONAL_REPETITIONS && max * inner <= MAX_EXPANDED_POSITIONS
	);
}

function repeat(
	context: Context,
	min: number,
	max: number,
	copy: () => Fragment,
	copySize: number,
	via: AST.Node,
): Fragment {
	if (max === 0) return epsilon(context);
	if (max === 1) return min === 1 ? copy() : optional(context, copy());
	if (expands(min, max, copySize)) {
		let fragment = epsilon(context);
		for (let index = 0; index < min; index++) fragment = concat(context, fragment, copy(), via);
		let tail: Fragment | undefined;
		for (let index = min; index < max; index++) {
			tail = optional(context, tail ? concat(context, copy(), tail, via) : copy());
		}
		return tail ? concat(context, fragment, tail, via) : fragment;
	}
	const body = copy();
	for (const from of body.last) for (const to of body.first) addEdge(context, from, to, via);
	return { first: body.first, last: body.last, empty: min === 0 ? [{ guard: context.open, count: 1 }] : body.empty };
}

interface Graph {
	readonly size: number;
	readonly successors: readonly (readonly number[])[];
}

function components(graph: Graph): number[] {
	const index = new Array<number>(graph.size).fill(-1);
	const low = new Array<number>(graph.size).fill(0);
	const component = new Array<number>(graph.size).fill(-1);
	const onStack = new Array<boolean>(graph.size).fill(false);
	const stack: number[] = [];
	let counter = 0;
	let componentCount = 0;
	for (let root = 0; root < graph.size; root++) {
		if (index[root] !== -1) continue;
		const work: [node: number, next: number][] = [[root, 0]];
		index[root] = low[root] = counter++;
		stack.push(root);
		onStack[root] = true;
		while (work.length > 0) {
			const frame = work[work.length - 1]!;
			const [node, next] = frame;
			const successors = graph.successors[node]!;
			if (next < successors.length) {
				frame[1] = next + 1;
				const successor = successors[next]!;
				if (index[successor] === -1) {
					index[successor] = low[successor] = counter++;
					stack.push(successor);
					onStack[successor] = true;
					work.push([successor, 0]);
				} else if (onStack[successor]) {
					low[node] = Math.min(low[node]!, index[successor]!);
				}
				continue;
			}
			work.pop();
			if (work.length > 0) {
				const parent = work[work.length - 1]![0];
				low[parent] = Math.min(low[parent]!, low[node]!);
			}
			if (low[node] === index[node]) {
				let member: number;
				do {
					member = stack.pop()!;
					onStack[member] = false;
					component[member] = componentCount;
				} while (member !== node);
				componentCount++;
			}
		}
	}
	return component;
}

function graphOf(size: number, edges: readonly Edge[]): Graph {
	const successors: number[][] = Array.from({ length: size }, () => []);
	for (const edge of edges) successors[edge.from]!.push(edge.to);
	return { size, successors };
}

function representatives(labels: readonly CharSet[]): number[] {
	const unique = new Map<string, CharSet>();
	for (const label of labels) unique.set(charSetKey(label), label);
	const sets = [...unique.values()];
	const boundaries = new Set<number>();
	for (const set of sets) {
		for (const range of set.ranges) {
			boundaries.add(range.min);
			boundaries.add(range.max + 1);
		}
	}
	const sorted = [...boundaries].sort((a, b) => a - b);
	const classes = new Map<string, number[]>();
	for (const start of sorted) {
		const signature = sets.map((set) => (set.has(start) ? "1" : "0")).join("");
		if (!signature.includes("1")) continue;
		const members = classes.get(signature);
		if (members) members.push(start);
		else classes.set(signature, [start]);
	}
	return [...classes.values()].map((starts) => readableMember(sets, starts));
}

function readableMember(sets: readonly CharSet[], starts: readonly number[]): number {
	const signature = (char: number): string => sets.map((set) => (set.has(char) ? "1" : "0")).join("");
	const wanted = signature(starts[0]!);
	for (const candidate of [0x61, 0x41, 0x30, 0x20, 0x2c, 0x2e, 0x5f, 0x2d]) {
		if (signature(candidate) === wanted) return candidate;
	}
	for (let char = 0x21; char < 0x7f; char++) if (signature(char) === wanted) return char;
	return starts[0]!;
}

function single(context: Context, char: number): CharSet {
	return context.all.intersect({ min: char, max: char });
}

function describeChar(char: number): string {
	return JSON.stringify(String.fromCodePoint(char));
}

function analyse(context: Context, body: Fragment, pattern: string): Finding[] {
	const { positions } = context;
	const reachable = new Array<boolean>(positions.length).fill(false);
	const queue: number[] = [];
	for (const entry of body.first) {
		const position = positions[entry.position]!;
		if (reachable[entry.position] || position.chars.intersect(entry.guard.next).isEmpty) continue;
		reachable[entry.position] = true;
		queue.push(entry.position);
	}
	const allEdges = [...context.edges.values()];
	const outgoing = graphOf(positions.length, allEdges).successors;
	while (queue.length > 0) {
		const node = queue.pop()!;
		for (const successor of outgoing[node]!) {
			if (reachable[successor]) continue;
			reachable[successor] = true;
			queue.push(successor);
		}
	}
	const edges = allEdges.filter((edge) => reachable[edge.from] && reachable[edge.to]);
	const exits = new Map<number, Guard[]>();
	for (const exit of body.last) {
		if (positions[exit.position]!.chars.intersect(exit.guard.prev).isEmpty) continue;
		const list = exits.get(exit.position) ?? [];
		list.push(exit.guard);
		exits.set(exit.position, list);
	}
	const acceptsWithin = (node: number, pumped: CharSet): boolean =>
		(exits.get(node) ?? []).some((guard) => {
			if (!guard.conditional) return true;
			const inside = pumped.intersect(guard.prev).intersect(guard.next);
			if (inside.isEmpty) return false;
			if (guard.boundary === "any") return true;
			const words = inside.intersect(context.word);
			const sameWordness = inside.isSubsetOf(context.word) || words.isEmpty;
			return guard.boundary === "nonword" || !sameWordness;
		});
	const leaving: Edge[][] = positions.map(() => []);
	for (const edge of edges) leaving[edge.from]!.push(edge);
	const accepts = acceptsEverything(context, exits, leaving);
	const failsAfter: FailsAfter = (seeds, pumped) => {
		const seen = new Set<number>();
		const work = [...seeds];
		while (work.length > 0) {
			const node = work.pop()!;
			if (seen.has(node)) continue;
			seen.add(node);
			if (accepts[node] || acceptsWithin(node, pumped)) return false;
			for (const edge of leaving[node]!) {
				if (!edge.label.isDisjointWith(pumped) && !edge.prev.isDisjointWith(pumped)) work.push(edge.to);
			}
		}
		return true;
	};
	return [...exponential(context, edges, failsAfter), ...polynomial(context, edges, failsAfter, pattern)];
}

function acceptsEverything(
	context: Context,
	exits: ReadonlyMap<number, readonly Guard[]>,
	leaving: readonly (readonly Edge[])[],
): boolean[] {
	const accepts = leaving.map(() => true);
	let changed = true;
	while (changed) {
		changed = false;
		for (let node = 0; node < accepts.length; node++) {
			if (!accepts[node]) continue;
			let covered = context.none;
			let atEnd = false;
			for (const guard of exits.get(node) ?? []) {
				if (guard.boundary !== "any") continue;
				covered = covered.union(guard.next);
				atEnd ||= guard.atEnd;
			}
			for (const edge of leaving[node]!) if (accepts[edge.to]) covered = covered.union(edge.label);
			if (atEnd && covered.isAll) continue;
			accepts[node] = false;
			changed = true;
		}
	}
	return accepts;
}

type FailsAfter = (seeds: Iterable<number>, pumped: CharSet) => boolean;

function exponential(context: Context, edges: readonly Edge[], failsAfter: FailsAfter): Finding[] {
	const findings: Finding[] = [];
	const component = components(graphOf(context.positions.length, edges));
	const loops = new Map<number, Edge[]>();
	for (const edge of edges) {
		if (component[edge.from] !== component[edge.to]) continue;
		const list = loops.get(component[edge.from]!);
		if (list) list.push(edge);
		else loops.set(component[edge.from]!, [edge]);
	}
	for (const inner of loops.values()) {
		const finding =
			singleCharacterAmbiguity(context, inner, failsAfter) ?? multiCharacterAmbiguity(context, inner, failsAfter);
		if (finding) findings.push(finding);
	}
	return findings;
}

function singleCharacterAmbiguity(
	context: Context,
	inner: readonly Edge[],
	failsAfter: FailsAfter,
): Finding | undefined {
	for (const char of representatives(inner.flatMap((edge) => [edge.label, edge.prev]))) {
		const reading = inner.filter((edge) => readsRun(edge, char));
		const component = components(graphOf(context.positions.length, reading));
		const edgeCount = new Map<number, number>();
		const members = new Map<number, Set<number>>();
		for (const edge of reading) {
			if (component[edge.from] !== component[edge.to]) continue;
			const id = component[edge.from]!;
			edgeCount.set(id, (edgeCount.get(id) ?? 0) + edge.count);
			const set = members.get(id) ?? new Set<number>();
			set.add(edge.from);
			set.add(edge.to);
			members.set(id, set);
		}
		for (const [id, nodes] of members) {
			if (edgeCount.get(id)! <= nodes.size) continue;
			if (!failsAfter(nodes, single(context, char))) continue;
			const loopEdges = reading.filter((edge) => nodes.has(edge.from) && nodes.has(edge.to));
			return exponentialFinding(context, nodes, loopEdges, [char]);
		}
	}
	return undefined;
}

function multiCharacterAmbiguity(
	context: Context,
	inner: readonly Edge[],
	failsAfter: FailsAfter,
): Finding | undefined {
	if (inner.length * inner.length > MAX_PAIRED_EDGES) return undefined;
	const local = new Map<number, number>();
	for (const edge of inner) {
		if (!local.has(edge.from)) local.set(edge.from, local.size);
		if (!local.has(edge.to)) local.set(edge.to, local.size);
	}
	const width = local.size;
	const pair = (a: number, b: number): number => local.get(a)! * width + local.get(b)!;
	interface Paired {
		readonly from: number;
		readonly to: number;
		readonly differs: boolean;
		readonly chars: CharSet;
	}
	const paired: Paired[] = [];
	for (const a of inner) {
		for (const b of inner) {
			const chars = a.label.intersect(b.label);
			if (chars.isEmpty) continue;
			paired.push({ from: pair(a.from, b.from), to: pair(a.to, b.to), differs: a !== b || a.count > 1, chars });
		}
	}
	const successors: number[][] = Array.from({ length: width * width }, () => []);
	for (const edge of paired) successors[edge.from]!.push(edge.to);
	const component = components({ size: width * width, successors });
	const diagonal = new Set<number>();
	for (const index of local.values()) diagonal.add(component[index * width + index]!);
	for (const edge of paired) {
		const id = component[edge.from]!;
		if (!edge.differs || component[edge.to] !== id || !diagonal.has(id)) continue;
		const inLoop = paired.filter((other) => component[other.from] === id && component[other.to] === id);
		let chars = context.none;
		for (const other of inLoop) chars = chars.union(other.chars);
		const nodes = new Set<number>();
		for (const [position, index] of local) {
			for (let other = 0; other < width; other++) {
				if (component[index * width + other] === id || component[other * width + index] === id) nodes.add(position);
			}
		}
		if (!failsAfter(nodes, chars)) return undefined;
		const loopEdges = inner.filter((other) => nodes.has(other.from) && nodes.has(other.to));
		return exponentialFinding(context, nodes, loopEdges, representatives([chars]));
	}
	return undefined;
}

function exponentialFinding(
	context: Context,
	nodes: ReadonlySet<number>,
	loopEdges: readonly Edge[],
	chars: readonly number[],
): Finding {
	const involved: AST.Node[] = [];
	for (const node of nodes) involved.push(context.positions[node]!.origin);
	for (const edge of loopEdges) involved.push(...edge.via);
	const owner = repeatingAncestor(commonAncestor(involved));
	const loops = new Set<AST.Quantifier>();
	for (const edge of loopEdges) {
		for (const via of edge.via) if (via.type === "Quantifier" && isRepeating(via)) loops.add(via);
	}
	const run = chars
		.slice(0, 3)
		.map((char) => describeChar(char))
		.join(", ");
	const nested = [...loops].filter((loop) => loop !== owner);
	const reason =
		nested.length > 0
			? `${nested[0]!.raw} repeats inside ${owner.raw}, so a run of ${run} splits between the repetitions in exponentially many ways; an input that fails after the run makes backtracking try every one`
			: `the alternatives that ${owner.raw} repeats can match the same run of ${run} in exponentially many ways; an input that fails after the run makes backtracking try every one`;
	return { kind: "exponential", start: owner.start, end: owner.end, reason };
}

function polynomial(context: Context, edges: readonly Edge[], failsAfter: FailsAfter, pattern: string): Finding[] {
	const findings: Finding[] = [];
	const size = context.positions.length;
	for (const char of representatives(edges.flatMap((edge) => [edge.label, edge.prev]))) {
		const reading = edges.filter((edge) => readsRun(edge, char));
		const graph = graphOf(size, reading);
		const component = components(graph);
		const cyclic = new Map<number, Set<number>>();
		const loopEdges = new Map<number, Edge[]>();
		for (const edge of reading) {
			if (component[edge.from] !== component[edge.to]) continue;
			const id = component[edge.from]!;
			const set = cyclic.get(id) ?? new Set<number>();
			set.add(edge.from);
			set.add(edge.to);
			cyclic.set(id, set);
			const list = loopEdges.get(id) ?? [];
			list.push(edge);
			loopEdges.set(id, list);
		}
		if (cyclic.size < 2) continue;
		const { before, after } = chainLengths(component, reading, cyclic);
		for (const [id, nodes] of cyclic) {
			if (!failsAfter(nodes, single(context, char))) continue;
			const seen = new Set<number>(nodes);
			const work = [...nodes];
			const reached = new Set<number>();
			while (work.length > 0) {
				const node = work.pop()!;
				for (const successor of graph.successors[node]!) {
					if (seen.has(successor)) continue;
					seen.add(successor);
					work.push(successor);
					const other = component[successor]!;
					if (other !== id && cyclic.has(other)) reached.add(other);
				}
			}
			for (const other of reached) {
				findings.push(
					polynomialFinding(
						context,
						[nodes, cyclic.get(other)!],
						[loopEdges.get(id)!, loopEdges.get(other)!],
						char,
						before[id]! + after[other]!,
						pattern,
					),
				);
			}
		}
	}
	return findings;
}

function chainLengths(
	component: readonly number[],
	reading: readonly Edge[],
	cyclic: ReadonlyMap<number, unknown>,
): { before: number[]; after: number[] } {
	const count = Math.max(-1, ...component) + 1;
	const own = (id: number): number => (cyclic.has(id) ? 1 : 0);
	const before = Array.from({ length: count }, (_, id) => own(id));
	const after = Array.from({ length: count }, (_, id) => own(id));
	const links: [from: number, to: number][] = [];
	for (const edge of reading) {
		const from = component[edge.from]!;
		const to = component[edge.to]!;
		if (from !== to) links.push([from, to]);
	}
	links.sort((a, b) => a[1] - b[1]);
	for (const [from, to] of links) after[from] = Math.max(after[from]!, own(from) + after[to]!);
	links.sort((a, b) => b[0] - a[0]);
	for (const [from, to] of links) before[to] = Math.max(before[to]!, own(to) + before[from]!);
	return { before, after };
}

function polynomialFinding(
	context: Context,
	nodeSets: readonly [ReadonlySet<number>, ReadonlySet<number>],
	edgeSets: readonly [readonly Edge[], readonly Edge[]],
	char: number,
	degree: number,
	pattern: string,
): Finding {
	const [first, second] = [0, 1].map((side) => {
		const involved: AST.Node[] = [];
		for (const node of nodeSets[side]!) involved.push(context.positions[node]!.origin);
		for (const edge of edgeSets[side]!) involved.push(...edge.via);
		return repeatingAncestor(commonAncestor(involved));
	}) as [AST.Node, AST.Node];
	const [start, end] = span(first, second);
	const repeated = describeChar(char);
	const cost = `O(n^${degree}) steps per match attempt on a run of n`;
	const reason =
		first === second
			? `copies of ${first.raw} inside ${pattern.slice(start, end)} can each read a run of ${repeated}; an input that fails after the run makes backtracking try every split: ${cost}`
			: `${first.raw} and ${second.raw} can both read a run of ${repeated} with nothing forcing where one stops; an input that fails after the run makes backtracking try every split: ${cost}`;
	return { kind: "polynomial", start, end, reason };
}

function span(first: AST.Node, second: AST.Node): [number, number] {
	if (first === second) {
		const outer = repeatingAncestor(first.parent ?? first);
		return outer === first || outer.type !== "Quantifier" ? [first.start, first.end] : [outer.start, outer.end];
	}
	const common = commonAncestor([first, second]);
	if (common.type !== "Alternative") return [common.start, common.end];
	const childOf = (node: AST.Node): AST.Node => {
		let current = node;
		while (current.parent && current.parent !== common) current = current.parent;
		return current;
	};
	const a = childOf(first);
	const b = childOf(second);
	return [Math.min(a.start, b.start), Math.max(a.end, b.end)];
}

function isRepeating(node: AST.Node): boolean {
	return node.type === "Quantifier" && node.max > 1;
}

function repeatingAncestor(node: AST.Node): AST.Node {
	for (let current: AST.Node | null = node; current; current = current.parent) {
		if (isRepeating(current)) return current;
		if (current.type === "Pattern" || current.type === "Assertion") break;
	}
	return node;
}

function commonAncestor(nodes: readonly AST.Node[]): AST.Node {
	const chain = (node: AST.Node): AST.Node[] => {
		const result: AST.Node[] = [];
		for (let current: AST.Node | null = node; current; current = current.parent) result.unshift(current);
		return result;
	};
	let common = chain(nodes[0]!);
	for (const node of nodes.slice(1)) {
		const other = chain(node);
		let length = 0;
		while (length < common.length && length < other.length && common[length] === other[length]) length++;
		common = common.slice(0, length);
	}
	return common[common.length - 1]!;
}

function dedupe(findings: readonly Finding[]): Finding[] {
	const unique = new Map<string, Finding>();
	for (const finding of findings) {
		const key = `${finding.kind}:${finding.start}:${finding.end}`;
		if (!unique.has(key)) unique.set(key, finding);
	}
	const all = [...unique.values()];
	const within = (inner: Finding, outer: Finding): boolean =>
		inner !== outer && outer.start <= inner.start && inner.end <= outer.end;
	return all
		.filter(
			(finding) =>
				finding.kind === "exponential" ||
				!all.some(
					(other) =>
						(other.kind === "exponential" && within(finding, other)) ||
						(other.kind === "polynomial" && within(other, finding)),
				),
		)
		.sort((a, b) => a.start - b.start || a.end - b.end);
}

export function extractRegexSources(file: string, sourceText: string): RegexSource[] {
	const extension = extname(file);
	const program = parseSource(sourceText, {
		sourceType: "unambiguous",
		plugins: extension === ".tsx" || extension === ".jsx" ? ["typescript", "jsx"] : ["typescript"],
		errorRecovery: true,
	});
	const sources: RegexSource[] = [];
	traverseFast(program, (node) => {
		const line = node.loc?.start.line ?? 0;
		if (node.type === "RegExpLiteral") {
			sources.push({ file, line, pattern: node.pattern, flags: node.flags });
			return;
		}
		if (node.type !== "NewExpression" && node.type !== "CallExpression") return;
		if (node.callee.type !== "Identifier" || node.callee.name !== "RegExp") return;
		const [patternArgument, flagsArgument] = node.arguments;
		const pattern = patternArgument ? staticString(patternArgument) : "";
		const flags = flagsArgument ? staticString(flagsArgument) : "";
		if (pattern === undefined || flags === undefined) return;
		sources.push({ file, line, pattern, flags });
	});
	return sources;
}

function staticString(node: SourceNode): string | undefined {
	switch (node.type) {
		case "StringLiteral":
			return node.value;
		case "TemplateLiteral":
			return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? undefined) : undefined;
		case "TaggedTemplateExpression": {
			const tag = node.tag;
			const isStringRaw =
				tag.type === "MemberExpression" &&
				tag.object.type === "Identifier" &&
				tag.object.name === "String" &&
				tag.property.type === "Identifier" &&
				tag.property.name === "raw";
			if (!isStringRaw || node.quasi.expressions.length !== 0) return undefined;
			return node.quasi.quasis[0]?.value.raw;
		}
		default:
			return undefined;
	}
}

export const SHIPPED_SOURCE_ROOTS: readonly string[] = [
	"packages/agent/src",
	"packages/ai/src",
	"packages/codemode/src",
	"packages/coding-agent/src",
	"packages/schema/src",
	"packages/subagents/src",
	"packages/telemetry/src",
	"packages/tui/src",
	"packages/intercom",
	"packages/mcp",
	"packages/web-access",
];

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]);
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "test", "tests", "__tests__", "fixtures"]);

function isSourceFile(name: string): boolean {
	if (!SOURCE_EXTENSIONS.has(extname(name))) return false;
	if (/\.d\.[cm]?ts$/.test(name)) return false;
	return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(name);
}

function collectFiles(path: string, files: string[]): void {
	const stat = statSync(path);
	if (stat.isFile()) {
		if (isSourceFile(path)) files.push(path);
		return;
	}
	if (!stat.isDirectory()) return;
	for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
		if (entry.isDirectory()) {
			if (!SKIPPED_DIRECTORIES.has(entry.name)) collectFiles(join(path, entry.name), files);
		} else if (entry.isFile() && isSourceFile(entry.name)) {
			files.push(join(path, entry.name));
		}
	}
}

export interface ScannedRegex extends RegexSource {
	readonly risks: readonly RegexRisk[];
	readonly error?: string;
}

export function scanPaths(paths: readonly string[], baseDirectory = process.cwd()): ScannedRegex[] {
	const files: string[] = [];
	for (const path of paths) collectFiles(resolve(baseDirectory, path), files);
	const results: ScannedRegex[] = [];
	for (const file of files) {
		const display = relative(baseDirectory, file).split("\\").join("/");
		let sources: RegexSource[];
		try {
			sources = extractRegexSources(display, readFileSync(file, "utf8"));
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			results.push({ file: display, line: 0, pattern: "", flags: "", risks: [], error: reason });
			continue;
		}
		for (const source of sources) {
			try {
				results.push({ ...source, risks: findBacktrackingRisks(source.pattern, source.flags) });
			} catch (error) {
				results.push({ ...source, risks: [], error: error instanceof Error ? error.message : String(error) });
			}
		}
	}
	return results;
}

function main(argv: readonly string[]): number {
	const json = argv.includes("--json");
	const paths = argv.filter((argument) => argument !== "--json");
	const roots = paths.length > 0 ? paths : SHIPPED_SOURCE_ROOTS;
	const scanned = scanPaths(roots);
	const risky = scanned.filter((entry) => entry.risks.length > 0 || entry.error !== undefined);
	if (json) {
		process.stdout.write(`${JSON.stringify(risky, null, "\t")}\n`);
	} else {
		for (const entry of risky) {
			process.stdout.write(`${entry.file}:${entry.line} /${entry.pattern}/${entry.flags}\n`);
			if (entry.error !== undefined) process.stdout.write(`  unparseable: ${entry.error}\n`);
			for (const risk of entry.risks) process.stdout.write(`  ${risk.kind}: ${risk.subPattern} — ${risk.reason}\n`);
		}
		const counts = { exponential: 0, polynomial: 0 };
		for (const entry of risky) for (const risk of entry.risks) counts[risk.kind]++;
		process.stdout.write(
			`${scanned.length} regular expressions scanned; ${risky.length} risky (${counts.exponential} exponential, ${counts.polynomial} polynomial findings)\n`,
		);
	}
	return risky.length > 0 ? 1 : 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	process.exitCode = main(process.argv.slice(2));
}

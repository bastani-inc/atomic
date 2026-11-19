type Path = readonly (string | number)[];
interface Wanted {
	children: Map<string | number, Wanted>;
	names: string[];
	name?: string;
}
export interface JsonSpan {
	start: number;
	end: number;
	member: number;
	ordinal: number;
	parent: number;
	previous?: number;
	next?: number;
}
interface Frame {
	node: Wanted;
	kind: "object" | "array";
	phase: "key" | "colon" | "value" | "after";
	start: number;
	index: number;
	member: number;
	name?: string;
	comma?: number;
	last?: JsonSpan;
}
const white = (b: number) => b === 32 || b === 10 || b === 13 || b === 9;
/** Locate a finite set of disjoint JSON values in the original UTF-8 bytes. Only selected ancestors
 * need a frame. Unselected strings, arrays and objects (including signed content) are skipped in place. */
export async function jsonSpans(
	chunks: AsyncIterable<Uint8Array>,
	paths: ReadonlyMap<string, Path>,
): Promise<Map<string, JsonSpan>> {
	const node = (): Wanted => ({ children: new Map(), names: [] });
	const root = node();
	for (const [name, path] of paths) {
		let n = root;
		n.names.push(name);
		for (const step of path) {
			let c = n.children.get(step);
			if (!c) {
				c = node();
				n.children.set(step, c);
			}
			n = c;
			n.names.push(name);
		}
		n.name = name;
	}
	const result = new Map<string, JsonSpan>(),
		stack: Frame[] = [];
	let skipping:
		| {
				start: number;
				parent?: Frame;
				target?: string;
				kind: "string" | "atom" | "container";
				depth: number;
				quote: boolean;
				escape: boolean;
		  }
		| undefined;
	let key: number[] | undefined,
		bigKey = false,
		escaped = false,
		base = 0;
	const complete = (end: number) => {
		const s = skipping!;
		if (s.target && s.parent) {
			const p = s.parent;
			const span = {
				start: s.start,
				end,
				member: p.member,
				ordinal: p.index - 1,
				parent: p.start,
				previous: p.comma,
			};
			result.set(s.target, span);
			p.last = span;
		}
		skipping = undefined;
	};
	for await (const chunk of chunks) {
		for (let i = 0; i < chunk.length; i++) {
			const b = chunk[i]!,
				pos = base + i;
			if (skipping) {
				const s = skipping;
				if (s.kind === "atom") {
					if (!white(b) && b !== 44 && b !== 125 && b !== 93) continue;
					complete(pos);
				} else {
					if (s.quote) {
						if (s.escape) s.escape = false;
						else if (b === 92) s.escape = true;
						else if (b === 34) {
							s.quote = false;
							if (s.kind === "string") complete(pos + 1);
						}
					} else if (b === 34) s.quote = true;
					else if (b === 123 || b === 91) s.depth++;
					else if ((b === 125 || b === 93) && !--s.depth) complete(pos + 1);
					continue;
				}
			}
			const parent = stack.at(-1);
			if (key) {
				if (key.length < 80) key.push(b);
				else bigKey = true;
				if (escaped) escaped = false;
				else if (b === 92) escaped = true;
				else if (b === 34) {
					parent!.name = bigKey ? undefined : JSON.parse(Buffer.from(key).toString("utf8"));
					parent!.phase = "colon";
					key = undefined;
				}
				continue;
			}
			if (white(b)) continue;
			if (parent?.phase === "key") {
				if (b === 125) {
					stack.pop();
					continue;
				}
				if (b !== 34) throw new SyntaxError("Expected JSON key");
				parent.member = pos;
				key = [b];
				bigKey = escaped = false;
				continue;
			}
			if (parent?.phase === "colon") {
				if (b !== 58) throw new SyntaxError("Expected JSON colon");
				parent.phase = "value";
				continue;
			}
			if (parent?.phase === "after") {
				if (b === 125 || b === 93) {
					stack.pop();
					continue;
				}
				if (b !== 44) throw new SyntaxError("Expected JSON separator");
				if (parent.last) parent.last.next = pos;
				parent.last = undefined;
				parent.comma = pos;
				parent.phase = parent.kind === "object" ? "key" : "value";
				continue;
			}
			if (parent?.kind === "array" && b === 93) {
				stack.pop();
				continue;
			}
			const wanted = parent
				? parent.kind === "array"
					? parent.node.children.get(parent.index)
					: parent.name === undefined
						? undefined
						: parent.node.children.get(parent.name)
				: root;
			if (parent) {
				if (parent.kind === "array") parent.member = pos;
				parent.index++;
				parent.phase = "after";
				parent.last = undefined;
			}
			if (wanted) for (const name of wanted.names) result.delete(name); // the last occurrence of a key wins
			if (wanted?.children.size && (b === 123 || b === 91)) {
				stack.push({
					node: wanted,
					kind: b === 123 ? "object" : "array",
					phase: b === 123 ? "key" : "value",
					start: pos,
					index: 0,
					member: pos,
				});
				continue;
			}
			skipping = {
				start: pos,
				parent,
				target: wanted?.name,
				kind: b === 34 ? "string" : b === 123 || b === 91 ? "container" : "atom",
				depth: 1,
				quote: b === 34,
				escape: false,
			};
		}
		base += chunk.length;
	}
	if (skipping?.kind === "atom") complete(base);
	if (stack.length || skipping || key) throw new SyntaxError("Incomplete JSON entry");
	return result;
}

export async function valueAt(chunks: AsyncIterable<Uint8Array>, bytes: number): Promise<unknown> {
	const parts: Uint8Array[] = [];
	let left = bytes;
	for await (const chunk of chunks) {
		const part = chunk.subarray(0, left);
		parts.push(part);
		left -= part.length;
		if (!left) break;
	}
	if (left) throw new Error("Incomplete renderer input");
	return JSON.parse(Buffer.concat(parts).toString("utf8"));
}

export function editsFor(inputs: readonly { span: JsonSpan; json: string | undefined }[]) {
	const edits: { start: number; end: number; bytes: Uint8Array }[] = [];
	const ordered = [...inputs].sort((a, b) => a.span.member - b.span.member);
	for (let i = 0; i < ordered.length; i++) {
		const { span, json } = ordered[i]!;
		if (json !== undefined) {
			edits.push({ start: span.start, end: span.end, bytes: Buffer.from(json) });
			continue;
		}
		let end = span.end;
		if (!span.ordinal) {
			let last = span;
			while (i + 1 < ordered.length) {
				const next = ordered[i + 1]!;
				if (next.json !== undefined || next.span.parent !== span.parent || next.span.ordinal !== last.ordinal + 1)
					break;
				last = next.span;
				i++;
			}
			end = last.next === undefined ? last.end : last.next + 1;
		}
		edits.push({ start: span.previous ?? span.member, end, bytes: new Uint8Array() });
	}
	return edits;
}
export async function* patchJson(chunks: AsyncIterable<Uint8Array>, edits: ReturnType<typeof editsFor>) {
	let base = 0,
		i = 0;
	for await (const bytes of chunks) {
		const end = base + bytes.length;
		let at = 0;
		while (i < edits.length) {
			const e = edits[i]!;
			if (e.start >= end) break;
			if (e.start >= base) {
				if (e.start - base > at) yield bytes.subarray(at, e.start - base);
				for (let i = 0; i < e.bytes.length; i += 65536) yield e.bytes.subarray(i, i + 65536);
			}
			at = Math.min(bytes.length, Math.max(at, e.end - base));
			if (e.end > end) break;
			i++;
		}
		if (at < bytes.length) yield bytes.subarray(at);
		base = end;
	}
	if (i !== edits.length) throw new Error("Incomplete renderer source entry");
}

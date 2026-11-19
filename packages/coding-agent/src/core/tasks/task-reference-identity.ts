import { createHash } from "node:crypto";
import { jsonParser } from "stream-json/core/parser.js";
export type IdentityBytes = () => AsyncIterable<Uint8Array>;
const tailLimit = 17;
/** The root object's ID, decoded in chunks without packing nested strings. Multiple ID properties take the last
 * string, as JSON.parse does; the selected occurrence is discovered without retaining the ID. */
async function* idTokens(chunks: IdentityBytes): AsyncGenerator<{ occurrence: number; text: string }, void> {
	const parse = jsonParser({ packValues: false, packNumbers: false, streamNumbers: true, maxDepth: Infinity }),
		decoder = new TextDecoder("utf-8", { fatal: true });
	let depth = 0,
		inKey = false,
		key = "",
		id = false,
		active = false,
		occurrence = 0;
	for await (const chunk of chunks())
		for (let at = 0; at < chunk.length; at += 16384) {
			const result = parse(decoder.decode(chunk.subarray(at, at + 16384), { stream: true }));
			if (typeof result === "symbol") continue;
			for (const t of result.values) {
				switch (t.name) {
					case "startObject":
					case "startArray":
						depth++;
						id = false;
						break;
					case "endObject":
					case "endArray":
						depth--;
						break;
					case "startKey":
						if (depth === 1) {
							inKey = true;
							key = "";
							id = false;
						}
						break;
					case "endKey":
						if (depth === 1) {
							inKey = false;
							id = key === "id";
						}
						break;
					case "startString":
						if (depth === 1 && id) {
							active = true;
							occurrence++;
							yield { occurrence, text: "" };
						}
						break;
					case "endString":
						if (active) {
							active = false;
							id = false;
						}
						break;
					case "stringChunk":
						if (inKey && key.length < 3) key += t.value.slice(0, 3 - key.length);
						else if (active) yield { occurrence, text: t.value };
						break;
					default:
						break;
				}
			}
		}
}
function hash() {
	return createHash("sha256");
}
interface Identity {
	digest: string;
	length: number;
	parts(): AsyncGenerator<string, void>;
}
async function* adjusted(chunks: IdentityBytes, occ: number, drop: number, add: string): AsyncGenerator<string, void> {
	let tail = "";
	for await (const token of idTokens(chunks)) {
		if (token.occurrence !== occ) continue;
		const s = tail + token.text,
			split = Math.max(0, s.length - drop);
		if (split) yield s.slice(0, split);
		tail = s.slice(split);
	}
	if (add) yield add;
}
export async function identityViews(chunks: IdentityBytes, index?: number) {
	let prefix = hash(),
		tail = "",
		length = 0,
		occ = 0;
	for await (const token of idTokens(chunks)) {
		if (token.occurrence !== occ) {
			occ = token.occurrence;
			prefix = hash();
			tail = "";
			length = 0;
		}
		length += token.text.length;
		const text = tail + token.text,
			split = Math.max(0, text.length - tailLimit);
		if (split) prefix.update(text.slice(0, split), "utf16le");
		tail = text.slice(split);
	}
	const view = (drop: number, add: string): Identity => ({
		digest: prefix
			.copy()
			.update(tail.slice(0, tail.length - drop) + add, "utf16le")
			.digest("hex"),
		length: length - drop + add.length,
		parts: () => adjusted(chunks, occ, drop, add),
	});
	const scalar = index === undefined,
		match = scalar ? /:((?:0|[1-9]\d{0,15}))$/.exec(tail) : undefined;
	const block = scalar ? (match && Number.isSafeInteger(Number(match[1])) ? Number(match[1]) : undefined) : index;
	const root = view(0, ""),
		compound = scalar ? root : view(0, `:${index}`),
		suffixChars = scalar && match && block !== undefined ? match[0].length : 0;
	return {
		root,
		compound,
		block,
		base: block === undefined ? undefined : scalar ? view(suffixChars, "") : root,
		suffixChars,
	};
}
export function literalIdentity(id: string): Identity {
	return {
		length: id.length,
		digest: hash().update(id, "utf16le").digest("hex"),
		parts: async function* () {
			yield id;
		},
	};
}
/** Hashes only reject mismatches. Equal hash and length are verified against the two original streams. */
export async function equalIdentity(a: Identity, b: Identity): Promise<boolean> {
	if (a.length !== b.length || a.digest !== b.digest) return false;
	const left = a.parts(),
		right = b.parts();
	let x = "",
		y = "";
	try {
		for (;;) {
			while (!x) {
				const n = await left.next();
				if (n.done) break;
				x = n.value;
			}
			while (!y) {
				const n = await right.next();
				if (n.done) break;
				y = n.value;
			}
			if (!x || !y) return x === y;
			const take = Math.min(x.length, y.length);
			if (x.slice(0, take) !== y.slice(0, take)) return false;
			x = x.slice(take);
			y = y.slice(take);
		}
	} finally {
		await left.return();
		await right.return();
	}
}

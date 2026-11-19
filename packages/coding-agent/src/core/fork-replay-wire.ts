/** The provider's canonical, compact JSON for the only two rows authorized by this request. */
export interface ForkReplayWire {
	model: string;
	index: number;
	earlier: string;
	later: string;
}

/** Find the closing, unescaped quote without inspecting every code unit of a long text/image. */
function stringEnd(json: string, start: number): number {
	for (let quote = json.indexOf('"', start + 1); quote !== -1; quote = json.indexOf('"', quote + 1)) {
		let backslashes = 0;
		while (json[quote - backslashes - 1] === "\\") backslashes++;
		if (backslashes % 2 === 0) return quote + 1;
	}
	return json.length;
}

/** Skip one value in the SDK's already-encoded compact JSON. No recursion on nested tool arguments. */
function valueEnd(json: string, start: number): number {
	let depth = 0;
	for (let i = start; i < json.length; i++) {
		const c = json[i];
		if (c === '"') {
			const end = stringEnd(json, i);
			if (!depth) return end;
			i = end - 1;
		} else if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			if (!depth) return i;
			if (--depth === 0) return i + 1;
		} else if (c === "," && !depth) return i;
	}
	return json.length;
}

/** A later assistant (including one materialized by toJSON) invalidates the opening join. */
function userRowEnd(json: string, start: number): number {
	if (json[start] !== "{") return -1;
	let user = false;
	let i = start + 1;
	while (json[i] === '"') {
		const role = json.startsWith('"role":', i);
		i = valueEnd(json, i) + 1;
		if (role) user = json.startsWith('"user"', i);
		i = valueEnd(json, i);
		if (json[i] !== ",") break;
		i++;
	}
	return user && json[i] === "}" ? i + 1 : -1;
}

/** Check the actual model, original pair bytes/slots, and finality in one forward pass. Slice only
 * the earlier row and its comma; don't parse/re-encode the rest or read the live payload again. */
export function repairSerializedForkReplay(pair: ForkReplayWire, body: string): string {
	if (body[0] !== "{") return body;
	let modelMatches = false;
	let cutStart = -1;
	let cutEnd = -1;
	let i = 1;
	while (body[i] === '"') {
		const messages = body.startsWith('"messages":', i);
		const model = body.startsWith('"model":', i);
		i = valueEnd(body, i) + 1;
		if (messages) {
			if (body[i++] !== "[") return body;
			for (let row = 0; i < body.length && body[i] !== "]"; row++) {
				if (row === pair.index) {
					if (!body.startsWith(pair.earlier, i)) return body;
					cutStart = i;
					i += pair.earlier.length;
					cutEnd = i + 1;
				} else if (row === pair.index + 1) {
					if (!body.startsWith(pair.later, i)) return body;
					i += pair.later.length;
				} else if (row > pair.index) {
					i = userRowEnd(body, i);
					if (i < 0) return body;
				} else i = valueEnd(body, i);
				if (body[i] === "]") {
					if (row <= pair.index) return body;
					break;
				}
				if (body[i++] !== ",") return body;
			}
			if (body[i++] !== "]") return body;
		} else {
			if (model) {
				if (!body.startsWith(pair.model, i)) return body;
				modelMatches = true;
			}
			i = valueEnd(body, i);
		}
		if (body[i] === "}") break;
		if (body[i++] !== ",") return body;
	}
	return modelMatches && cutStart >= 0 ? body.slice(0, cutStart) + body.slice(cutEnd) : body;
}

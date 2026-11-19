/** A raw router can be behind a string-only transport: it cannot know how much space another tool has left.
 * Shorten the standalone position to make room for the search position, or leave the original URL alone.
 * Keep its exact byte length so even a reader counting bytes before it sees the URL has the same page boundary.
 */
interface CompactTemplate {
	before: string;
	after: string;
	room: number;
}

function base36(text: string): number | undefined {
	const n = Number.parseInt(text, 36);
	return Number.isSafeInteger(n) && n.toString(36) === text ? n : undefined;
}

export function clockText(time: number | undefined): string {
	if (time === undefined || !Number.isFinite(time)) return "x";
	return Number.isSafeInteger(time) ? `t${time.toString(36)}` : `f${String(time).replace("e+", "e")}`;
}

export function clockValue(text: string | undefined): number | undefined {
	if (text?.startsWith("t")) return base36(text.slice(1));
	if (text?.startsWith("f")) {
		const time = Number(text.slice(1));
		if (clockText(time) === text) return time;
	}
	return undefined;
}

export const MAX_POSITION_LENGTH = 4096;

export function searchPosition(text: string | null, domain: string | undefined): string | undefined {
	if (text === null) return undefined;
	if (text.length <= MAX_POSITION_LENGTH) {
		if (domain === "sessions" && /^(?:c|s\.[\w.-]+|v-?[a-z0-9]+\.[a-z0-9]+(?:~-?[a-z0-9]+\.[a-z0-9]+)*)$/.test(text))
			return text;
		if (domain === "workflows" && /^(?:p|x|[tf][\w.-]+)(?:~[\w.-]+)?$/.test(text)) {
			const [clock] = text.split("~", 1);
			if (clock === "p" || clock === "x" || clockValue(clock) !== undefined) return text;
		}
	}
	throw new Error("Invalid history search position; follow the continuation given by the search");
}

export function frozenClocks(position: string): Map<number, number> {
	const clocks = new Map<number, number>();
	for (const pair of position.slice(1).split("~")) {
		const [created, delta] = pair.split(".").map(base36);
		if (created === undefined || delta === undefined || !Number.isSafeInteger(created + delta))
			throw new Error("Invalid history search position; follow the continuation given by the search");
		clocks.set(created, created + delta);
	}
	return clocks;
}

export function compactTemplate(url: string, keepRun: boolean): CompactTemplate | undefined {
	let before: string,
		after = "";
	if (url.startsWith("history://sessions?")) {
		const match = /&after=(-?\d+)\.(-?\d+)(?=\.|$)/.exec(url) ?? /\?after=(-?\d+)\.(-?\d+)(?=\.|$)/.exec(url);
		if (!match) return undefined;
		const active = Number(match[1]),
			created = Number(match[2]),
			delta = created - active;
		if (![active, created, delta].every(Number.isSafeInteger)) return undefined;
		before = `${url.slice(0, match.index)}${match[0][0]}after=${active.toString(36)}.${delta ? delta.toString(36) : ""}${url.slice(match.index + match[0].length)}&o=`;
	} else if (url.startsWith("history://workflows?")) {
		const params = new URLSearchParams(url.slice(url.indexOf("?") + 1));
		const run = params.get("run");
		if (!run) return undefined;
		const offset = Number(params.get("offset") ?? 0),
			limit = params.get("limit"),
			cursor = params.get("cursor");
		if (!Number.isSafeInteger(offset)) return undefined;
		before = `history://workflows?p=${offset.toString(36)}${limit ? `.${Number(limit).toString(36)}` : ""}${cursor ? `=${cursor}` : ""}*`;
		const encoded = new URLSearchParams({ run }).toString();
		after = keepRun ? `&${encoded}` : `*${encoded.slice(4)}`;
	} else return undefined;
	const room = url.length - before.length - after.length;
	return room > 0 ? { before, after, room } : undefined;
}

export function compactUrl(template: CompactTemplate, state: string): string {
	return template.before + state + "!".repeat(template.room - state.length) + template.after;
}

/** Expand only the new spellings. Legacy inputs aren't reserialized, even if they contain unusual escaping. */
export function expandSearchUrl(url: string): { url: string; state: string } | undefined {
	if (!/[?&](?:o|p)=/.test(url)) return undefined;
	const at = url.indexOf("?");
	const path = url.slice(0, at),
		params = new URLSearchParams(url.slice(at + 1));
	const invalid = () => {
		throw new Error("Invalid history search position; follow the continuation given by the search");
	};
	if (path === "history://sessions" && params.has("o")) {
		const field = params.get("o")!;
		const match = /^(-?[a-z0-9]+)\.(-?[a-z0-9]*)(\..+)?$/s.exec(params.get("after") ?? "");
		if (!match) return invalid();
		const active = base36(match[1]!),
			delta = match[2] ? base36(match[2]) : 0;
		if (active === undefined || delta === undefined || !Number.isSafeInteger(active + delta)) return invalid();
		params.set("after", `${active}.${active + delta}${match[3] ?? ""}`);
		params.delete("o");
		return { url: `${path}?${params}`, state: field.replace(/!+$/, "") };
	}
	if (path === "history://workflows" && params.has("p")) {
		if ([...params.keys()].some((key) => key !== "p" && key !== "run")) return invalid();
		const match = /^([a-z0-9]+)(?:\.([a-z0-9]+))?(?:=([\d.]+))?\*([^*]+)(?:\*(.+))?$/s.exec(params.get("p")!);
		if (!match) return invalid();
		const offset = base36(match[1]!),
			limit = match[2] ? base36(match[2]) : undefined;
		const run = match[5] ?? params.get("run");
		if (offset === undefined || (match[2] && limit === undefined) || !run || (match[5] && params.has("run")))
			return invalid();
		const plain = new URLSearchParams();
		if (offset) plain.set("offset", String(offset));
		if (limit !== undefined) plain.set("limit", String(limit));
		plain.set("run", run);
		if (match[3]) plain.set("cursor", match[3]);
		return { url: `${path}?${plain}`, state: match[4]!.replace(/!+$/, "") };
	}
	return undefined;
}

/** Independent new routers can return only text, not the current SDK call's note metadata. Expand their compact
 * protocol notes for deduplication too. Malformed or ordinary extension text is never rewritten or rejected.
 */
export function originalHistoryNote(line: string): string | undefined {
	const label =
		/^history:\/\/(sessions|workflows)(?:\?[^:\n]*)?:0: \[(?:searched (sessions|workflows|workflow runs) (?:(?:none|\d+-\d+) of \d+|0 of \d+\+)[,;]|the time budget ran out waiting for the store;)/.exec(
			line,
		);
	if (
		!label ||
		!line.endsWith("]") ||
		(label[2] && label[1] !== (label[2] === "workflow runs" ? "workflows" : label[2]))
	)
		return undefined;
	const marker = "; continue with ";
	const at = line.lastIndexOf(marker);
	if (at < 0) return undefined;
	const start = at + marker.length;
	if (!line.startsWith("history://", start)) return undefined;
	const r = line.indexOf(":", start + "history://".length);
	const end = r < 0 ? line.length - 1 : r;
	const url = line.slice(start, end);
	try {
		const expanded = expandSearchUrl(url);
		const domain = url.startsWith("history://sessions?")
			? "sessions"
			: url.startsWith("history://workflows?")
				? "workflows"
				: undefined;
		if (!expanded || domain !== label[1]) return undefined;
		const allowed =
			domain === "sessions"
				? ["offset", "limit", "project", "session", "cursor", "after"]
				: ["offset", "limit", "run", "cursor"];
		if (
			[...new URLSearchParams(expanded.url.slice(expanded.url.indexOf("?") + 1)).keys()].some(
				(key) => !allowed.includes(key),
			)
		)
			return undefined;
		searchPosition(expanded.state, domain);
		const template = compactTemplate(expanded.url, url.includes("&run="));
		if (!template || expanded.state.length > template.room || compactUrl(template, expanded.state) !== url)
			return undefined;
		return line.slice(0, start) + expanded.url + line.slice(end);
	} catch {
		return undefined;
	}
}

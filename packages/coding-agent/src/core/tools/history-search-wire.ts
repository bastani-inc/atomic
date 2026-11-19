/** A raw router can be behind a string-only transport: it cannot know how much space another tool has left.
 * Shorten the standalone position to make room for the search position, or leave the original URL alone.
 * Keep its exact byte length so even a reader counting bytes before it sees the URL has the same page boundary.
 */
interface CompactTemplate {
	before: string;
	room: number;
}

function base36(text: string): number | undefined {
	const n = Number.parseInt(text, 36);
	return Number.isSafeInteger(n) && n.toString(36) === text ? n : undefined;
}

export const MAX_POSITION_LENGTH = 4096;

export function searchPosition(text: string | null, domain: string | undefined): string | undefined {
	if (text === null) return undefined;
	if (text.length <= MAX_POSITION_LENGTH) {
		if (domain === "sessions" && /^(?:c|s\.[\w.-]+|v-?[a-z0-9]+\.[a-z0-9]+(?:~-?[a-z0-9]+\.[a-z0-9]+)*)$/.test(text))
			return text;
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

export function compactTemplate(url: string): CompactTemplate | undefined {
	if (!url.startsWith("history://sessions?")) return undefined;
	const match = /&after=(-?\d+)\.(-?\d+)(?=\.|$)/.exec(url) ?? /\?after=(-?\d+)\.(-?\d+)(?=\.|$)/.exec(url);
	if (!match) return undefined;
	const active = Number(match[1]),
		created = Number(match[2]),
		delta = created - active;
	if (![active, created, delta].every(Number.isSafeInteger)) return undefined;
	const before = `${url.slice(0, match.index)}${match[0][0]}after=${active.toString(36)}.${delta ? delta.toString(36) : ""}${url.slice(match.index + match[0].length)}&o=`;
	const room = url.length - before.length;
	return room > 0 ? { before, room } : undefined;
}

export function compactUrl(template: CompactTemplate, state: string): string {
	return template.before + state + "!".repeat(template.room - state.length);
}

/** Expand only the new spellings. Legacy inputs aren't reserialized, even if they contain unusual escaping. */
export function expandSearchUrl(url: string): { url: string; state: string } | undefined {
	if (!/[?&]o=/.test(url)) return undefined;
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
	return undefined;
}

/** Check the whole notice, not just its opening words: other resources can quote or annotate a history URL. */
function isCoverageNotice(label: string, description: string, next: URLSearchParams): boolean {
	const params = new URLSearchParams(label);
	const page = new URLSearchParams();
	const offset = params.get("offset");
	if (offset !== null && /^[1-9]\d*$/.test(offset)) page.set("offset", offset);
	for (const key of ["limit", "project"]) {
		const value = next.get(key);
		if (value !== null) page.set(key, value);
	}
	if (String(page) !== label) return false;
	if (
		/^searched sessions 0 of (\d+)\+; the (?:time|row|byte) budget ran out after scanning \1 sessions$/.test(
			description,
		)
	)
		return true;
	const coverage = /^searched sessions (?:none|([1-9]\d*)-([1-9]\d*)) of (0|[1-9]\d*)(?:, [1-9]\d* unreadable)?/.exec(
		description,
	);
	if (!coverage) return false;
	const begin = Number(offset),
		end = coverage[2] === undefined ? begin : Number(coverage[2]),
		total = Number(coverage[3]);
	if (coverage[1] !== undefined && (Number(coverage[1]) !== begin + 1 || end <= begin || end > total)) return false;
	const rest = description.slice(coverage[0].length);
	if (!rest) return Number(next.get("offset")) === end && end < total;
	const stop = /^; the (?:time|row|byte) budget ran out(?: at entry \d+(?: of \d+)?)?/.exec(rest);
	if (!stop) return false;
	const where = rest.slice(stop[0].length);
	if (!where) return !stop[0].includes(" at entry ");
	const id = next.get("session");
	if (id === null) return false;
	const project = next.get("project");
	const location = ` in history://sessions/${id}${project === null ? "" : `?project=${encodeURIComponent(project)}`}`;
	if (!where.startsWith(location)) return false;
	const skipped = where.slice(location.length);
	return (
		!skipped ||
		/^; entry \d+(?: in history:\/\/sessions\/[^\n]+)? not searched(?:: the pattern ran past the time budget on it)?$/.test(
			skipped,
		)
	);
}

/** An independent router can return only text. Compare its canonical protocol notes on their original URLs. */
export function originalHistoryNote(line: string): string | undefined {
	const label = /^history:\/\/sessions(?:\?([^:\n]+))?:0: \[/.exec(line);
	if (!label || !line.endsWith("]")) return undefined;
	const marker = "; continue with ";
	const at = line.lastIndexOf(marker);
	if (at < 0) return undefined;
	const start = at + marker.length;
	if (!line.startsWith("history://", start)) return undefined;
	const r = line.indexOf(":", start + "history://".length);
	const end = r < 0 ? line.length - 1 : r;
	const url = line.slice(start, end);
	if (r >= 0 && !/^:\d+-\d+(?:,\d+-\d+)*\]$/.test(line.slice(end))) return undefined;
	try {
		const expanded = expandSearchUrl(url);
		if (!expanded) return undefined;
		const allowed = ["offset", "limit", "project", "session", "cursor", "after"];
		const next = new URLSearchParams(expanded.url.slice(expanded.url.indexOf("?") + 1));
		if ([...next.keys()].some((key) => !allowed.includes(key))) return undefined;
		const description = line.slice(label[0].length, at);
		if (description === "the time budget ran out waiting for the store") {
			if (line.slice(0, label[0].length - 5) !== expanded.url) return undefined;
		} else if (!isCoverageNotice(label[1] ?? "", description, next)) return undefined;
		searchPosition(expanded.state, "sessions");
		const template = compactTemplate(expanded.url);
		if (!template || expanded.state.length > template.room || compactUrl(template, expanded.state) !== url)
			return undefined;
		return line.slice(0, start) + expanded.url + line.slice(end);
	} catch {
		return undefined;
	}
}

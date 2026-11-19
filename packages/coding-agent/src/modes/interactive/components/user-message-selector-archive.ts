import type { Token } from "stream-json/core/parser.js";
import type { SessionEntry, SessionManager } from "../../../core/session-manager.ts";
import {
	type Reader,
	read,
	readValue,
	skip,
	stringValue,
} from "../../../core/storage/session/chunked-resume-projection.js";

type Archive = ReturnType<SessionManager["captureArchive"]>;

/**
 * UTF-16 code units of a prompt's one-line label that a /fork row keeps. A row is drawn on one terminal line, so a
 * longer prompt keeps only this start of its label, and a search reads the rest of it from the session store.
 */
export const FORK_LABEL_CHARS = 1024;

/** A prompt as the /fork picker lists it. `text` is the whole prompt, or only the start of its label when `partial`. */
export interface ForkPrompt {
	readonly entryId: string;
	readonly text: string;
	readonly partial?: true;
}

/** Receives a prompt's text in pieces. A piece of a block whose type is not yet known can be taken back. */
interface TextSink {
	push(piece: string): void;
	mark(): unknown;
	reset(mark: unknown): void;
}

/** The prompt's label as the picker shows it (`text.replace(/\s+/g, " ").trim()`), kept to `limit` code units. */
class LabelSink implements TextSink {
	private text = "";
	private space = false;
	/** Some of the label did not fit. */
	private cut = false;
	/** Any text arrived, even whitespace; the picker lists such a prompt with a blank label. */
	private any = false;
	private readonly limit: number;

	constructor(limit: number) {
		this.limit = limit;
	}

	push(piece: string): void {
		if (!piece) return;
		this.any = true;
		if (this.cut) return;
		for (const [run] of piece.matchAll(/\s+|\S+/g)) {
			if (/\s/.test(run[0]!)) {
				if (this.text) this.space = true;
				continue;
			}
			const gap = this.space ? " " : "";
			const room = this.limit - this.text.length - gap.length;
			if (run.length <= room) {
				this.text += gap + run;
				this.space = false;
				continue;
			}
			if (room > 0) this.text += gap + run.slice(0, room);
			this.cut = true;
			return;
		}
	}

	mark(): unknown {
		return [this.text, this.space, this.cut, this.any];
	}

	reset(mark: unknown): void {
		[this.text, this.space, this.cut, this.any] = mark as [string, boolean, boolean, boolean];
	}

	result(): { text: string; partial: boolean } | undefined {
		if (!this.any) return undefined;
		// A cut never ends a row on half of a surrogate pair.
		const text = this.cut && /[\uD800-\uDBFF]$/.test(this.text) ? this.text.slice(0, -1) : this.text;
		return { text, partial: this.cut };
	}
}

/** The prompt's whole text, joined as the in-memory picker joins it. Lives only while one search reads one row. */
class WholeTextSink implements TextSink {
	readonly pieces: string[] = [];
	push(piece: string): void {
		if (piece) this.pieces.push(piece);
	}
	mark(): unknown {
		return this.pieces.length;
	}
	reset(mark: unknown): void {
		this.pieces.length = mark as number;
	}
}

/** The text of a held user prompt, extracted as `AgentSession.getUserMessagesForForking` does. */
function heldPromptText(entry: SessionEntry): string | undefined {
	if (entry.type !== "message" || entry.message.role !== "user") return undefined;
	const content = entry.message.content as string | Array<{ type: string; text?: string }>;
	if (typeof content === "string") return content;
	if (Array.isArray(content))
		return content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	return "";
}

function* stringPieces(sink: TextSink): Reader<null> {
	for (let token = yield; token.name === "stringChunk"; token = yield) sink.push(token.value);
	return null;
}

/** One content block: its `text` counts only when its `type` is `text`, in whichever order the store keeps the keys. */
function* blockText(first: Token, sink: TextSink): Reader<null> {
	if (first.name !== "startObject") {
		yield* skip(first);
		return null;
	}
	const mark = sink.mark();
	let type: string | undefined;
	let pushed = false;
	while ((yield).name !== "endObject") {
		const key = yield* stringValue(5);
		const value = yield;
		if (key === "type" && value.name === "startString") type = yield* stringValue(5);
		else if (key === "text" && value.name === "startString" && (type === undefined || type === "text")) {
			yield* stringPieces(sink);
			pushed = true;
		} else yield* skip(value);
	}
	if (pushed && type !== "text") sink.reset(mark);
	return null;
}

function* contentText(first: Token, sink: TextSink): Reader<null> {
	if (first.name === "startString") return yield* stringPieces(sink);
	if (first.name !== "startArray") {
		yield* skip(first);
		return null;
	}
	for (let item = yield; item.name !== "endArray"; item = yield) yield* blockText(item, sink);
	return null;
}

/** Streams a saved user prompt's text into `sink` without parsing the entry into an object. */
async function readPromptText(chunks: AsyncIterable<Uint8Array>, sink: TextSink): Promise<void> {
	await read(
		chunks,
		(function* (): Reader<unknown> {
			return yield* readValue(yield, { message: { content: (first: Token) => contentText(first, sink) } });
		})(),
	);
}

/**
 * The prompts of a session whose older history stays in its store, for the /fork picker. It lists every user prompt
 * of every branch in append order, as the picker always has, but keeps at most {@link FORK_LABEL_CHARS} of each, and
 * reads a longer prompt again only while a search needs all of it. Reads are pinned to the session generation and
 * entries captured when the picker opened.
 */
export class ForkPromptArchive {
	private readonly archive: Archive;
	/** Sequence numbers of the rows listed as partial. */
	private readonly partial = new Map<string, number>();

	private constructor(archive: Archive) {
		this.archive = archive;
	}

	static async open(
		manager: SessionManager,
		signal?: AbortSignal,
	): Promise<{ prompts: ForkPrompt[]; archive: ForkPromptArchive }> {
		const view = new ForkPromptArchive(manager.captureArchive());
		const prompts: ForkPrompt[] = [];
		for await (const page of view.archive.outline(signal))
			for (const row of page) {
				if (row.type !== "message" || row.role !== "user") continue;
				const label = new LabelSink(FORK_LABEL_CHARS);
				const held = view.archive.held.get(row.seq);
				if (held) label.push(heldPromptText(held) ?? "");
				else await readPromptText(view.archive.bytes(row.seq, signal), label);
				const listed = label.result();
				if (!listed) continue;
				if (listed.partial) view.partial.set(row.id, row.seq);
				prompts.push({ entryId: row.id, text: listed.text, ...(listed.partial ? { partial: true as const } : {}) });
			}
		return { prompts, archive: view };
	}

	/** The whole text of a prompt listed as partial, read from the store for one search and not kept. */
	async readText(entryId: string, signal: AbortSignal): Promise<string> {
		const seq = this.partial.get(entryId);
		if (seq === undefined) throw new Error(`Prompt ${entryId} is not in this picker`);
		const held = this.archive.held.get(seq);
		if (held) return heldPromptText(held) ?? "";
		const whole = new WholeTextSink();
		await readPromptText(this.archive.bytes(seq, signal), whole);
		signal.throwIfAborted();
		return whole.pieces.join("");
	}

	dispose(): void {
		this.partial.clear();
		this.archive.held.clear();
	}
}

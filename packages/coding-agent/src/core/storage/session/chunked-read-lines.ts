import type { Token } from "stream-json/core/parser.js";
import { TerminalTextSanitizer } from "../../../utils/terminal-text.ts";
import { type Reader, skip, stringValue } from "./chunked-resume-projection.js";

// Read's ordinary presenter drops selector headers, the optional final truncation footer and trailing newlines.
// Keep enough of a candidate header to recognize it, never a whole payload-sized line.
const PREFIX = 256;
const SELECTOR = /^\[Lines \d+-\d+ of \d+\]$/;
const FOOTER =
	/^\[(?:Showing lines \d+-\d+ of \d+(?:[^\]\d][^\]]*)?|\d+ more lines in file\. Continue with path selector :\d+\.)\]\s*$/;
class ReadLines {
	private prefix = "";
	preview = "";
	private long = false;
	private white = true;
	private count = 0;
	private blanks = 0;
	private seen = 0;
	private beforeFooter: number | undefined;
	private ambiguous = false;
	copy(): ReadLines {
		return Object.assign(new ReadLines(), this);
	}
	append(text: string): void {
		if (this.preview.length < PREFIX) this.preview += text.slice(0, PREFIX - this.preview.length);
		for (let start = 0; start < text.length; ) {
			const end = text.indexOf("\n", start),
				part = text.slice(start, end < 0 ? text.length : end);
			this.long ||= this.prefix.length + part.length > PREFIX;
			if (this.prefix.length < PREFIX) this.prefix += part.slice(0, PREFIX - this.prefix.length);
			this.white &&= part.trim() === "";
			if (end < 0) break;
			this.line();
			start = end + 1;
		}
	}
	private line(): void {
		if (!this.prefix) {
			this.blanks++;
			this.seen++;
			return;
		}
		const prior = this.count;
		if (this.long && /^(?:\[Lines \d|\[Showing lines \d|\[\d+ more lines)/.test(this.prefix)) this.ambiguous = true;
		const footer = !this.long && FOOTER.test(this.prefix) && this.blanks > 0 && this.seen >= 2;
		this.count += this.blanks + (!this.long && SELECTOR.test(this.prefix) ? 0 : 1);
		if (footer) this.beforeFooter = prior;
		else if (!this.white) this.beforeFooter = undefined;
		this.seen++;
		this.blanks = 0;
		this.prefix = "";
		this.long = false;
		this.white = true;
	}
	finish(): number | null {
		this.line();
		return this.ambiguous ? null : (this.beforeFooter ?? this.count);
	}
}

/** Apply the same joining rule as the read card: text blocks only, separated by one newline. A type or text field
 * can come last or repeat. Count against a copy and accept it only when the final type is text. */
export interface SavedReadImage {
	header: string;
	mimeType?: string;
	bytes?: number;
	dimensionHint?: string;
}
interface ReadContentSummary {
	lines: number | null;
	image?: SavedReadImage;
}
/** The byte length and just the header of the first image, not its decoded data. */
function* imageHeader(): Reader<{ header: string; bytes: number }> {
	let symbols = 0,
		header = "",
		padded = false;
	for (let t = yield; t.name === "stringChunk"; t = yield) {
		if (padded) continue;
		const end = t.value.indexOf("=");
		padded = end >= 0;
		const chars = (padded ? t.value.slice(0, end) : t.value).replace(/[^A-Za-z0-9+/_-]/g, "");
		symbols += chars.length;
		if (header.length < 1024) header += chars.slice(0, 1024 - header.length);
	}
	return { header, bytes: Math.floor((3 * symbols) / 4) };
}
export function* readContentLines(first: Token): Reader<ReadContentSummary> {
	if (first.name !== "startArray") {
		yield* skip(first);
		return { lines: null };
	}
	let count = new ReadLines(),
		any = false;
	let image: SavedReadImage | undefined;
	for (let part = yield; part.name !== "endArray"; part = yield) {
		if (part.name !== "startObject") {
			yield* skip(part);
			continue;
		}
		let type: string | undefined,
			candidate: ReadLines | undefined,
			mimeType: string | undefined,
			data: { header: string; bytes: number } | undefined;
		while ((yield).name !== "endObject") {
			const key = yield* stringValue(9),
				value = yield;
			if (key === "type" && value.name === "startString") type = yield* stringValue(6);
			else if (key === "mimeType" && value.name === "startString") mimeType = yield* stringValue(128);
			else if (!image && key === "data" && value.name === "startString") data = yield* imageHeader();
			else if (key === "text" && value.name === "startString") {
				candidate = count.copy();
				if (any) candidate.append("\n");
				const display = new TerminalTextSanitizer();
				for (let t = yield; t.name === "stringChunk"; t = yield) candidate.append(display.write(t.value));
				candidate.append(display.end());
			} else {
				if (key === "type") type = undefined;
				if (key === "text") candidate = undefined;
				yield* skip(value);
			}
		}
		if (type === "text" && candidate) {
			count = candidate;
			any = true;
		}
		if (!image && type === "image")
			image = { header: data?.header ?? "", bytes: data?.header ? data.bytes : undefined, mimeType };
	}
	if (image || /^Read image file \[/i.test(count.preview)) {
		const dimensionHint = /\d+\s*[x×]\s*\d+/.exec(count.preview)?.[0];
		return { lines: null, image: { header: "", ...image, dimensionHint } };
	}
	return { lines: count.finish() };
}

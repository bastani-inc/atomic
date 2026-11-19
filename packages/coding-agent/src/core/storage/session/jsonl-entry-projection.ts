import type { SessionEntry, WorktreeRestoreHostWarning } from "../../session-manager-types.ts";
import { validRestoreHostWarning } from "./entry-structure.js";

/**
 * One byte-level pass over an oversized saved entry. It checks the JSON text as `JSON.parse` would and keeps only the
 * fields that entry validation and the resume fold read. A kept value of at most {@link KEEP_BYTES} is decoded by
 * `JSON.parse` itself, so its escapes, numbers and duplicate keys (the last one wins) are exactly those of a whole
 * parse. A larger value that validation or the fold only tests by kind or truthiness is replaced by a value of the same
 * kind; one they compare is kept whole. The bytes of everything else, such as a message body, are skipped unretained.
 */
const KEEP_BYTES = 4096;

type Spec =
	| { readonly kind: "skip" | "leaf" | "exact" | "present" | "tools" }
	| { readonly kind: "object"; readonly keys: Readonly<Record<string, Spec>>; readonly rest: Spec }
	| { readonly kind: "array"; readonly item: Spec }
	| { readonly kind: "every"; readonly item: Spec; readonly test: (value: unknown) => boolean };

const skip: Spec = { kind: "skip" };
/** Tested only by kind or truthiness: a large string, object or array is replaced by one of the same kind. */
const leaf: Spec = { kind: "leaf" };
/** Compared or copied into the index: always kept whole. */
const exact: Spec = { kind: "exact" };
/** Only the property name matters. */
const present: Spec = { kind: "present" };
const object = (keys: Record<string, Spec>, rest: Spec = skip): Spec => ({ kind: "object", keys, rest });
const every = (item: Spec, test: (value: unknown) => boolean): Spec => ({ kind: "every", item, test });
const strings = every(leaf, (value) => typeof value === "string");
const protocolMessage = object({ id: exact, replyTo: exact, expectsReply: exact });

// Every field of every entry type that entry-structure.ts, validation.ts and the fold in session-resume.ts read.
const ENTRY = object({
	type: exact,
	id: exact,
	parentId: exact,
	timestamp: exact,
	customType: exact,
	message: object({
		role: exact,
		timestamp: exact,
		provider: exact,
		model: exact,
		usage: exact,
		toolCallId: exact,
		content: { kind: "tools" },
		command: leaf,
		output: leaf,
		cancelled: exact,
		truncated: exact,
		summary: leaf,
		fromId: leaf,
	}),
	thinkingLevel: leaf,
	provider: exact,
	modelId: exact,
	kind: leaf,
	model: leaf,
	usage: exact,
	summary: leaf,
	firstKeptEntryId: exact,
	firstKeptEntryIndex: leaf,
	coveredThroughEntryId: exact,
	tokensBefore: exact,
	systemMessage: object({ timestamp: exact }),
	details: object({
		strategy: exact,
		protectedReconciliationOf: exact,
		requestId: exact,
		message: protocolMessage,
		historyOnly: exact,
	}),
	promptVersion: exact,
	deletedTargets: leaf,
	protectedEntryIds: leaf,
	stats: leaf,
	fromId: leaf,
	data: object(
		{
			completionId: exact,
			ownerId: exact,
			taskId: exact,
			sessionId: exact,
			intercomSessionId: exact,
			homeGroup: exact,
			groups: strings,
			kind: exact,
			worktree: exact,
			id: exact,
			timestamp: exact,
			type: exact,
			queries: leaf,
			urls: leaf,
			version: exact,
			index: exact,
			agent: exact,
			cwd: exact,
			runId: exact,
			childId: exact,
			state: exact,
			owner: object({ sessionId: exact }),
			op: exact,
			message: protocolMessage,
			messageId: exact,
			askId: exact,
			toolCallId: exact,
			tasks: { kind: "array", item: object({ ownerId: exact, taskId: exact }) },
			name: leaf,
			ts: exact,
		},
		present,
	),
	content: leaf,
	display: exact,
	stageAdmissionKey: exact,
	protectedReconciliation: leaf,
	replacement: object({ content: leaf }),
	targetId: exact,
	label: leaf,
	name: leaf,
	summarizedThroughId: exact,
	root: exact,
	snapshotId: exact,
	captureMs: leaf,
	degradedFrom: leaf,
	snapshot: object({ id: exact, tree: leaf, chain: leaf }),
	restore: object({
		from: leaf,
		to: exact,
		snapshotId: exact,
		degraded: object({
			stage: exact,
			head: leaf,
			tree: leaf,
			missingLinks: every(exact, (value) => Number.isInteger(value)),
			missingPaths: strings,
			missingCommits: strings,
			cause: leaf,
			hint: leaf,
		}),
	}),
	unrestored: object({
		snapshotId: exact,
		continuedIn: leaf,
		place: exact,
		from: leaf,
		cause: leaf,
		detail: leaf,
		hint: leaf,
		at: leaf,
	}),
	restoreWarnings: every(object({ code: exact, path: leaf, kind: exact, paths: strings }), (value) =>
		validRestoreHostWarning(value as WorktreeRestoreHostWarning | null),
	),
	blobs: every(leaf, (value) => typeof value === "string"),
});
const TOOL_BLOCK = object({ type: exact });

const S = {
	Value: 0,
	FirstItem: 1,
	FirstKey: 2,
	Key: 3,
	Colon: 4,
	After: 5,
	String: 6,
	Escape: 7,
	Hex: 8,
	Minus: 9,
	Zero: 10,
	Integer: 11,
	Dot: 12,
	Fraction: 13,
	ExponentMark: 14,
	ExponentSign: 15,
	Exponent: 16,
	Literal: 17,
	Invalid: 18,
} as const;
type S = (typeof S)[keyof typeof S];

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const TRUE = Buffer.from("true");
const FALSE = Buffer.from("false");
const NULL = Buffer.from("null");

interface Frame {
	readonly depth: number;
	readonly spec: Spec;
	readonly out: Record<string, unknown> | unknown[];
	key: string | undefined;
	/** "every" over an object: whether each distinct property passes. The last duplicate wins, as in a parse. */
	readonly passes?: Map<string, boolean>;
	failed: boolean;
	tools: number;
}

interface Capture {
	/** The container depth the value started at. */
	readonly depth: number;
	readonly limit: number;
	readonly first: number;
	parts: Buffer[];
	size: number;
	from: number;
	overflow: boolean;
	readonly key: boolean;
}

/** Counts of tool-call blocks for a replaced content array, by the replacement array. */
const toolCounts = new WeakMap<object, number>();

class EntryScanner {
	private state: S = S.Value;
	private depth = 0;
	/** Whether each open container is an object, by depth. */
	private objects = new Uint8Array(64);
	private readonly frames: Frame[] = [];
	/** The depth of the values whose fields are kept: the innermost kept container's, or the root's. */
	private liveDepth = 0;
	private capture: Capture | undefined;
	private literal: Buffer = TRUE;
	private literalAt = 0;
	private hex = 0;
	private stringIsKey = false;
	private started = false;
	result: unknown;

	feed(bytes: Buffer): void {
		const capture = this.capture;
		if (capture) capture.from = 0;
		const length = bytes.length;
		for (let i = 0; i < length && this.state !== S.Invalid; i++) {
			const state = this.state;
			if (state === S.String) {
				let byte = bytes[i]!;
				while (byte !== QUOTE && byte !== BACKSLASH && byte >= 0x20) {
					if (++i === length) break;
					byte = bytes[i]!;
				}
				if (i === length) break;
			} else if (state === S.Integer || state === S.Fraction || state === S.Exponent) {
				let byte = bytes[i]!;
				while (byte >= 0x30 && byte <= 0x39) {
					if (++i === length) break;
					byte = bytes[i]!;
				}
				if (i === length) break;
			}
			this.step(bytes, i);
		}
		const open = this.capture;
		if (open && !open.overflow && this.state !== S.Invalid) this.keep(open, bytes.subarray(open.from));
	}

	finish(): boolean {
		if (this.state === S.Zero || this.state === S.Integer || this.state === S.Fraction || this.state === S.Exponent)
			this.endScalar(undefined, 0);
		return this.started && this.depth === 0 && this.state === S.After;
	}

	private keep(capture: Capture, part: Buffer): void {
		capture.size += part.length;
		if (capture.size > capture.limit) {
			capture.overflow = true;
			capture.parts = [];
		} else if (part.length) capture.parts.push(part);
	}

	private step(bytes: Buffer, i: number): void {
		const byte = bytes[i]!;
		switch (this.state) {
			case S.Value:
				if (!isSpace(byte)) this.startValue(bytes, i);
				return;
			case S.FirstItem:
				if (isSpace(byte)) return;
				if (byte === 0x5d) this.close(bytes, i);
				else this.startValue(bytes, i);
				return;
			case S.FirstKey:
			case S.Key:
				if (isSpace(byte)) return;
				if (byte === QUOTE) this.startKey(i);
				else if (byte === 0x7d && this.state === S.FirstKey) this.close(bytes, i);
				else this.state = S.Invalid;
				return;
			case S.Colon:
				if (!isSpace(byte)) this.state = byte === 0x3a ? S.Value : S.Invalid;
				return;
			case S.After:
				this.after(bytes, i);
				return;
			case S.String:
				if (byte === QUOTE) {
					if (this.stringIsKey) {
						this.state = S.Colon;
						this.endKey(bytes, i + 1);
					} else this.endScalar(bytes, i + 1);
				} else if (byte === BACKSLASH) this.state = S.Escape;
				else this.state = S.Invalid;
				return;
			case S.Escape:
				if (byte === 0x75) {
					this.state = S.Hex;
					this.hex = 4;
				} else
					this.state =
						byte === QUOTE ||
						byte === BACKSLASH ||
						byte === 0x2f ||
						byte === 0x62 ||
						byte === 0x66 ||
						byte === 0x6e ||
						byte === 0x72 ||
						byte === 0x74
							? S.String
							: S.Invalid;
				return;
			case S.Hex:
				if (!isHex(byte)) this.state = S.Invalid;
				else if (--this.hex === 0) this.state = S.String;
				return;
			case S.Minus:
				this.state = byte === 0x30 ? S.Zero : isDigit(byte) ? S.Integer : S.Invalid;
				return;
			case S.Zero:
				if (isDigit(byte)) this.state = S.Invalid;
				else this.afterInteger(bytes, i);
				return;
			case S.Integer:
				if (!isDigit(byte)) this.afterInteger(bytes, i);
				return;
			case S.Dot:
				this.state = isDigit(byte) ? S.Fraction : S.Invalid;
				return;
			case S.Fraction:
				if (isDigit(byte)) return;
				if (byte === 0x65 || byte === 0x45) this.state = S.ExponentMark;
				else this.endNumber(bytes, i);
				return;
			case S.ExponentMark:
				this.state = byte === 0x2b || byte === 0x2d ? S.ExponentSign : isDigit(byte) ? S.Exponent : S.Invalid;
				return;
			case S.ExponentSign:
				this.state = isDigit(byte) ? S.Exponent : S.Invalid;
				return;
			case S.Exponent:
				if (!isDigit(byte)) this.endNumber(bytes, i);
				return;
			case S.Literal:
				if (byte !== this.literal[this.literalAt]) this.state = S.Invalid;
				else if (++this.literalAt === this.literal.length) this.endScalar(bytes, i + 1);
				return;
		}
	}

	private afterInteger(bytes: Buffer, i: number): void {
		const byte = bytes[i]!;
		if (byte === 0x2e) this.state = S.Dot;
		else if (byte === 0x65 || byte === 0x45) this.state = S.ExponentMark;
		else this.endNumber(bytes, i);
	}

	private endNumber(bytes: Buffer, i: number): void {
		this.endScalar(bytes, i);
		this.after(bytes, i);
	}

	private after(bytes: Buffer, i: number): void {
		const byte = bytes[i]!;
		if (isSpace(byte)) return;
		if (this.depth === 0) this.state = S.Invalid;
		else if (byte === 0x2c) this.state = this.objects[this.depth - 1] ? S.Key : S.Value;
		else if (byte === 0x5d && !this.objects[this.depth - 1]) this.close(bytes, i);
		else if (byte === 0x7d && this.objects[this.depth - 1]) this.close(bytes, i);
		else this.state = S.Invalid;
	}

	/** The frame a value at the current depth belongs to, when its fields are kept. */
	private live(): Frame | undefined | null {
		return this.capture || this.depth !== this.liveDepth ? null : this.frames.at(-1);
	}

	private specOf(frame: Frame | undefined): Spec {
		if (frame === undefined) return ENTRY;
		const spec = frame.spec;
		if (spec.kind === "object") return Object.hasOwn(spec.keys, frame.key!) ? spec.keys[frame.key!]! : spec.rest;
		if (spec.kind === "tools") return TOOL_BLOCK;
		if (spec.kind === "array" || spec.kind === "every") return spec.item;
		return skip;
	}

	private startValue(bytes: Buffer, i: number): void {
		const byte = bytes[i]!;
		const frame = this.live();
		if (frame === undefined) this.started = true;
		if (frame !== null) {
			const spec = this.specOf(frame);
			const container = byte === 0x7b || byte === 0x5b;
			if (spec.kind === "present") this.deliver(frame, null);
			else if (
				container &&
				(spec.kind === "every" ||
					(spec.kind === "object" && byte === 0x7b) ||
					((spec.kind === "array" || spec.kind === "tools") && byte === 0x5b))
			) {
				this.liveDepth = this.depth + 1;
				this.frames.push({
					depth: this.depth + 1,
					spec,
					out: byte === 0x7b ? {} : [],
					key: undefined,
					passes: spec.kind === "every" && byte === 0x7b ? new Map() : undefined,
					failed: false,
					tools: 0,
				});
			} else if (spec.kind !== "skip")
				this.capture = {
					depth: this.depth,
					// Only a string, object or array can be replaced by a value of the same kind.
					limit: spec.kind === "exact" || (!container && byte !== QUOTE) ? Infinity : KEEP_BYTES,
					first: byte,
					parts: [],
					size: 0,
					from: i,
					overflow: false,
					key: false,
				};
		}
		switch (byte) {
			case 0x7b:
				this.open(true);
				return;
			case 0x5b:
				this.open(false);
				return;
			case QUOTE:
				this.stringIsKey = false;
				this.state = S.String;
				return;
			case 0x2d:
				this.state = S.Minus;
				return;
			case 0x30:
				this.state = S.Zero;
				return;
			case 0x74:
				this.literal = TRUE;
				break;
			case 0x66:
				this.literal = FALSE;
				break;
			case 0x6e:
				this.literal = NULL;
				break;
			default:
				this.state = isDigit(byte) ? S.Integer : S.Invalid;
				return;
		}
		this.literalAt = 1;
		this.state = S.Literal;
	}

	private startKey(i: number): void {
		this.stringIsKey = true;
		this.state = S.String;
		const frame = this.live();
		if (frame && frame.spec.kind !== "skip")
			this.capture = {
				depth: this.depth,
				limit: Infinity,
				first: QUOTE,
				parts: [],
				size: 0,
				from: i,
				overflow: false,
				key: true,
			};
	}

	private open(isObject: boolean): void {
		if (this.depth === this.objects.length) {
			const grown = new Uint8Array(this.objects.length * 2);
			grown.set(this.objects);
			this.objects = grown;
		}
		this.objects[this.depth++] = isObject ? 1 : 0;
		this.state = isObject ? S.FirstKey : S.FirstItem;
	}

	private close(bytes: Buffer, i: number): void {
		this.depth--;
		this.state = S.After;
		const capture = this.capture;
		if (capture) {
			if (capture.depth === this.depth) this.endCapture(capture, bytes, i + 1);
			return;
		}
		const frame = this.frames.at(-1);
		if (frame === undefined || frame.depth !== this.depth + 1) return;
		this.frames.pop();
		this.liveDepth = this.frames.at(-1)?.depth ?? 0;
		this.deliver(this.live(), this.result_(frame));
	}

	private result_(frame: Frame): unknown {
		const spec = frame.spec;
		if (spec.kind === "every") {
			const failed = frame.passes ? [...frame.passes.values()].includes(false) : frame.failed;
			return Array.isArray(frame.out) ? (failed ? [null] : []) : failed ? { bad: 0 } : {};
		}
		if (spec.kind === "tools") {
			const out: unknown[] = [];
			toolCounts.set(out, frame.tools);
			return out;
		}
		return frame.out;
	}

	private endKey(bytes: Buffer, end: number): void {
		const capture = this.capture;
		if (!capture?.key) return;
		this.capture = undefined;
		this.frames.at(-1)!.key = JSON.parse(this.text(capture, bytes, end)!) as string;
	}

	/** A string, number or literal ended at `end` (exclusive) in `bytes`; `bytes` is absent at the end of the input. */
	private endScalar(bytes: Buffer | undefined, end: number): void {
		this.state = S.After;
		const capture = this.capture;
		if (!capture) return;
		if (capture.depth === this.depth) this.endCapture(capture, bytes, end);
	}

	private endCapture(capture: Capture, bytes: Buffer | undefined, end: number): void {
		this.capture = undefined;
		const text = this.text(capture, bytes, end);
		// A large string stays non-empty (truthy) and a large object or array keeps its kind.
		const value =
			text === undefined ? (capture.first === QUOTE ? "…" : capture.first === 0x7b ? {} : []) : JSON.parse(text);
		this.deliver(this.live(), value);
	}

	/** The captured text, or `undefined` when it grew past the capture's limit. */
	private text(capture: Capture, bytes: Buffer | undefined, end: number): string | undefined {
		if (bytes && !capture.overflow) this.keep(capture, bytes.subarray(capture.from, end));
		if (capture.overflow) return undefined;
		const parts = capture.parts;
		return (parts.length === 1 ? parts[0]! : Buffer.concat(parts)).toString("utf8");
	}

	private deliver(frame: Frame | undefined | null, value: unknown): void {
		if (frame === null) return;
		if (frame === undefined) {
			this.result = value;
			return;
		}
		const spec = frame.spec;
		if (spec.kind === "every") {
			const pass = spec.test(value);
			if (frame.passes) frame.passes.set(frame.key!, pass);
			else if (!pass) frame.failed = true;
		} else if (spec.kind === "tools") {
			if (value !== null && typeof value === "object" && (value as { type?: unknown }).type === "toolCall")
				frame.tools++;
		} else if (Array.isArray(frame.out)) frame.out.push(value);
		else
			Object.defineProperty(frame.out, frame.key!, { value, writable: true, enumerable: true, configurable: true });
	}
}

function isSpace(byte: number): boolean {
	return byte === 0x20 || byte === 0x0a || byte === 0x0d || byte === 0x09;
}
function isDigit(byte: number): boolean {
	return byte >= 0x30 && byte <= 0x39;
}
function isHex(byte: number): boolean {
	return isDigit(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

/** A projected entry, and the tool calls of its replaced content array, which the fold must still count. */
export interface ProjectedEntry {
	readonly entry: SessionEntry;
	readonly toolCalls: number;
}

/**
 * Project one saved entry from its JSON text as it is read: `feed` each chunk in order, then `finish`, which is
 * `undefined` when the text is not one JSON value.
 */
export function entryProjector(): { feed(chunk: Uint8Array): void; finish(): ProjectedEntry | undefined } {
	const scanner = new EntryScanner();
	return {
		feed: (chunk) =>
			scanner.feed(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)),
		finish: () => {
			if (!scanner.finish()) return undefined;
			const entry = scanner.result as SessionEntry;
			const message =
				entry !== null && typeof entry === "object" && entry.type === "message"
					? (entry.message as unknown as Record<string, unknown> | undefined)
					: undefined;
			const content = message !== null && typeof message === "object" ? message.content : undefined;
			const toolCalls =
				message?.role === "assistant" && Array.isArray(content) ? (toolCounts.get(content as unknown[]) ?? 0) : 0;
			return { entry, toolCalls };
		},
	};
}

/** {@link entryProjector} over chunks read in turn. */
export async function jsonlEntryProjection(chunks: AsyncIterable<Uint8Array>): Promise<ProjectedEntry | undefined> {
	const projector = entryProjector();
	for await (const chunk of chunks) projector.feed(chunk);
	return projector.finish();
}

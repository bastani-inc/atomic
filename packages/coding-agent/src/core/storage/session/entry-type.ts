const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const COMMA = 0x2c;
const OPEN_BRACE = 0x7b;
const CLOSE_BRACE = 0x7d;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACKET = 0x5d;
const KEY_LIMIT_BYTES = 32;

type ReaderState =
	| "start"
	| "key-or-end"
	| "key"
	| "colon"
	| "value"
	| "type-value"
	| "string"
	| "nested"
	| "scalar"
	| "after-value"
	| "done";

function isJsonSpace(byte: number): boolean {
	return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function decodeJsonString(raw: readonly number[]): string | undefined {
	try {
		const value: string | number | boolean | null | object = JSON.parse(`"${Buffer.from(raw).toString("utf8")}"`);
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
}

function stringEnd(bytes: Uint8Array, from: number): { readonly end: number; readonly escaped: boolean } {
	for (let at = from; ; ) {
		const quote = bytes.indexOf(QUOTE, at);
		const end = quote === -1 ? bytes.length : quote;
		let run = 0;
		while (end - run - 1 >= from && bytes[end - run - 1] === BACKSLASH) run++;
		if (quote === -1) return { end, escaped: run % 2 === 1 };
		if (run % 2 === 0) return { end: quote, escaped: false };
		at = quote + 1;
	}
}

export class EntryTypeReader {
	private state: ReaderState = "start";
	private escaped = false;
	private raw: number[] = [];
	private rawTooLong = false;
	private keyIsType = false;
	private depth = 0;
	private inNestedString = false;
	private found: string | undefined;
	private seen = false;
	private readonly valueLimit: number;

	constructor(types: readonly string[]) {
		this.valueLimit = 6 * types.reduce((longest, type) => Math.max(longest, type.length), 0) + 6;
	}

	get decided(): boolean {
		return this.state === "done";
	}

	get typeSeen(): boolean {
		return this.seen;
	}

	feed(bytes: Uint8Array): boolean {
		let index = 0;
		while (index < bytes.length && this.state !== "done") {
			if (!this.escaped && this.inString()) {
				const skipped = stringEnd(bytes, index);
				if (skipped.end > index) {
					index = skipped.end;
					this.escaped = skipped.escaped;
					continue;
				}
			}
			this.step(bytes[index]!);
			index++;
		}
		return this.state === "done";
	}

	finish(): string | undefined {
		this.state = "done";
		return this.found;
	}

	private inString(): boolean {
		return (
			this.state === "string" ||
			(this.state === "nested" && this.inNestedString) ||
			(this.rawTooLong && (this.state === "key" || this.state === "type-value"))
		);
	}

	private step(byte: number): void {
		switch (this.state) {
			case "start":
				if (!isJsonSpace(byte)) this.state = byte === OPEN_BRACE ? "key-or-end" : "done";
				return;
			case "key-or-end":
				if (isJsonSpace(byte)) return;
				if (byte === QUOTE) this.beginString("key");
				else this.state = "done";
				return;
			case "key":
			case "type-value":
				this.stringByte(byte);
				return;
			case "colon":
				if (!isJsonSpace(byte)) this.state = byte === COLON ? "value" : "done";
				return;
			case "value":
				this.valueByte(byte);
				return;
			case "string":
				if (this.escaped) this.escaped = false;
				else if (byte === BACKSLASH) this.escaped = true;
				else if (byte === QUOTE) this.state = "after-value";
				return;
			case "nested":
				this.nestedByte(byte);
				return;
			case "scalar":
				if (byte === COMMA) this.state = "key-or-end";
				else if (byte === CLOSE_BRACE) this.state = "done";
				return;
			case "after-value":
				if (isJsonSpace(byte)) return;
				this.state = byte === COMMA ? "key-or-end" : "done";
				return;
			case "done":
				return;
		}
	}

	private valueByte(byte: number): void {
		if (isJsonSpace(byte)) return;
		if (this.keyIsType) {
			this.keyIsType = false;
			if (byte === QUOTE) {
				this.beginString("type-value");
				return;
			}
			this.seen = true;
			this.found = undefined;
		}
		this.escaped = false;
		if (byte === QUOTE) this.state = "string";
		else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
			this.state = "nested";
			this.depth = 1;
			this.inNestedString = false;
		} else this.state = "scalar";
	}

	private nestedByte(byte: number): void {
		if (this.inNestedString) {
			if (this.escaped) this.escaped = false;
			else if (byte === BACKSLASH) this.escaped = true;
			else if (byte === QUOTE) this.inNestedString = false;
			return;
		}
		if (byte === QUOTE) this.inNestedString = true;
		else if (byte === OPEN_BRACE || byte === OPEN_BRACKET) this.depth++;
		else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
			this.depth--;
			if (this.depth === 0) this.state = "after-value";
		}
	}

	private beginString(state: "key" | "type-value"): void {
		this.state = state;
		this.raw = [];
		this.rawTooLong = false;
		this.escaped = false;
	}

	private stringByte(byte: number): void {
		if (!this.escaped && byte === QUOTE) {
			this.endString();
			return;
		}
		this.escaped = !this.escaped && byte === BACKSLASH;
		if (this.raw.length < (this.state === "key" ? KEY_LIMIT_BYTES : this.valueLimit)) this.raw.push(byte);
		else this.rawTooLong = true;
	}

	private endString(): void {
		const text = this.rawTooLong ? undefined : decodeJsonString(this.raw);
		this.raw = [];
		this.rawTooLong = false;
		if (this.state === "key") {
			this.keyIsType = text === "type";
			this.state = "colon";
			return;
		}
		this.found = text;
		this.seen = true;
		this.state = "after-value";
	}
}

const Expect = {
	Value: 0,
	FirstArrayValue: 1,
	FirstObjectKey: 2,
	ObjectKey: 3,
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
type Expect = (typeof Expect)[keyof typeof Expect];

const LITERALS: Readonly<Record<number, Uint8Array>> = {
	116: Buffer.from("rue"),
	102: Buffer.from("alse"),
	110: Buffer.from("ull"),
};

const SIMPLE_ESCAPES = new Set([QUOTE, BACKSLASH, 0x2f, 0x62, 0x66, 0x6e, 0x72, 0x74]);

function isDigit(byte: number): boolean {
	return byte >= 0x30 && byte <= 0x39;
}

function isHexDigit(byte: number): boolean {
	return isDigit(byte) || (byte >= 0x41 && byte <= 0x46) || (byte >= 0x61 && byte <= 0x66);
}

export class JsonTextChecker {
	private expect: Expect = Expect.Value;
	private stringIsKey = false;
	private pending = 0;
	private literal: Uint8Array = LITERALS[0x74]!;
	private literalAt = 0;
	private objectDepthBits = new Uint8Array(64);
	private depth = 0;

	feed(bytes: Uint8Array): void {
		for (let index = 0; index < bytes.length && this.expect !== Expect.Invalid; index++) {
			if (this.expect === Expect.String) {
				while (index < bytes.length) {
					const byte = bytes[index]!;
					if (byte === QUOTE || byte === BACKSLASH || byte < 0x20) break;
					index++;
				}
				if (index === bytes.length) return;
			}
			this.step(bytes[index]!);
		}
	}

	finish(): boolean {
		if (this.depth !== 0) return false;
		return (
			this.expect === Expect.After ||
			this.expect === Expect.Zero ||
			this.expect === Expect.Integer ||
			this.expect === Expect.Fraction ||
			this.expect === Expect.Exponent
		);
	}

	private step(byte: number): void {
		switch (this.expect) {
			case Expect.Value:
				if (!isJsonSpace(byte)) this.startValue(byte);
				return;
			case Expect.FirstArrayValue:
				if (isJsonSpace(byte)) return;
				if (byte === CLOSE_BRACKET) this.close(false);
				else this.startValue(byte);
				return;
			case Expect.FirstObjectKey:
			case Expect.ObjectKey:
				if (isJsonSpace(byte)) return;
				if (byte === QUOTE) this.startString(true);
				else if (byte === CLOSE_BRACE && this.expect === Expect.FirstObjectKey) this.close(true);
				else this.expect = Expect.Invalid;
				return;
			case Expect.Colon:
				if (!isJsonSpace(byte)) this.expect = byte === COLON ? Expect.Value : Expect.Invalid;
				return;
			case Expect.After:
				this.after(byte);
				return;
			case Expect.String:
				if (byte === QUOTE) {
					if (this.stringIsKey) this.expect = Expect.Colon;
					else this.endValue();
				} else if (byte === BACKSLASH) this.expect = Expect.Escape;
				else if (byte < 0x20) this.expect = Expect.Invalid;
				return;
			case Expect.Escape:
				if (byte === 0x75) {
					this.expect = Expect.Hex;
					this.pending = 4;
				} else this.expect = SIMPLE_ESCAPES.has(byte) ? Expect.String : Expect.Invalid;
				return;
			case Expect.Hex:
				if (!isHexDigit(byte)) this.expect = Expect.Invalid;
				else if (--this.pending === 0) this.expect = Expect.String;
				return;
			case Expect.Minus:
				if (byte === 0x30) this.expect = Expect.Zero;
				else this.expect = isDigit(byte) ? Expect.Integer : Expect.Invalid;
				return;
			case Expect.Zero:
				if (isDigit(byte)) this.expect = Expect.Invalid;
				else this.afterInteger(byte);
				return;
			case Expect.Integer:
				if (!isDigit(byte)) this.afterInteger(byte);
				return;
			case Expect.Dot:
				this.expect = isDigit(byte) ? Expect.Fraction : Expect.Invalid;
				return;
			case Expect.Fraction:
				if (isDigit(byte)) return;
				if (byte === 0x65 || byte === 0x45) this.expect = Expect.ExponentMark;
				else this.endNumber(byte);
				return;
			case Expect.ExponentMark:
				if (byte === 0x2b || byte === 0x2d) this.expect = Expect.ExponentSign;
				else this.expect = isDigit(byte) ? Expect.Exponent : Expect.Invalid;
				return;
			case Expect.ExponentSign:
				this.expect = isDigit(byte) ? Expect.Exponent : Expect.Invalid;
				return;
			case Expect.Exponent:
				if (!isDigit(byte)) this.endNumber(byte);
				return;
			case Expect.Literal:
				if (byte !== this.literal[this.literalAt]) this.expect = Expect.Invalid;
				else if (++this.literalAt === this.literal.length) this.endValue();
				return;
			case Expect.Invalid:
				return;
		}
	}

	private startValue(byte: number): void {
		if (byte === OPEN_BRACE) this.open(true);
		else if (byte === OPEN_BRACKET) this.open(false);
		else if (byte === QUOTE) this.startString(false);
		else if (byte === 0x2d) this.expect = Expect.Minus;
		else if (byte === 0x30) this.expect = Expect.Zero;
		else if (isDigit(byte)) this.expect = Expect.Integer;
		else if (LITERALS[byte] !== undefined) {
			this.literal = LITERALS[byte]!;
			this.literalAt = 0;
			this.expect = Expect.Literal;
		} else this.expect = Expect.Invalid;
	}

	private startString(isKey: boolean): void {
		this.stringIsKey = isKey;
		this.expect = Expect.String;
	}

	private afterInteger(byte: number): void {
		if (byte === 0x2e) this.expect = Expect.Dot;
		else if (byte === 0x65 || byte === 0x45) this.expect = Expect.ExponentMark;
		else this.endNumber(byte);
	}

	private endNumber(byte: number): void {
		this.endValue();
		this.after(byte);
	}

	private endValue(): void {
		this.expect = Expect.After;
	}

	private after(byte: number): void {
		if (isJsonSpace(byte)) return;
		if (this.depth === 0) {
			this.expect = Expect.Invalid;
			return;
		}
		const inObject = this.topIsObject();
		if (byte === COMMA) this.expect = inObject ? Expect.ObjectKey : Expect.Value;
		else if (byte === (inObject ? CLOSE_BRACE : CLOSE_BRACKET)) this.close(inObject);
		else this.expect = Expect.Invalid;
	}

	private open(isObject: boolean): void {
		const slot = this.depth >> 3;
		if (slot >= this.objectDepthBits.length) {
			const grown = new Uint8Array(this.objectDepthBits.length * 2);
			grown.set(this.objectDepthBits);
			this.objectDepthBits = grown;
		}
		const bit = 1 << (this.depth & 7);
		this.objectDepthBits[slot] = isObject ? this.objectDepthBits[slot]! | bit : this.objectDepthBits[slot]! & ~bit;
		this.depth++;
		this.expect = isObject ? Expect.FirstObjectKey : Expect.FirstArrayValue;
	}

	private close(isObject: boolean): void {
		if (this.depth === 0 || this.topIsObject() !== isObject) {
			this.expect = Expect.Invalid;
			return;
		}
		this.depth--;
		this.endValue();
	}

	private topIsObject(): boolean {
		const at = this.depth - 1;
		return (this.objectDepthBits[at >> 3]! & (1 << (at & 7))) !== 0;
	}
}

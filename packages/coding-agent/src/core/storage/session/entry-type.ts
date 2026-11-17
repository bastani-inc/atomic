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

export class EntryTypeReader {
	private state: ReaderState = "start";
	private escaped = false;
	private raw: number[] = [];
	private rawTooLong = false;
	private keyIsType = false;
	private depth = 0;
	private inNestedString = false;
	private found: string | undefined;
	private readonly valueLimit: number;

	constructor(types: readonly string[]) {
		this.valueLimit = 6 * types.reduce((longest, type) => Math.max(longest, type.length), 0) + 6;
	}

	get decided(): boolean {
		return this.state === "done";
	}

	feed(bytes: Uint8Array): boolean {
		for (let index = 0; index < bytes.length && this.state !== "done"; index++) this.step(bytes[index]!);
		return this.state === "done";
	}

	finish(): string | undefined {
		this.state = "done";
		return this.found;
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
				if (!isJsonSpace(byte)) this.state = byte === COMMA ? "key-or-end" : "done";
				return;
			case "done":
				return;
		}
	}

	private valueByte(byte: number): void {
		if (isJsonSpace(byte)) return;
		if (this.keyIsType) {
			if (byte === QUOTE) this.beginString("type-value");
			else this.state = "done";
			return;
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
		if (this.state === "key") {
			this.keyIsType = text === "type";
			this.state = "colon";
			return;
		}
		this.found = text;
		this.state = "done";
	}
}

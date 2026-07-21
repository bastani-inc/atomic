import type { CursorConnectFrame } from "./transport-types.js";
import { CursorTransportError } from "./transport-errors.js";

const CONNECT_END_STREAM_FLAG = 0b10;
export function encodeCursorConnectFrame(data: Uint8Array, flags = 0): Uint8Array {
	const frame = new Uint8Array(5 + data.length);
	frame[0] = flags;
	const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
	view.setUint32(1, data.length, false);
	frame.set(data, 5);
	return frame;
}

export function decodeCursorConnectFrames(data: Uint8Array): readonly CursorConnectFrame[] {
	const decoder = new CursorConnectFrameDecoder();
	const frames = decoder.push(data);
	decoder.finish();
	return frames;
}

export class CursorConnectFrameDecoder {
	#buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

	push(data: Uint8Array): readonly CursorConnectFrame[] {
		this.#buffer = concatBytes(this.#buffer, data);
		const frames: CursorConnectFrame[] = [];
		let offset = 0;
		while (this.#buffer.length - offset >= 5) {
			const flags = this.#buffer[offset] ?? 0;
			const view = new DataView(this.#buffer.buffer, this.#buffer.byteOffset + offset, this.#buffer.byteLength - offset);
			const length = view.getUint32(1, false);
			const bodyStart = offset + 5;
			const bodyEnd = bodyStart + length;
			if (bodyEnd > this.#buffer.length) break;
			frames.push({ flags, data: this.#buffer.slice(bodyStart, bodyEnd), endStream: (flags & CONNECT_END_STREAM_FLAG) !== 0 });
			offset = bodyEnd;
		}
		this.#buffer = this.#buffer.slice(offset);
		return frames;
	}

	finish(): void {
		if (this.#buffer.length === 0) return;
		if (this.#buffer.length < 5) throw new CursorTransportError("ProtocolMalformed", "Incomplete Cursor Connect frame header.");
		throw new CursorTransportError("ProtocolMalformed", "Incomplete Cursor Connect frame body.");
	}
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

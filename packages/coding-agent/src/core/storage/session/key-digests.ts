import { hash } from "fast-sha256";

const DIGEST_BYTES = 16;
const PENDING_DIGESTS = 64;

/** A synchronous branch-scoped membership check without retaining the message identifiers themselves. The
 * packed sorted index costs 16 bytes per distinct key. A small batch of digests amortizes live insertions. */
export class SessionKeyDigests {
	private data: Buffer | undefined;
	private encoded: string | undefined;
	private readonly pending = new Set<string>();
	constructor(encoded = "") {
		this.encoded = encoded;
	}
	private packed(): Buffer {
		if (!this.data) {
			this.data = Buffer.from(this.encoded ?? "", "base64");
			this.encoded = undefined;
		}
		return this.data;
	}
	private digest(key: string): Buffer {
		// JS key equality compares code units. UTF-8 would silently merge an unpaired surrogate with U+FFFD.
		return Buffer.from(hash(Buffer.from(key, "utf16le")).subarray(0, DIGEST_BYTES));
	}
	private contains(digest: Buffer): boolean {
		const data = this.packed();
		let lo = 0,
			hi = data.length / DIGEST_BYTES;
		while (lo < hi) {
			const mid = Math.floor((lo + hi) / 2);
			const cmp = data.compare(digest, 0, DIGEST_BYTES, mid * DIGEST_BYTES, (mid + 1) * DIGEST_BYTES);
			if (cmp === 0) return true;
			if (cmp < 0) lo = mid + 1;
			else hi = mid;
		}
		return this.pending.has(digest.toString("hex"));
	}
	has(key: string): boolean {
		return this.contains(this.digest(key));
	}
	add(key: string): void {
		const d = this.digest(key);
		if (!this.contains(d)) {
			this.pending.add(d.toString("hex"));
			if (this.pending.size >= PENDING_DIGESTS) this.flush();
		}
	}
	mergeEncoded(encoded: string): void {
		if (!encoded || encoded === this.encoded) return;
		if (!this.pending.size && (this.encoded === "" || this.data?.length === 0)) {
			this.encoded = encoded;
			this.data = undefined;
			return;
		}
		const b = Buffer.from(encoded, "base64");
		for (let i = 0; i < b.length; i += DIGEST_BYTES) {
			const d = b.subarray(i, i + DIGEST_BYTES);
			if (!this.contains(d)) this.pending.add(d.toString("hex"));
		}
		this.flush();
	}
	clear(): void {
		this.data = undefined;
		this.encoded = "";
		this.pending.clear();
	}
	private flush(): void {
		if (!this.pending.size) return;
		const base = this.packed();
		const add = [...this.pending].sort().map((h) => Buffer.from(h, "hex"));
		const joined = Buffer.allocUnsafe(base.length + add.length * DIGEST_BYTES);
		let before = 0,
			next = 0,
			out = 0;
		while (before < base.length || next < add.length) {
			if (
				before < base.length &&
				(next === add.length || base.compare(add[next]!, 0, DIGEST_BYTES, before, before + DIGEST_BYTES) < 0)
			) {
				base.copy(joined, out, before, before + DIGEST_BYTES);
				before += DIGEST_BYTES;
			} else {
				add[next++]!.copy(joined, out);
			}
			out += DIGEST_BYTES;
		}
		this.data = joined;
		this.pending.clear();
	}
	serialize(): string {
		if (this.encoded !== undefined) return this.encoded;
		this.flush();
		return this.packed().toString("base64");
	}
}

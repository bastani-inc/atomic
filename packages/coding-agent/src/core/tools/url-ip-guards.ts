import { isIP } from "node:net";

function parseIpv4Part(part: string): bigint | undefined {
	if (part === "") return undefined;
	if (/^0x[0-9a-f]+$/i.test(part)) return BigInt(Number.parseInt(part.slice(2), 16));
	if (/^0[0-7]+$/.test(part)) return BigInt(Number.parseInt(part, 8));
	if (/^(?:0|[1-9]\d*)$/.test(part)) return BigInt(part);
	return undefined;
}

function dottedQuadFromValue(value: bigint): string | undefined {
	if (value < 0n || value > 0xffffffffn) return undefined;
	return [24n, 16n, 8n, 0n].map((shift) => Number((value >> shift) & 255n)).join(".");
}

function canonicalNumericIpv4(hostname: string): string | undefined {
	if (!/^[0-9a-fx.]+$/i.test(hostname)) return undefined;
	const parts = hostname.split(".");
	if (parts.length < 1 || parts.length > 4) return undefined;
	const nums = parts.map(parseIpv4Part);
	if (nums.some((part) => part === undefined)) return undefined;
	const values = nums as bigint[];
	if (values.length === 1) return dottedQuadFromValue(values[0]!);
	if (values[0]! > 255n) return undefined;
	if (values.length === 2) {
		if (values[1]! > 0xffffffn) return undefined;
		return dottedQuadFromValue((values[0]! << 24n) + values[1]!);
	}
	if (values[1]! > 255n) return undefined;
	if (values.length === 3) {
		if (values[2]! > 0xffffn) return undefined;
		return dottedQuadFromValue((values[0]! << 24n) + (values[1]! << 16n) + values[2]!);
	}
	if (values[2]! > 255n || values[3]! > 255n) return undefined;
	return dottedQuadFromValue((values[0]! << 24n) + (values[1]! << 16n) + (values[2]! << 8n) + values[3]!);
}

export function normalizeIpLiteralHost(hostname: string): string | undefined {
	return isIP(hostname) ? hostname : canonicalNumericIpv4(hostname);
}

export function ipFamily(address: string): 4 | 6 {
	return address.includes(":") ? 6 : 4;
}
function ipv4FromHextets(high: number, low: number): string { return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`; }

function expandIpv6(address: string): number[] | undefined {
	const value = address.toLowerCase().replace(/%.+$/, "");
	const pieces = value.split("::"); if (pieces.length > 2) return undefined;
	const parseSide = (side: string): number[] | undefined => side ? side.split(":").flatMap((part) => {
		if (part.includes(".")) { const nums = part.split(".").map((v) => Number.parseInt(v, 10)); if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return [Number.NaN]; return [(nums[0]! << 8) | nums[1]!, (nums[2]! << 8) | nums[3]!]; }
		if (!/^[0-9a-f]{1,4}$/.test(part)) return [Number.NaN]; return [Number.parseInt(part, 16)];
	}) : [];
	const left = parseSide(pieces[0] ?? ""), right = parseSide(pieces[1] ?? ""); if (!left || !right || left.some(Number.isNaN) || right.some(Number.isNaN)) return undefined;
	const zeros = pieces.length === 2 ? 8 - left.length - right.length : 0; if (zeros < 0 || pieces.length === 1 && left.length !== 8) return undefined;
	return [...left, ...Array.from({ length: zeros }, () => 0), ...right];
}

function embeddedPrivateIpv4(address: string): boolean {
	const hextets = expandIpv6(address); if (!hextets) return false;
	// IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96) addresses: any
	// fully-expanded form (e.g. [0:0:0:0:0:ffff:169.254.169.254]) must be
	// re-checked against the IPv4 private predicates, not just the compressed
	// `::ffff:` literals handled by isPrivateIpAddress.
	if (hextets.slice(0, 5).every((part) => part === 0) && hextets[5] === 0xffff) return isPrivateIpAddress(ipv4FromHextets(hextets[6]!, hextets[7]!));
	if (hextets.slice(0, 6).every((part) => part === 0)) return isPrivateIpAddress(ipv4FromHextets(hextets[6]!, hextets[7]!));
	if (hextets[0] === 0x2002) return isPrivateIpAddress(ipv4FromHextets(hextets[1]!, hextets[2]!));
	if (hextets[0] === 0x64 && hextets[1] === 0xff9b && hextets.slice(2, 6).every((part) => part === 0)) return isPrivateIpAddress(ipv4FromHextets(hextets[6]!, hextets[7]!));
	return false;
}

function isPrivateIpv6Address(address: string): boolean {
	const hextets = expandIpv6(address);
	if (!hextets) return false;
	const h0 = hextets[0]!;
	return hextets.every((part) => part === 0)
		|| hextets.slice(0, 7).every((part) => part === 0) && hextets[7] === 1
		|| (h0 & 0xffc0) === 0xfe80
		|| (h0 & 0xfe00) === 0xfc00;
}

export function isPrivateIpAddress(address: string): boolean {
	if (address.includes(":")) {
		const lower = address.toLowerCase();
		if (isPrivateIpv6Address(lower)) return true;
		const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
		const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (hexMapped) {
			const high = Number.parseInt(hexMapped[1]!, 16), low = Number.parseInt(hexMapped[2]!, 16);
			return isPrivateIpAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
		}
		return mapped ? isPrivateIpAddress(mapped) : embeddedPrivateIpv4(address);
	}
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
	const [a, b] = parts as [number, number, number, number];
	return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
}

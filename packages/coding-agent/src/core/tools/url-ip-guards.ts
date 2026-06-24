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

export function isPrivateIpAddress(address: string): boolean {
	if (address.includes(":")) {
		const lower = address.toLowerCase();
		if (lower === "::" || lower === "::1" || lower === "0:0:0:0:0:0:0:1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) return true;
		const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
		const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
		if (hexMapped) {
			const high = Number.parseInt(hexMapped[1]!, 16), low = Number.parseInt(hexMapped[2]!, 16);
			return isPrivateIpAddress(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`);
		}
		return mapped ? isPrivateIpAddress(mapped) : false;
	}
	const parts = address.split(".").map((part) => Number.parseInt(part, 10));
	if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) return false;
	const [a, b] = parts as [number, number, number, number];
	return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168;
}

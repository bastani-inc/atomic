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
function ipv4FromHextets(high: number, low: number): string {
	return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function expandIpv6(address: string): number[] | undefined {
	const value = address.toLowerCase().replace(/%.+$/, "");
	const pieces = value.split("::");
	if (pieces.length > 2) return undefined;
	const parseSide = (side: string): number[] | undefined =>
		side
			? side.split(":").flatMap((part) => {
					if (part.includes(".")) {
						const nums = part.split(".").map((v) => Number.parseInt(v, 10));
						if (nums.length !== 4 || nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255))
							return [Number.NaN];
						return [(nums[0]! << 8) | nums[1]!, (nums[2]! << 8) | nums[3]!];
					}
					if (!/^[0-9a-f]{1,4}$/.test(part)) return [Number.NaN];
					return [Number.parseInt(part, 16)];
				})
			: [];
	const left = parseSide(pieces[0] ?? ""),
		right = parseSide(pieces[1] ?? "");
	if (!left || !right || left.some(Number.isNaN) || right.some(Number.isNaN)) return undefined;
	const zeros = pieces.length === 2 ? 8 - left.length - right.length : 0;
	if (zeros < 0 || (pieces.length === 1 && left.length !== 8)) return undefined;
	return [...left, ...Array.from({ length: zeros }, () => 0), ...right];
}

// Every range here is either not globally reachable (IANA IPv4 and IPv6 Special-Purpose Address Registries),
// multicast, or reserved. A fetch to any of them is refused, whatever the host's own network looks like.
const NON_PUBLIC_IPV4: readonly (readonly [string, number])[] = [
	["0.0.0.0", 8], // "this network"
	["10.0.0.0", 8], // private
	["100.64.0.0", 10], // shared address space (CGNAT)
	["127.0.0.0", 8], // loopback
	["169.254.0.0", 16], // link-local, including cloud metadata
	["172.16.0.0", 12], // private
	["192.0.0.0", 24], // IETF protocol assignments, including a cloud metadata address
	["192.0.2.0", 24], // documentation (TEST-NET-1)
	["192.168.0.0", 16], // private
	["198.18.0.0", 15], // benchmarking
	["198.51.100.0", 24], // documentation (TEST-NET-2)
	["203.0.113.0", 24], // documentation (TEST-NET-3)
	["224.0.0.0", 4], // multicast
	["240.0.0.0", 4], // reserved, including the limited broadcast address
];

const NON_PUBLIC_IPV6: readonly (readonly [string, number])[] = [
	["::", 128], // unspecified
	["::1", 128], // loopback
	["64:ff9b:1::", 48], // local-use IPv4/IPv6 translation
	["100::", 64], // discard-only
	["2001::", 23], // IETF protocol assignments
	["2001:db8::", 32], // documentation
	["3fff::", 20], // documentation
	["5f00::", 16], // segment routing (SRv6) SIDs
	["fc00::", 7], // unique local
	["fe80::", 10], // link-local
	["fec0::", 10], // site-local (deprecated)
	["ff00::", 8], // multicast
];

function ipv4Value(address: string): number | undefined {
	const parts = address.split(".");
	if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part))) return undefined;
	const octets = parts.map(Number);
	if (octets.some((octet) => octet > 255)) return undefined;
	return ((octets[0]! << 24) | (octets[1]! << 16) | (octets[2]! << 8) | octets[3]!) >>> 0;
}

function inIpv4Prefix(value: number, base: string, bits: number): boolean {
	const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
	return (value & mask) >>> 0 === (ipv4Value(base)! & mask) >>> 0;
}

function inIpv6Prefix(hextets: readonly number[], base: readonly number[], bits: number): boolean {
	for (let index = 0; index < 8 && bits > 0; index++, bits -= 16) {
		const mask = bits >= 16 ? 0xffff : (0xffff << (16 - bits)) & 0xffff;
		if ((hextets[index]! & mask) !== (base[index]! & mask)) return false;
	}
	return true;
}

const NON_PUBLIC_IPV6_PREFIXES = NON_PUBLIC_IPV6.map(([base, bits]) => [expandIpv6(base)!, bits] as const);

/** The IPv4 address a translation or transition IPv6 address carries, when it carries one. */
function embeddedIpv4(hextets: readonly number[]): string | undefined {
	const zeros = (from: number, to: number) => hextets.slice(from, to).every((part) => part === 0);
	const tail = () => ipv4FromHextets(hextets[6]!, hextets[7]!);
	if (zeros(0, 5) && hextets[5] === 0xffff) return tail(); // IPv4-mapped ::ffff:0:0/96
	if (zeros(0, 4) && hextets[4] === 0xffff && hextets[5] === 0) return tail(); // IPv4-translated ::ffff:0:0:0/96
	if (zeros(0, 6)) return tail(); // IPv4-compatible ::/96
	if (hextets[0] === 0x64 && hextets[1] === 0xff9b && zeros(2, 6)) return tail(); // NAT64 64:ff9b::/96
	if (hextets[0] === 0x2002) return ipv4FromHextets(hextets[1]!, hextets[2]!); // 6to4 2002::/16
	return undefined;
}

/**
 * Whether a fetch to this IP address must be refused: anything that isn't a globally reachable unicast address,
 * including IPv6 addresses that carry such an IPv4 address.
 */
export function isPrivateIpAddress(address: string): boolean {
	if (address.includes(":")) {
		const hextets = expandIpv6(address);
		if (!hextets) return false;
		if (NON_PUBLIC_IPV6_PREFIXES.some(([base, bits]) => inIpv6Prefix(hextets, base, bits))) return true;
		const embedded = embeddedIpv4(hextets);
		return embedded !== undefined && isPrivateIpAddress(embedded);
	}
	const value = ipv4Value(address);
	return value !== undefined && NON_PUBLIC_IPV4.some(([base, bits]) => inIpv4Prefix(value, base, bits));
}

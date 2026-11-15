import { describe, expect, it } from "vitest";
import { ipFamily, isPrivateIpAddress, normalizeIpLiteralHost } from "../src/core/tools/url-ip-guards.ts";

/**
 * Table-driven coverage for the SSRF private-IP guards. These predicates gate
 * the fetch literal-host path (attacker-controlled via crafted URLs), so each
 * known bypass form — fully-expanded IPv4-mapped IPv6, CGNAT, alternate IPv4
 * encodings — is pinned directly rather than only transitively through the
 * fetch pipeline.
 */

describe("isPrivateIpAddress — IPv4", () => {
	const cases: Array<{ address: string; expected: boolean; note?: string }> = [
		{ address: "127.0.0.1", expected: true, note: "loopback" },
		{ address: "10.0.0.1", expected: true, note: "RFC1918 10/8" },
		{ address: "192.168.1.1", expected: true, note: "RFC1918 192.168/16" },
		{ address: "172.16.0.1", expected: true, note: "RFC1918 172.16 lower bound" },
		{ address: "172.31.255.254", expected: true, note: "RFC1918 172.31 upper bound" },
		{ address: "172.32.0.1", expected: false, note: "just above 172/16-31" },
		{ address: "172.15.0.1", expected: false, note: "just below 172/16-31" },
		{ address: "169.254.169.254", expected: true, note: "cloud metadata link-local" },
		{ address: "0.0.0.0", expected: true, note: "this-network" },
		{ address: "100.64.0.1", expected: true, note: "CGNAT 100.64/10 lower bound" },
		{ address: "100.127.255.254", expected: true, note: "CGNAT 100.64/10 upper bound" },
		{ address: "100.63.0.1", expected: false, note: "just below CGNAT" },
		{ address: "100.128.0.1", expected: false, note: "just above CGNAT" },
		{ address: "8.8.8.8", expected: false, note: "public" },
		{ address: "1.1.1.1", expected: false, note: "public" },
		{ address: "999.1.1.1", expected: false, note: "invalid octet" },
		{ address: "10", expected: false, note: "not dotted-quad" },
		{ address: "", expected: false, note: "empty" },
	];
	for (const { address, expected, note } of cases) {
		it(`${note ? `${note}: ` : ""}isPrivateIpAddress(${JSON.stringify(address)}) === ${expected}`, () => {
			expect(isPrivateIpAddress(address)).toBe(expected);
		});
	}
});

describe("isPrivateIpAddress — IPv4-mapped IPv6 (SSRF bypass forms)", () => {
	// The compressed ::ffff: forms were always covered; the fully-expanded
	// form `[0:0:0:0:0:ffff:169.254.169.254]` previously evaded the check.
	const cases: Array<{ address: string; expected: boolean; note?: string }> = [
		{ address: "::ffff:169.254.169.254", expected: true, note: "compressed mapped → metadata" },
		{ address: "::ffff:127.0.0.1", expected: true, note: "compressed mapped → loopback" },
		{ address: "0:0:0:0:0:ffff:169.254.169.254", expected: true, note: "fully-expanded mapped → metadata" },
		{ address: "0:0:0:0:0:ffff:127.0.0.1", expected: true, note: "fully-expanded mapped → loopback" },
		{ address: "0:0:0:0:0:ffff:100.64.0.1", expected: true, note: "fully-expanded mapped → CGNAT" },
		{ address: "0:0:0:0:0:ffff:8.8.8.8", expected: false, note: "fully-expanded mapped → public" },
		{ address: "::ffff:0:0", expected: true, note: "mapped to 0.0.0.0 (this-network, a===0)" },
	];
	for (const { address, expected, note } of cases) {
		it(`${note ? `${note}: ` : ""}isPrivateIpAddress(${JSON.stringify(address)}) === ${expected}`, () => {
			expect(isPrivateIpAddress(address)).toBe(expected);
		});
	}
});

describe("isPrivateIpAddress — IPv6", () => {
	const cases: Array<{ address: string; expected: boolean; note?: string }> = [
		{ address: "::1", expected: true, note: "loopback" },
		{ address: "::", expected: true, note: "unspecified" },
		{ address: "0:0:0:0:0:0:0:1", expected: true, note: "expanded loopback" },
		{ address: "fe80::1", expected: true, note: "link-local" },
		{ address: "fe9f::1", expected: true, note: "link-local fe80::/10 middle" },
		{ address: "febf::1", expected: true, note: "link-local fe80::/10 upper bound" },
		{ address: "fec0::1", expected: true, note: "site-local fec0::/10, outside link-local" },
		{ address: "fd00::1", expected: true, note: "ULA fd::/8" },
		{ address: "fc00::1", expected: true, note: "ULA fc::/8" },
		{ address: "2001:4860:4860::8888", expected: false, note: "public" },
		// 6to4 (2002::/16) and NAT64 (64:ff9b::/96) embed an IPv4 tail.
		{ address: "2002:7f00:1::", expected: true, note: "6to4 embedding 127.0.0.1" },
		{ address: "64:ff9b::169.254.169.254", expected: true, note: "NAT64 embedding metadata" },
		{ address: "::7f00:1", expected: true, note: "IPv4-compatible embedding 127.0.0.1" },
		{ address: "::808:808", expected: false, note: "IPv4-compatible embedding public" },
		{ address: "64:ff9b::8.8.8.8", expected: false, note: "NAT64 embedding public" },
	];
	for (const { address, expected, note } of cases) {
		it(`${note ? `${note}: ` : ""}isPrivateIpAddress(${JSON.stringify(address)}) === ${expected}`, () => {
			expect(isPrivateIpAddress(address)).toBe(expected);
		});
	}
});

describe("isPrivateIpAddress — reserved and non-public ranges", () => {
	// Each range: its first and last address are refused, and the addresses just outside it are allowed.
	const ranges: Array<{ name: string; first: string; last: string; outside: string[] }> = [
		{
			name: "IETF protocol assignments 192.0.0.0/24",
			first: "192.0.0.0",
			last: "192.0.0.255",
			outside: ["191.255.255.255", "192.0.1.0"],
		},
		{
			name: "TEST-NET-1 192.0.2.0/24",
			first: "192.0.2.0",
			last: "192.0.2.255",
			outside: ["192.0.1.255", "192.0.3.0"],
		},
		{
			name: "benchmarking 198.18.0.0/15",
			first: "198.18.0.0",
			last: "198.19.255.255",
			outside: ["198.17.255.255", "198.20.0.0"],
		},
		{
			name: "TEST-NET-2 198.51.100.0/24",
			first: "198.51.100.0",
			last: "198.51.100.255",
			outside: ["198.51.99.255", "198.51.101.0"],
		},
		{
			name: "TEST-NET-3 203.0.113.0/24",
			first: "203.0.113.0",
			last: "203.0.113.255",
			outside: ["203.0.112.255", "203.0.114.0"],
		},
		{ name: "multicast 224.0.0.0/4", first: "224.0.0.0", last: "239.255.255.255", outside: ["223.255.255.255"] },
		{ name: "reserved 240.0.0.0/4 and broadcast", first: "240.0.0.0", last: "255.255.255.255", outside: [] },
		{ name: "this network 0.0.0.0/8", first: "0.0.0.0", last: "0.255.255.255", outside: ["1.0.0.0"] },
		{
			name: "loopback 127.0.0.0/8",
			first: "127.0.0.0",
			last: "127.255.255.255",
			outside: ["126.255.255.255", "128.0.0.0"],
		},
		{ name: "private 10.0.0.0/8", first: "10.0.0.0", last: "10.255.255.255", outside: ["9.255.255.255", "11.0.0.0"] },
		{
			name: "private 172.16.0.0/12",
			first: "172.16.0.0",
			last: "172.31.255.255",
			outside: ["172.15.255.255", "172.32.0.0"],
		},
		{
			name: "private 192.168.0.0/16",
			first: "192.168.0.0",
			last: "192.168.255.255",
			outside: ["192.167.255.255", "192.169.0.0"],
		},
		{
			name: "link-local 169.254.0.0/16",
			first: "169.254.0.0",
			last: "169.254.255.255",
			outside: ["169.253.255.255", "169.255.0.0"],
		},
		{
			name: "shared address space 100.64.0.0/10",
			first: "100.64.0.0",
			last: "100.127.255.255",
			outside: ["100.63.255.255", "100.128.0.0"],
		},
		{
			name: "local-use translation 64:ff9b:1::/48",
			first: "64:ff9b:1::",
			last: "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
			outside: ["64:ff9b:0:ffff:ffff:ffff:ffff:ffff", "64:ff9b:2::"],
		},
		{
			name: "discard-only 100::/64",
			first: "100::",
			last: "100::ffff:ffff:ffff:ffff",
			outside: ["ff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "100:0:0:1::"],
		},
		{
			name: "IETF protocol assignments 2001::/23",
			first: "2001::",
			last: "2001:1ff:ffff:ffff:ffff:ffff:ffff:ffff",
			outside: ["2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2001:200::"],
		},
		{
			name: "documentation 2001:db8::/32",
			first: "2001:db8::",
			last: "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff",
			outside: ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db9::"],
		},
		{
			name: "documentation 3fff::/20",
			first: "3fff::",
			last: "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
			outside: ["3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "3fff:1000::"],
		},
		{
			name: "segment routing 5f00::/16",
			first: "5f00::",
			last: "5f00:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
			outside: ["5eff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "5f01::"],
		},
		{
			name: "unique local fc00::/7",
			first: "fc00::",
			last: "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
			outside: ["fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe00::"],
		},
		{
			name: "link-local fe80::/10",
			first: "fe80::",
			last: "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
			outside: ["fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
		},
		{ name: "site-local fec0::/10", first: "fec0::", last: "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", outside: [] },
		{ name: "multicast ff00::/8", first: "ff00::", last: "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", outside: [] },
	];
	for (const { name, first, last, outside } of ranges) {
		it(`refuses ${name} at both edges and allows the addresses just outside`, () => {
			expect(isPrivateIpAddress(first), first).toBe(true);
			expect(isPrivateIpAddress(last), last).toBe(true);
			for (const address of outside) expect(isPrivateIpAddress(address), address).toBe(false);
		});
	}

	const embedded: Array<{ address: string; expected: boolean; note: string }> = [
		{ address: "::ffff:0:a00:1", expected: true, note: "IPv4-translated ::ffff:0:0:0/96 carrying 10.0.0.1" },
		{ address: "0:0:0:0:ffff:0:c000:c0", expected: true, note: "IPv4-translated, expanded, carrying 192.0.0.192" },
		{ address: "::ffff:0:808:808", expected: false, note: "IPv4-translated carrying a public address" },
		{ address: "::ffff:192.0.0.192", expected: true, note: "IPv4-mapped metadata address in 192.0.0.0/24" },
		{ address: "::ffff:198.18.0.1", expected: true, note: "IPv4-mapped benchmarking address" },
		{ address: "64:ff9b::224.0.0.1", expected: true, note: "NAT64 carrying multicast" },
		{ address: "64:ff9b::255.255.255.255", expected: true, note: "NAT64 carrying broadcast" },
		{ address: "2002:c000:c0::", expected: true, note: "6to4 carrying 192.0.0.192" },
		{ address: "2001:4860:4860::8888", expected: false, note: "public IPv6" },
		{ address: "2606:4700:4700::1111", expected: false, note: "public IPv6" },
	];
	for (const { address, expected, note } of embedded) {
		it(`${note}: isPrivateIpAddress(${JSON.stringify(address)}) === ${expected}`, () => {
			expect(isPrivateIpAddress(address)).toBe(expected);
		});
	}
});

describe("normalizeIpLiteralHost — canonicalization of alternate IPv4 encodings", () => {
	// Octal/hex/decimal and single/dual/triple-part IPv4 must canonicalize and
	// therefore be caught downstream by isPrivateIpAddress.
	const cases: Array<{ input: string; expectedCanonical: string; note?: string }> = [
		{ input: "127.0.0.1", expectedCanonical: "127.0.0.1", note: "dotted-quad passthrough" },
		{ input: "2130706433", expectedCanonical: "127.0.0.1", note: "decimal single-part → loopback" },
		{ input: "0x7f000001", expectedCanonical: "127.0.0.1", note: "hex single-part → loopback" },
		{ input: "017700000001", expectedCanonical: "127.0.0.1", note: "octal single-part → loopback" },
		{ input: "127.1", expectedCanonical: "127.0.0.1", note: "dual-part → loopback" },
	];
	for (const { input, expectedCanonical, note } of cases) {
		it(`${note ? `${note}: ` : ""}normalizeIpLiteralHost(${JSON.stringify(input)}) === ${JSON.stringify(expectedCanonical)} (private=${true})`, () => {
			const canonical = normalizeIpLiteralHost(input);
			expect(canonical, `expected canonicalization for ${input}`).toBe(expectedCanonical);
			expect(isPrivateIpAddress(canonical!)).toBe(true);
			expect(ipFamily(canonical!)).toBe(4);
		});
	}

	it("returns undefined for non-IP hostnames", () => {
		expect(normalizeIpLiteralHost("example.com")).toBeUndefined();
	});

	it("preserves a literal IPv6 host", () => {
		const v6 = "2001:db8::1";
		expect(normalizeIpLiteralHost(v6)).toBe(v6);
		expect(ipFamily(v6)).toBe(6);
	});
});

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
		{ address: "fec0::1", expected: false, note: "outside link-local fe80::/10" },
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
		it(`${note ? `${note}: `: ""}isPrivateIpAddress(${JSON.stringify(address)}) === ${expected}`, () => {
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

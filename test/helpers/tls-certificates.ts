import { generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import { isIP } from "node:net";

/**
 * X.509 certificates for TLS tests, built in the test process: no `openssl` executable, so they work on every
 * platform the suites run on. Each certificate has its own P-256 key and is signed with ECDSA SHA-256.
 */

export interface TestCertificate {
	/** The certificate, PEM. */
	readonly cert: string;
	/** Its private key, PEM (PKCS#8). */
	readonly key: string;
	readonly subject: string;
	readonly privateKey: KeyObject;
}

export interface TestCertificateOptions {
	/** The subject's common name. */
	readonly subject: string;
	/** The certificate that signs it; it signs itself when omitted. */
	readonly issuer?: TestCertificate;
	/** `basicConstraints`: a CA, or a certificate that is not one. Omitted when undefined. */
	readonly ca?: boolean;
	/** `keyUsage`, marked critical. Omitted when undefined. */
	readonly keyUsage?: readonly ("digitalSignature" | "keyCertSign" | "cRLSign")[];
	/** `extendedKeyUsage`. Omitted when undefined. */
	readonly extendedKeyUsage?: readonly ("serverAuth" | "clientAuth")[];
	/** `subjectAltName`: host names and IP addresses. Omitted when empty. */
	readonly altNames?: readonly string[];
	/** The validity period; by default from a day ago to a day ahead. */
	readonly notBefore?: Date;
	readonly notAfter?: Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function length(size: number): Buffer {
	if (size < 0x80) return Buffer.from([size]);
	const bytes: number[] = [];
	for (let rest = size; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, ...content: Buffer[]): Buffer {
	const body = Buffer.concat(content);
	return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
}

const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const set = (...items: Buffer[]) => tlv(0x31, ...items);
const octets = (content: Buffer) => tlv(0x04, content);
const bits = (content: Buffer, unused = 0) => tlv(0x03, Buffer.from([unused]), content);
const explicit = (index: number, content: Buffer) => tlv(0xa0 + index, content);

function integer(value: Buffer): Buffer {
	return tlv(0x02, (value[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value);
}

function oid(dotted: string): Buffer {
	const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
	const bytes = [first * 40 + second];
	for (const part of rest) {
		const chunk: number[] = [part & 0x7f];
		for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128))
			chunk.unshift(0x80 | (value & 0x7f));
		bytes.push(...chunk);
	}
	return tlv(0x06, Buffer.from(bytes));
}

function name(commonName: string): Buffer {
	return sequence(set(sequence(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName, "utf8")))));
}

function time(date: Date): Buffer {
	const text = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
	// UTCTime through 2049, GeneralizedTime from 2050 (RFC 5280 4.1.2.5).
	return date.getUTCFullYear() < 2050
		? tlv(0x17, Buffer.from(`${text.slice(2)}Z`, "latin1"))
		: tlv(0x18, Buffer.from(`${text}Z`, "latin1"));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
	return sequence(oid(id), ...(critical ? [tlv(0x01, Buffer.from([0xff]))] : []), octets(value));
}

const KEY_USAGE_BITS = { digitalSignature: 0, keyCertSign: 5, cRLSign: 6 } as const;
const EXTENDED_KEY_USAGES = { serverAuth: "1.3.6.1.5.5.7.3.1", clientAuth: "1.3.6.1.5.5.7.3.2" } as const;

function ipv6Bytes(address: string): Buffer {
	const [leftText = "", rightText] = address.split("::");
	const parsePart = (part: string): number[] => {
		if (part === "") return [];
		const out: number[] = [];
		for (const group of part.split(":")) {
			if (group.includes(".")) {
				const octets = group.split(".").map(Number);
				out.push(((octets[0] ?? 0) << 8) | (octets[1] ?? 0), ((octets[2] ?? 0) << 8) | (octets[3] ?? 0));
			} else {
				out.push(Number.parseInt(group, 16));
			}
		}
		return out;
	};
	const left = parsePart(leftText);
	const right = rightText === undefined ? [] : parsePart(rightText);
	const groups = [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
	const buf = Buffer.alloc(16);
	for (let i = 0; i < 8; i++) buf.writeUInt16BE(groups[i] ?? 0, i * 2);
	return buf;
}

function altName(entry: string): Buffer {
	if (isIP(entry) === 4) return tlv(0x87, Buffer.from(entry.split(".").map(Number)));
	if (isIP(entry) === 6) return tlv(0x87, ipv6Bytes(entry));
	return tlv(0x82, Buffer.from(entry, "latin1"));
}

/** A certificate with `options`' subject and extensions, signed by its issuer, or by itself. */
export function createTestCertificate(options: TestCertificateOptions): TestCertificate {
	const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
	const signer = options.issuer?.privateKey ?? privateKey;
	const extensions: Buffer[] = [];
	if (options.ca !== undefined)
		extensions.push(extension("2.5.29.19", true, sequence(...(options.ca ? [tlv(0x01, Buffer.from([0xff]))] : []))));
	if (options.keyUsage !== undefined) {
		let mask = 0;
		for (const usage of options.keyUsage) mask |= 0x80 >> KEY_USAGE_BITS[usage];
		extensions.push(extension("2.5.29.15", true, bits(Buffer.from([mask]))));
	}
	if (options.extendedKeyUsage !== undefined)
		extensions.push(
			extension(
				"2.5.29.37",
				false,
				sequence(...options.extendedKeyUsage.map((usage) => oid(EXTENDED_KEY_USAGES[usage]))),
			),
		);
	if (options.altNames !== undefined && options.altNames.length > 0)
		extensions.push(extension("2.5.29.17", false, sequence(...options.altNames.map(altName))));
	const now = Date.now();
	const signatureAlgorithm = sequence(oid("1.2.840.10045.4.3.2"));
	const tbs = sequence(
		explicit(0, integer(Buffer.from([2]))),
		integer(Buffer.concat([Buffer.from([0x01]), randomBytes(8)])),
		signatureAlgorithm,
		name(options.issuer?.subject ?? options.subject),
		sequence(time(options.notBefore ?? new Date(now - DAY_MS)), time(options.notAfter ?? new Date(now + DAY_MS))),
		name(options.subject),
		publicKey.export({ type: "spki", format: "der" }),
		...(extensions.length > 0 ? [explicit(3, sequence(...extensions))] : []),
	);
	const certificate = sequence(tbs, signatureAlgorithm, bits(sign("sha256", tbs, signer)));
	const base64 = certificate.toString("base64").replace(/(.{64})/g, "$1\n");
	return {
		cert: `-----BEGIN CERTIFICATE-----\n${base64.trimEnd()}\n-----END CERTIFICATE-----\n`,
		key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
		subject: options.subject,
		privateKey,
	};
}

// @ts-check
/**
 * Per-run credentials: a private CA and host certificates for the database gateway and replication, an Ed25519 JWT
 * key pair, and namespace-scoped tokens. Every secret is written to a mode-600 file in the run's private directory
 * and moved to hosts as a file; none is ever placed in a command line, a log or the report.
 */
import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand } from "./commands.mjs";

/**
 * @param {string} path
 * @param {string} content
 */
export function writeSecretFile(path, content) {
	writeFileSync(path, content, { mode: 0o600 });
	chmodSync(path, 0o600);
}

/**
 * @param {object} value
 */
function base64url(value) {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * An EdDSA JWT sqld accepts: read-write on `namespaces` until `expiresAt`.
 * @param {string} privateKeyPem
 * @param {{ namespaces: readonly string[], issuedAt: number, expiresAt: number }} claims
 */
export function mintToken(privateKeyPem, { namespaces, issuedAt, expiresAt }) {
	const body = `${base64url({ alg: "EdDSA", typ: "JWT" })}.${base64url({ iat: issuedAt, exp: expiresAt, p: { rw: { ns: [...namespaces] } } })}`;
	return `${body}.${sign(null, Buffer.from(body), createPrivateKey(privateKeyPem)).toString("base64url")}`;
}

/**
 * @typedef {{ dir: string, caCert: string, decoyCaCert: string, jwtPublicKey: string, token: string, foreignToken: string,
 *   hostCert: (name: string) => { cert: string, key: string }, tokenValues: string[] }} RunSecrets
 */

/**
 * Creates the run's CA, one certificate per database host, the JWT key pair and tokens.
 * @param {import("./commands.mjs").CommandContext} context
 * @param {{ dir: string, runId: string, hosts: readonly { name: string, ip: string }[], namespaces: readonly string[],
 *   validHours: number, signal?: AbortSignal }} input
 * @returns {Promise<RunSecrets>}
 */
export async function createRunSecrets(context, { dir, runId, hosts, namespaces, validHours, signal }) {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const openssl = (/** @type {string[]} */ args, /** @type {string} */ operation) =>
		runCommand(context, "openssl", args, { operation, timeoutMs: 30_000, signal });
	const days = String(Math.max(1, Math.ceil(validHours / 24) + 1));
	const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];
	for (const [name, subject] of [
		["ca", `/CN=atomic-distributed-test ${runId} CA`],
		["decoy-ca", `/CN=atomic-distributed-test ${runId} decoy CA`],
	]) {
		await openssl(
			[
				"req",
				"-x509",
				...ec,
				"-keyout",
				join(dir, `${name}.key`),
				"-out",
				join(dir, `${name}.pem`),
				"-days",
				days,
				"-subj",
				subject,
				"-addext",
				"basicConstraints=critical,CA:TRUE",
				"-addext",
				"keyUsage=critical,keyCertSign,cRLSign",
			],
			`create ${name}`,
		);
		chmodSync(join(dir, `${name}.key`), 0o600);
	}
	for (const host of hosts) {
		const key = join(dir, `${host.name}.key`);
		const csr = join(dir, `${host.name}.csr`);
		const ext = join(dir, `${host.name}.ext`);
		writeFileSync(
			ext,
			`subjectAltName=DNS:sqld,DNS:${host.name},IP:${host.ip}\nextendedKeyUsage=serverAuth,clientAuth\nbasicConstraints=CA:FALSE\n`,
		);
		await openssl(
			["req", "-new", ...ec, "-keyout", key, "-out", csr, "-subj", `/CN=${host.name}`],
			`create ${host.name} key`,
		);
		chmodSync(key, 0o600);
		await openssl(
			[
				"x509",
				"-req",
				"-in",
				csr,
				"-CA",
				join(dir, "ca.pem"),
				"-CAkey",
				join(dir, "ca.key"),
				"-CAcreateserial",
				"-out",
				join(dir, `${host.name}.pem`),
				"-days",
				days,
				"-extfile",
				ext,
			],
			`sign ${host.name} certificate`,
		);
	}
	const jwt = generateKeyPairSync("ed25519");
	const foreign = generateKeyPairSync("ed25519");
	const publicKey = jwt.publicKey.export({ type: "spki", format: "pem" }).toString();
	const privateKey = jwt.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
	const issuedAt = Math.floor(Date.now() / 1000) - 300;
	const claims = { namespaces, issuedAt, expiresAt: issuedAt + 300 + Math.ceil(validHours * 3600) };
	const token = mintToken(privateKey, claims);
	const foreignToken = mintToken(foreign.privateKey.export({ type: "pkcs8", format: "pem" }).toString(), claims);
	writeSecretFile(join(dir, "jwt.pub"), publicKey);
	writeSecretFile(join(dir, "jwt.key"), privateKey);
	writeSecretFile(join(dir, "token"), `${token}\n`);
	writeSecretFile(join(dir, "foreign-token"), `${foreignToken}\n`);
	context.secrets.add(token);
	context.secrets.add(foreignToken);
	return {
		dir,
		caCert: join(dir, "ca.pem"),
		decoyCaCert: join(dir, "decoy-ca.pem"),
		jwtPublicKey: join(dir, "jwt.pub"),
		token: join(dir, "token"),
		foreignToken: join(dir, "foreign-token"),
		hostCert: (name) => ({ cert: join(dir, `${name}.pem`), key: join(dir, `${name}.key`) }),
		tokenValues: [token, foreignToken],
	};
}

/**
 * The credentials of a kept run, for `--reuse`; their token values are registered for redaction.
 * @param {import("./commands.mjs").CommandContext} context
 * @param {string} dir
 * @returns {RunSecrets}
 */
export function loadRunSecrets(context, dir) {
	const tokenValues = ["token", "foreign-token"].map((name) => readFileSync(join(dir, name), "utf8").trim());
	for (const value of tokenValues) context.secrets.add(value);
	return {
		dir,
		caCert: join(dir, "ca.pem"),
		decoyCaCert: join(dir, "decoy-ca.pem"),
		jwtPublicKey: join(dir, "jwt.pub"),
		token: join(dir, "token"),
		foreignToken: join(dir, "foreign-token"),
		hostCert: (name) => ({ cert: join(dir, `${name}.pem`), key: join(dir, `${name}.key`) }),
		tokenValues,
	};
}

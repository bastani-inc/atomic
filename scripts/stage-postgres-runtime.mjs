#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const licenseDirectory = join(scriptDirectory, "postgres-runtime-licenses");

export const POSTGRES_RUNTIME_ARTIFACTS = {
	"linux-x64": {
		url: "https://registry.npmjs.org/@embedded-postgres/linux-x64/-/linux-x64-18.4.0-beta.17.tgz",
		sha256: "795d587bb466423385db256dc81e61f2ee40c9e10efde21e881f3e997dd1bdb2",
		version: "18.4.0-beta.17",
		kind: "npm",
	},
	"linux-arm64": {
		url: "https://registry.npmjs.org/@embedded-postgres/linux-arm64/-/linux-arm64-18.4.0-beta.17.tgz",
		sha256: "5c2c5ba809d0f47d1bebaf46c2ea01e1fe7017beb28618e009016500107f9cea",
		version: "18.4.0-beta.17",
		kind: "npm",
	},
	"darwin-x64": {
		url: "https://registry.npmjs.org/@embedded-postgres/darwin-x64/-/darwin-x64-18.4.0-beta.17.tgz",
		sha256: "cd6fde78af989a5ebb6eb863655471f9536af7d0b0778a729f9e297221a661e7",
		version: "18.4.0-beta.17",
		kind: "npm",
	},
	"darwin-arm64": {
		url: "https://registry.npmjs.org/@embedded-postgres/darwin-arm64/-/darwin-arm64-18.4.0-beta.17.tgz",
		sha256: "1f68ab0148346d99e045a54497f72fa22f487618c97ca70fa373441d1ab1a4d3",
		version: "18.4.0-beta.17",
		kind: "npm",
	},
	"windows-x64": {
		url: "https://registry.npmjs.org/@embedded-postgres/windows-x64/-/windows-x64-18.4.0-beta.17.tgz",
		sha256: "21fc0b0fbf2d7aebbf0472cdab2f6741b39b8156a477daef7dbc52becdb7c6ba",
		version: "18.4.0-beta.17",
		kind: "npm",
	},
	"linux-x64-musl": {
		url: "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-amd64-alpine/18.6.0/embedded-postgres-binaries-linux-amd64-alpine-18.6.0.jar",
		sha256: "1568b3805c3a3b99b5f4f0d7f6cf16e2a39075462ed47a614bfbabd92508350d",
		innerEntry: "postgres-linux-x86_64-alpine_linux.txz",
		innerSha256: "d9bba3fa653ad08f5e92303587451ed6d1ca4883afb377773630ae853d40121f",
		version: "18.6.0",
		kind: "zonky",
	},
	"linux-arm64-musl": {
		url: "https://repo1.maven.org/maven2/io/zonky/test/postgres/embedded-postgres-binaries-linux-arm64v8-alpine/18.6.0/embedded-postgres-binaries-linux-arm64v8-alpine-18.6.0.jar",
		sha256: "dccf3c9c8438973e6e8cd9cd511af4a2c6a88d1c90a4cc0465a8f8797808e717",
		innerEntry: "postgres-linux-arm_64-alpine_linux.txz",
		innerSha256: "081bc36bb5a6dc1f15273282c98982156eac1bfa3e8231fbdc0ded43389dbc44",
		version: "18.6.0",
		kind: "zonky",
	},
	"windows-arm64": {
		url: "https://registry.npmjs.org/@embedded-postgres/windows-x64/-/windows-x64-18.4.0-beta.17.tgz",
		sha256: "21fc0b0fbf2d7aebbf0472cdab2f6741b39b8156a477daef7dbc52becdb7c6ba",
		version: "18.4.0-beta.17",
		kind: "windows-x64-emulated",
	},
};

const THIRD_PARTY_NOTICE = `This payload includes a PostgreSQL distribution and its bundled runtime libraries.

The Linux Alpine payloads are redistributed from io.zonky.test.postgres and include ICU, OpenSSL, libxml2, libxslt, LZ4, Zstandard, libstdc++, and libgcc components subject to their respective upstream licenses. The glibc Linux and macOS payloads are redistributed from @embedded-postgres and include their bundled libraries and licenses. The Windows payload is redistributed verbatim from @embedded-postgres/windows-x64, includes ICU, OpenSSL, libxml2, libxslt, LZ4, Zstandard, libcurl, libiconv, libintl, and wxWidgets runtime libraries, and uses Windows 11 ARM64 x64 emulation only on ARM64. See runtime-provenance.json for the exact source artifact. This additive notice does not replace the exact upstream license files included with the payload.
`;

function digest(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, args, { cwd } = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", cwd });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

const DOWNLOAD_ATTEMPT_LIMIT = 3;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_RETRY_DELAY_MS = 250;

async function fetchDownloadAttempt(url, fetchImpl, timeoutMs) {
	const signal = AbortSignal.timeout(timeoutMs);
	// AbortSignal.timeout() uses an unref'ed timer, so a stalled request can let
	// Node exit before the signal fires. This referenced timer keeps the attempt
	// alive while retaining the built-in signal's validation and error shape.
	const deadline = setTimeout(() => {}, timeoutMs);
	try {
		const response = await fetchImpl(url, { redirect: "follow", signal });
		const body = response.ok ? await response.arrayBuffer() : undefined;
		return { response, body };
	} finally {
		clearTimeout(deadline);
	}
}

function sleep(milliseconds) {
	return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function isTransientHttpStatus(status) {
	return status === 429 || status >= 500;
}

export async function download(
	url,
	destination,
	{ fetchImpl = fetch, delay = sleep, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {},
) {
	for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPT_LIMIT; attempt += 1) {
		let response;
		let body;
		try {
			({ response, body } = await fetchDownloadAttempt(url, fetchImpl, timeoutMs));
		} catch (error) {
			if (attempt === DOWNLOAD_ATTEMPT_LIMIT) throw error;
			await delay(DOWNLOAD_RETRY_DELAY_MS * attempt);
			continue;
		}

		if (!response.ok) {
			const error = new Error(`download failed (${response.status} ${response.statusText}): ${url}`);
			if (!isTransientHttpStatus(response.status) || attempt === DOWNLOAD_ATTEMPT_LIMIT) throw error;
			await delay(DOWNLOAD_RETRY_DELAY_MS * attempt);
			continue;
		}
		writeFileSync(destination, Buffer.from(body));
		return;
	}
}

function copyTree(source, destination) {
	const stat = lstatSync(source);
	if (stat.isSymbolicLink()) {
		symlinkSync(readlinkSync(source), destination);
		return;
	}
	if (stat.isDirectory()) {
		mkdirSync(destination, { recursive: true });
		for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name));
		return;
	}
	copyFileSync(source, destination);
	chmodSync(destination, stat.mode & 0o777);
}

function replaceSymlinksWithManifest(root, directory, manifest) {
	const canonicalRoot = realpathSync(root);
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		const stat = lstatSync(path);
		if (stat.isDirectory()) replaceSymlinksWithManifest(root, path, manifest);
		if (!stat.isSymbolicLink()) continue;
		const source = relative(canonicalRoot, realpathSync(path)).split("\\").join("/");
		const target = relative(root, path).split("\\").join("/");
		if (source.startsWith("../")) throw new Error(`symlink escapes runtime: ${target}`);
		manifest.push({ source, target });
		unlinkSync(path);
	}
}

function addPayloadToPackageFiles(packageRoot) {
	const manifestPath = join(packageRoot, "package.json");
	if (!existsSync(manifestPath)) throw new Error(`native leaf is missing package.json: ${manifestPath}`);
	const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
	const files = Array.isArray(manifest.files) ? manifest.files : [];
	if (!files.includes("postgres-runtime")) files.push("postgres-runtime");
	manifest.files = files;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}
function validatePostgresArchitecture(target, postgresPath) {
	const binary = readFileSync(postgresPath);
	if (target.startsWith("windows-")) {
		if (binary.length < 0x40 || binary.toString("ascii", 0, 2) !== "MZ") {
			throw new Error(`${target} payload is not a PE executable`);
		}
		const peOffset = binary.readUInt32LE(0x3c);
		if (peOffset + 6 > binary.length || binary.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
			throw new Error(`${target} payload has no PE signature`);
		}
		const machine = binary.readUInt16LE(peOffset + 4);
		if (machine !== 0x8664)
			throw new Error(`${target} payload PostgreSQL must be x64 PE (received 0x${machine.toString(16)})`);
		return;
	}
	if (target.startsWith("darwin-")) {
		const expectedCpu = target.endsWith("x64") ? 0x01000007 : 0x0100000c;
		if (binary.length >= 8 && binary.readUInt32LE(0) === 0xfeedfacf && binary.readUInt32LE(4) === expectedCpu) return;
		// Upstream macOS packages contain universal binaries. Require a real matching slice.
		if (binary.length >= 8 && binary.readUInt32BE(0) === 0xcafebabe) {
			const count = binary.readUInt32BE(4);
			for (let i = 0; i < count && 8 + (i + 1) * 20 <= binary.length; i += 1) {
				const offset = binary.readUInt32BE(8 + i * 20 + 8);
				const size = binary.readUInt32BE(8 + i * 20 + 12);
				if (
					size >= 8 &&
					offset + size <= binary.length &&
					binary.readUInt32LE(offset) === 0xfeedfacf &&
					binary.readUInt32LE(offset + 4) === expectedCpu
				)
					return;
			}
		}
		throw new Error(`${target} payload does not contain the expected Mach-O CPU`);
	}
	if (binary.length < 20 || binary.toString("hex", 0, 4) !== "7f454c46" || binary[4] !== 2 || binary[5] !== 1) {
		throw new Error(`${target} payload postgres is not a little-endian ELF64 executable`);
	}
	const expectedMachine = target.includes("x64") ? 62 : 183;
	const machine = binary.readUInt16LE(18);
	const expectedLoader = target.endsWith("musl")
		? `/lib/ld-musl-${target.includes("x64") ? "x86_64" : "aarch64"}.so.1`
		: target.includes("x64")
			? "/lib64/ld-linux-x86-64.so.2"
			: "/lib/ld-linux-aarch64.so.1";
	if (machine !== expectedMachine || !binary.includes(Buffer.from(expectedLoader))) {
		throw new Error(
			`${target} payload does not match ELF machine ${expectedMachine} and interpreter ${expectedLoader}`,
		);
	}
}

function writeLicensesAndProvenance(destination, target, artifact, upstreamLicense) {
	copyFileSync(join(licenseDirectory, "POSTGRESQL-LICENSE"), join(destination, "POSTGRESQL-LICENSE"));
	if (artifact.kind === "zonky") {
		copyFileSync(join(licenseDirectory, "ZONKY-APACHE-2.0-LICENSE"), join(destination, "ZONKY-APACHE-2.0-LICENSE"));
	} else if (upstreamLicense !== undefined) {
		copyFileSync(upstreamLicense, join(destination, "EMBEDDED-POSTGRES-UPSTREAM-LICENSE.md"));
	}
	writeFileSync(join(destination, "THIRD-PARTY-NOTICE"), THIRD_PARTY_NOTICE);
	writeFileSync(
		join(destination, "runtime-provenance.json"),
		`${JSON.stringify(
			{
				target,
				upstreamUrl: artifact.url,
				upstreamVersion: artifact.version,
				sha256: artifact.sha256,
				innerEntry: artifact.innerEntry,
				innerSha256: artifact.innerSha256,
				emulated: artifact.kind === "windows-x64-emulated",
				emulation:
					artifact.kind === "windows-x64-emulated"
						? "Windows x64 PostgreSQL under Windows 11 ARM64 x64 emulation"
						: undefined,
			},
			null,
			2,
		)}\n`,
	);
}

function runtimePath(root, path) {
	if (
		typeof path !== "string" ||
		path.length === 0 ||
		path.startsWith("/") ||
		path.includes("\\") ||
		path.includes(":") ||
		path.split("/").some((part) => part === ".." || part === ".")
	) {
		throw new Error(`invalid runtime path: ${path}`);
	}
	return join(root, path);
}

function validatePayload(root, target) {
	const suffix = target.startsWith("windows-") ? ".exe" : "";
	for (const name of ["postgres", "initdb", "pg_ctl"]) {
		const path = join(root, "bin", `${name}${suffix}`);
		if (!existsSync(path)) throw new Error(`staged artifact is missing bin/${name}${suffix}`);
		validatePostgresArchitecture(target, path);
		if (!suffix) chmodSync(path, lstatSync(path).mode | 0o555);
	}
	if (!existsSync(join(root, "lib")) || readdirSync(join(root, "lib")).length === 0)
		throw new Error("runtime is missing libraries");
	if (!["share/postgres.bki", "share/postgresql/postgres.bki"].some((path) => existsSync(join(root, path))))
		throw new Error("runtime is missing cluster catalog postgres.bki");
	const links = JSON.parse(readFileSync(join(root, "pg-symlinks.json"), "utf8"));
	const targets = new Map();
	for (const { source, target: link } of links) {
		const sourcePath = runtimePath(root, source);
		runtimePath(root, link);
		if (!existsSync(sourcePath) || !lstatSync(sourcePath).isFile()) throw new Error(`missing link source: ${source}`);
		if (targets.has(link) && targets.get(link) !== source) throw new Error(`conflicting runtime link: ${link}`);
		targets.set(link, source);
	}
}

/** Producer-only validation; deliberately not applied to user/legacy runtime overrides. */
export function validatePostgresRuntime(root, target, artifact = POSTGRES_RUNTIME_ARTIFACTS[target]) {
	if (!Object.hasOwn(POSTGRES_RUNTIME_ARTIFACTS, target))
		throw new Error(`unsupported PostgreSQL runtime target: ${target}`);
	validatePayload(root, target);
	const provenance = JSON.parse(readFileSync(join(root, "runtime-provenance.json"), "utf8"));
	if (
		provenance.target !== target ||
		provenance.sha256 !== artifact.sha256 ||
		provenance.upstreamUrl !== artifact.url ||
		provenance.upstreamVersion !== artifact.version ||
		provenance.emulated !== (target === "windows-arm64")
	)
		throw new Error(`runtime provenance mismatch for ${target}`);
	for (const name of [
		"POSTGRESQL-LICENSE",
		"THIRD-PARTY-NOTICE",
		artifact.kind === "zonky" ? "ZONKY-APACHE-2.0-LICENSE" : "EMBEDDED-POSTGRES-UPSTREAM-LICENSE.md",
	]) {
		if (!readFileSync(join(root, name)).length) throw new Error(`empty runtime license: ${name}`);
	}
	const inventory = JSON.parse(readFileSync(join(root, "payload-files.json"), "utf8"));
	if (inventory.length === 0) throw new Error("empty runtime inventory");
	for (const { path, sha256 } of inventory) {
		if (digest(runtimePath(root, path)) !== sha256) throw new Error(`runtime file checksum mismatch: ${path}`);
	}
}

function payloadInventory(root, directory = root) {
	return readdirSync(directory).flatMap((name) => {
		const path = join(directory, name);
		return lstatSync(path).isDirectory()
			? payloadInventory(root, path)
			: [{ path: relative(root, path).split("\\").join("/"), sha256: digest(path) }];
	});
}
export async function stagePostgresRuntime({
	target,
	packageRoot,
	artifactFile,
	artifact = POSTGRES_RUNTIME_ARTIFACTS[target],
}) {
	if (!Object.hasOwn(POSTGRES_RUNTIME_ARTIFACTS, target) || artifact === undefined)
		throw new Error(`unsupported PostgreSQL runtime target: ${target}`);
	const work = mkdtempSync(join(tmpdir(), "atomic-postgres-runtime-"));
	try {
		const archive = join(work, basename(new URL(artifact.url).pathname));
		if (artifactFile === undefined) await download(artifact.url, archive);
		else copyFileSync(resolve(artifactFile), archive);
		const actual = digest(archive);
		if (actual !== artifact.sha256) {
			throw new Error(`checksum mismatch for ${target}: expected ${artifact.sha256}, received ${actual}`);
		}

		const extracted = join(work, "extracted");
		mkdirSync(extracted);
		let upstreamLicense;
		if (artifact.kind === "zonky") {
			run("unzip", ["-q", archive, artifact.innerEntry, "-d", work]);
			const inner = join(work, artifact.innerEntry);
			const innerActual = digest(inner);
			if (innerActual !== artifact.innerSha256) {
				throw new Error(
					`inner checksum mismatch for ${target}: expected ${artifact.innerSha256}, received ${innerActual}`,
				);
			}
			// Paths are relative to `work`: GNU tar (Git for Windows) reads an
			// absolute `C:\...` argument as `host:path` and tries to connect to "C".
			run("tar", ["-xJf", artifact.innerEntry, "-C", "extracted"], { cwd: work });
		} else {
			run("tar", ["-xzf", basename(archive), "-C", "."], { cwd: work });
			const packageDirectory = join(work, "package");
			const native = join(packageDirectory, "native");
			if (!existsSync(native)) throw new Error("artifact is missing package/native");
			for (const name of readdirSync(native)) copyTree(join(native, name), join(extracted, name));
			const license = join(packageDirectory, "LICENSE.md");
			if (!existsSync(license)) throw new Error("artifact is missing upstream LICENSE.md");
			upstreamLicense = license;
		}

		// Validate all entrypoints, not just postgres: a mixed payload must fail here.
		const manifestPath = join(extracted, "pg-symlinks.json");
		const symlinks = existsSync(manifestPath)
			? JSON.parse(readFileSync(manifestPath, "utf8")).map(({ source, target }) => ({
					source: source.replace(/^native\//u, ""),
					target: target.replace(/^native\//u, ""),
				}))
			: [];
		replaceSymlinksWithManifest(extracted, extracted, symlinks);
		symlinks.sort((left, right) => left.target.localeCompare(right.target));
		writeFileSync(join(extracted, "pg-symlinks.json"), `${JSON.stringify(symlinks, null, 2)}\n`);
		writeLicensesAndProvenance(extracted, target, artifact, upstreamLicense);
		validatePayload(extracted, target);
		writeFileSync(join(extracted, "payload-files.json"), `${JSON.stringify(payloadInventory(extracted), null, 2)}\n`);
		validatePostgresRuntime(extracted, target, artifact);

		const destination = join(resolve(packageRoot), "postgres-runtime");
		rmSync(destination, { recursive: true, force: true });
		copyTree(extracted, destination);
		addPayloadToPackageFiles(resolve(packageRoot));
		console.log(`Staged PostgreSQL runtime ${target} at ${destination} (${symlinks.length} symlinks recorded)`);
		return destination;
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

async function main(args) {
	const [target, packageRoot, ...rest] = args;
	if (!target || !packageRoot) {
		throw new Error("usage: stage-postgres-runtime.mjs <target> <native-package-root> [--artifact <path>]");
	}
	if (rest.includes("--validate")) {
		validatePostgresRuntime(join(resolve(packageRoot), "postgres-runtime"), target);
		return;
	}
	const artifactIndex = rest.indexOf("--artifact");
	await stagePostgresRuntime({
		target,
		packageRoot,
		artifactFile: artifactIndex === -1 ? undefined : rest[artifactIndex + 1],
	});
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	main(process.argv.slice(2)).catch((error) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}

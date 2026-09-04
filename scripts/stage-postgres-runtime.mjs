#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const licenseDirectory = join(scriptDirectory, "postgres-runtime-licenses");

export const POSTGRES_RUNTIME_ARTIFACTS = {
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

The Linux Alpine payloads are redistributed from io.zonky.test.postgres and include ICU, OpenSSL, libxml2, libxslt, LZ4, Zstandard, libstdc++, and libgcc components subject to their respective upstream licenses. The Windows payload is redistributed verbatim from @embedded-postgres/windows-x64, includes ICU, OpenSSL, libxml2, libxslt, LZ4, Zstandard, libcurl, libiconv, libintl, and wxWidgets runtime libraries, and runs through Windows 11 ARM64 x64 emulation. See runtime-provenance.json for the exact source artifact. This additive notice does not replace the exact upstream license files included with the payload.
`;

function digest(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function run(command, args) {
	const result = spawnSync(command, args, { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
}

const DOWNLOAD_ATTEMPT_LIMIT = 3;
const DOWNLOAD_TIMEOUT_MS = 30_000;
const DOWNLOAD_RETRY_DELAY_MS = 250;

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
		try {
			response = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
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

		let body;
		try {
			body = await response.arrayBuffer();
		} catch (error) {
			if (attempt === DOWNLOAD_ATTEMPT_LIMIT) throw error;
			await delay(DOWNLOAD_RETRY_DELAY_MS * attempt);
			continue;
		}
		writeFileSync(destination, Buffer.from(body));
		return;
	}
}

function copyTree(source, destination) {
	const stat = lstatSync(source);
	if (stat.isDirectory()) {
		mkdirSync(destination, { recursive: true });
		for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name));
		return;
	}
	copyFileSync(source, destination);
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
	if (target === "windows-arm64") {
		if (binary.length < 0x40 || binary.toString("ascii", 0, 2) !== "MZ") {
			throw new Error("Windows ARM64 payload postgres.exe is not a PE executable");
		}
		const peOffset = binary.readUInt32LE(0x3c);
		if (binary.toString("binary", peOffset, peOffset + 4) !== "PE\0\0") {
			throw new Error("Windows ARM64 payload postgres.exe has no PE signature");
		}
		const machine = binary.readUInt16LE(peOffset + 4);
		if (machine !== 0x8664)
			throw new Error(`Windows ARM64 payload PostgreSQL must be x64 PE (received 0x${machine.toString(16)})`);
		return;
	}
	if (binary.length < 20 || binary.toString("hex", 0, 4) !== "7f454c46") {
		throw new Error(`${target} payload postgres is not an ELF executable`);
	}
	const expectedMachine = target === "linux-x64-musl" ? 62 : 183;
	const machine = binary.readUInt16LE(18);
	const expectedLoader = target === "linux-x64-musl" ? "/lib/ld-musl-x86_64.so.1" : "/lib/ld-musl-aarch64.so.1";
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

export async function stagePostgresRuntime({
	target,
	packageRoot,
	artifactFile,
	artifact = POSTGRES_RUNTIME_ARTIFACTS[target],
}) {
	if (artifact === undefined) throw new Error(`unsupported PostgreSQL runtime target: ${target}`);
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
			run("tar", ["-xJf", inner, "-C", extracted]);
		} else {
			run("tar", ["-xzf", archive, "-C", work]);
			const packageDirectory = join(work, "package");
			const native = join(packageDirectory, "native");
			if (!existsSync(native)) throw new Error("Windows artifact is missing package/native");
			for (const name of readdirSync(native)) copyTree(join(native, name), join(extracted, name));
			const license = join(packageDirectory, "LICENSE.md");
			if (existsSync(license)) upstreamLicense = license;
		}

		const suffix = target === "windows-arm64" ? ".exe" : "";
		for (const binary of ["postgres", "initdb", "pg_ctl"]) {
			if (!existsSync(join(extracted, "bin", `${binary}${suffix}`))) {
				throw new Error(`staged artifact is missing bin/${binary}${suffix}`);
			}
		}
		validatePostgresArchitecture(target, join(extracted, "bin", `postgres${suffix}`));
		const symlinks = [];
		replaceSymlinksWithManifest(extracted, extracted, symlinks);
		symlinks.sort((left, right) => left.target.localeCompare(right.target));
		writeFileSync(join(extracted, "pg-symlinks.json"), `${JSON.stringify(symlinks, null, 2)}\n`);
		writeLicensesAndProvenance(extracted, target, artifact, upstreamLicense);

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

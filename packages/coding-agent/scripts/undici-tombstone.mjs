/**
 * Appends 8 minimal pure-ESM restart-notice files under `package/node_modules/undici/` directly to `@bastani/atomic`'s
 * packed tarball during `postpack`.
 *
 * Releases before 0.10.4-alpha.2 (0.10.3 and 0.10.4-alpha.1) loaded `undici` from `node_modules` at startup. On an
 * idle session's first HTTP request after an in-place global update removes `undici`, that in-memory `undici` lazily
 * requires `lib/llhttp/llhttp-wasm.js` (and related parser/WebIDL shims) from `node_modules/@bastani/atomic/node_modules/undici/`.
 *
 * Shipping these 8 files directly in the tarball (without `bundleDependencies`, without `optionalDependencies.undici`,
 * and without `node_modules/undici/package.json`) avoids an npm 10 arborist bug where any `bundleDependencies` entry
 * pulls every platform's `@bastani/atomic-natives-*` and `@mariozechner/clipboard-*` packages (+41 MiB), keeps
 * `npm ls` and `npm audit` completely clean, never mutates the workspace checkout, and never shadows a real `undici`
 * for SDK apps or extensions. Because `@bastani/atomic` is `"type": "module"` and requires Node >= 22.19, Node's
 * synchronous `require(esm)` evaluates each shim, throws `UpdatedInstallError` on every call without caching an empty
 * export, and avoids the 3-attempt retry loop in 0.10.3 and 0.10.4-alpha.1.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { codeStringLiteral } from "./code-string-literal.mjs";

const defaultPackageDir = fileURLToPath(new URL("..", import.meta.url));

/** Lazily required paths inside `undici@8.12.3` that an idle 0.10.3 or 0.10.4-alpha.1 session may resolve on demand. */
export const UNDICI_TOMBSTONE_SHIMS = [
	"lib/llhttp/llhttp-wasm.js",
	"lib/llhttp/llhttp_simd-wasm.js",
	"lib/milo/no-simd.js",
	"lib/milo/simd.js",
	"lib/web/fetch/body.js",
	"lib/web/fetch/formdata.js",
	"lib/web/webidl/index.js",
];

const RESTART_NOTICE_SOURCE = `import { readFileSync } from "node:fs";

/**
 * Throws a restart notice when an idle 0.10.3 or 0.10.4-alpha.1 session's in-memory undici lazily requires a file
 * that this release removed. Includes "Missing file" so those earlier releases' failure classifier treats the turn as
 * non-retryable instead of retrying 3 times over 14 seconds or burning fallback models.
 */
export function throwUndiciRestartError() {
	let app = "atomic";
	let version = "";
	try {
		const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
		if (pkg && pkg.atomicConfig && typeof pkg.atomicConfig.name === "string" && pkg.atomicConfig.name !== "") {
			app = pkg.atomicConfig.name;
		}
		if (pkg && typeof pkg.version === "string" && pkg.version !== "") {
			version = pkg.version;
		}
	} catch {
		// Fall back to the generic wording when the installed manifest cannot be read.
	}
	const message = version
		? \`\${app} was updated to \${version} while this session was running; restart it to keep using model requests. (Missing file from the earlier installation.)\`
		: \`The \${app} installation this session runs from was updated while this session was running; restart it to keep using model requests. (Missing file from the earlier installation.)\`;
	const error = new Error(message);
	error.name = "UpdatedInstallError";
	error.feature = "model requests";
	throw error;
}
`;

/** Returns the 8 tombstone entries (`path` relative to `package/` and UTF-8 `contents`). */
export function undiciTombstoneEntries() {
	return [
		{ path: "node_modules/undici/restart-notice.js", contents: RESTART_NOTICE_SOURCE },
		...UNDICI_TOMBSTONE_SHIMS.map((shim) => {
			const depth = shim.split("/").length - 1;
			const helper = `${"../".repeat(depth)}restart-notice.js`;
			return {
				path: `node_modules/undici/${shim}`,
				contents: `import { throwUndiciRestartError } from ${codeStringLiteral(helper)};\nthrowUndiciRestartError();\n`,
			};
		}),
	];
}

const TAR_BLOCK = 512;

function isZeroBlock(buf, offset) {
	const end = Math.min(offset + TAR_BLOCK, buf.length);
	for (let i = offset; i < end; i++) {
		if (buf[i] !== 0) return false;
	}
	return true;
}

function parseTarSize(header, offset) {
	// GNU/PAX binary base-256 size if MSB of byte 124 is set.
	if ((header[offset + 124] & 0x80) !== 0) {
		let value = BigInt(header[offset + 124] & 0x7f);
		for (let i = 1; i < 12; i++) value = (value << 8n) | BigInt(header[offset + 124 + i]);
		return Number(value);
	}
	const raw = header
		.subarray(offset + 124, offset + 136)
		.toString("ascii")
		.replace(/\0.*$/, "")
		.trim();
	return raw === "" ? 0 : Number.parseInt(raw, 8);
}

function pad512(size) {
	const rem = size % TAR_BLOCK;
	return rem === 0 ? size : size + (TAR_BLOCK - rem);
}

/** Builds a POSIX ustar 512-byte header + padded payload for a single regular file (path <= 100 ASCII bytes). */
function buildUstarFileRecord(tarPath, contentBuffer, mtimeSeconds) {
	if (Buffer.byteLength(tarPath, "utf8") > 100) {
		throw new Error(`undici-tombstone: tar entry path exceeds 100 bytes: ${tarPath}`);
	}
	const header = Buffer.alloc(TAR_BLOCK, 0);
	header.write(tarPath, 0, 100, "utf8");
	header.write("0000644\0", 100, 8, "ascii");
	header.write("0000000\0", 108, 8, "ascii");
	header.write("0000000\0", 116, 8, "ascii");
	header.write(`${contentBuffer.length.toString(8).padStart(11, "0")}\0`, 124, 12, "ascii");
	header.write(`${Math.max(0, Math.floor(mtimeSeconds)).toString(8).padStart(11, "0")}\0`, 136, 12, "ascii");
	header.fill(0x20, 148, 156); // Checksum field treated as ASCII spaces while summing.
	header[156] = 0x30; // '0' = regular file
	header.write("ustar\0", 257, 6, "ascii");
	header.write("00", 263, 2, "ascii");

	let checksum = 0;
	for (let i = 0; i < TAR_BLOCK; i++) checksum += header[i];
	header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");

	const paddedSize = pad512(contentBuffer.length);
	const payload = Buffer.alloc(paddedSize, 0);
	contentBuffer.copy(payload);
	return Buffer.concat([header, payload]);
}

/**
 * Appends the 8 undici restart-notice files under `package/node_modules/undici/` to `tarballPath` atomically.
 * Idempotent: skips any entry already present in the tarball.
 */
export function appendUndiciTombstoneToTarball(tarballPath) {
	const tar = gunzipSync(readFileSync(tarballPath));
	const existing = new Set();
	let offset = 0;
	let mtimeSeconds = 0;
	while (offset + TAR_BLOCK <= tar.length) {
		if (isZeroBlock(tar, offset)) break;
		const name = tar
			.subarray(offset, offset + 100)
			.toString("utf8")
			.replace(/\0.*$/, "");
		const prefix = tar
			.subarray(offset + 345, offset + 500)
			.toString("utf8")
			.replace(/\0.*$/, "");
		const fullName = prefix ? `${prefix}/${name}` : name;
		existing.add(fullName);
		if (fullName === "package/package.json") {
			const mtimeRaw = tar
				.subarray(offset + 136, offset + 148)
				.toString("ascii")
				.replace(/\0.*$/, "")
				.trim();
			if (mtimeRaw !== "") mtimeSeconds = Number.parseInt(mtimeRaw, 8) || 0;
		}
		const size = parseTarSize(tar, offset);
		offset += TAR_BLOCK + pad512(size);
	}

	const toAppend = [];
	for (const entry of undiciTombstoneEntries()) {
		const tarPath = `package/${entry.path}`;
		if (existing.has(tarPath)) continue;
		toAppend.push(buildUstarFileRecord(tarPath, Buffer.from(entry.contents, "utf8"), mtimeSeconds));
	}
	if (toAppend.length === 0) return false;

	const eof = Buffer.alloc(TAR_BLOCK * 2, 0);
	const updatedTar = Buffer.concat([tar.subarray(0, offset), ...toAppend, eof]);
	const tmpPath = `${tarballPath}.tombstone.${process.pid}.tmp`;
	writeFileSync(tmpPath, gzipSync(updatedTar, { level: 9 }));
	renameSync(tmpPath, tarballPath);
	return true;
}

/** Resolves the tarball just written by `npm pack` and appends the undici tombstone unless `--dry-run`. */
export function appendUndiciTombstonePostpack(packageDir = defaultPackageDir) {
	if (process.env.npm_config_dry_run === "true") return false;
	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const fileName = `${manifest.name.replace(/^@/, "").replace("/", "-")}-${manifest.version}.tgz`;
	const destDir = resolve(process.env.INIT_CWD ?? packageDir, process.env.npm_config_pack_destination ?? ".");
	const tarballPath = join(destDir, fileName);
	if (!existsSync(tarballPath)) return false;
	return appendUndiciTombstoneToTarball(tarballPath);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const tarball = process.argv[2];
	if (tarball) appendUndiciTombstoneToTarball(tarball);
	else appendUndiciTombstonePostpack(defaultPackageDir);
}

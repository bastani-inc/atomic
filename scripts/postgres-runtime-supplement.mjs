import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { relocateMachO } from "./relocate-postgres-macho.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
export const MACOS_RUNTIME_INPUTS = {
	edb: {
		url: "https://get.enterprisedb.com/postgresql/postgresql-18.4-1-osx-binaries.zip",
		sha256: "e3af8c3b4a98a790dba60f2733673b35712a81a201b1f9af6e8ebed5d3b64d0c",
	},
	languagepack: {
		url: "https://get.enterprisedb.com/languagepacks/edb-languagepack-6.5-1-osx.zip",
		sha256: "0efdb2609228ed83b7b481fb08274fa659b70d823b9a5bdd5f48a59c7bbb8b57",
	},
	extractor: {
		url: "https://files.pythonhosted.org/packages/62/cd/998430ea1ae47cc6a105e4c7cc9e9a7d71b92771624ccf9107df9017d8bf/bitrock_unpacker-0.1.2-py3-none-any.whl",
		sha256: "61ad3e43e321fa111d6e71285f21967073e7f96c4a17c32a5bda7df1fe63b7bb",
	},
};
const signerHashes = {
	"darwin-arm64": ["aarch64-apple-darwin", "d1a532150adaf90048260d76359261aa716abafc45c53c5dc18845029184334a"],
	"darwin-x64": ["x86_64-apple-darwin", "14ef11bedd51a8d95eafd767939ae96d5900e5a61511bef75bb21db6e7c74140"],
	"linux-arm64": ["aarch64-unknown-linux-musl", "4af92c87ddf52f5f2d1258a3b4e56c7dcb8f1b2468df744976c5f139e031961f"],
	"linux-x64": ["x86_64-unknown-linux-musl", "dbe85cedd8ee4217b64e9a0e4c2aef92ab8bcaaa41f20bde99781ff02e600002"],
};
function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024, ...options });
	if (result.status !== 0) throw new Error(`${command} failed: ${result.error ?? result.stderr ?? result.stdout}`);
}
function digest(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}
async function fetchInput(input, work, download) {
	const cache = join(tmpdir(), "atomic-postgres-verified-inputs");
	mkdirSync(cache, { recursive: true });
	const cached = join(cache, input.sha256);
	if (existsSync(cached) && digest(cached) === input.sha256) return cached;
	const path = join(work, input.sha256);
	await download(input.url, path);
	if (digest(path) !== input.sha256) throw new Error(`PostgreSQL supplement checksum mismatch: ${input.url}`);
	const pending = `${cached}.${process.pid}`;
	copyFileSync(path, pending);
	renameSync(pending, cached);
	return cached;
}
function files(root) {
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
		const path = join(root, entry.name);
		return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
	});
}
function macho(bytes) {
	if (bytes.length < 32) return false;
	if (bytes.readUInt32LE(0) === 0xfeedfacf) return [2, 6, 8].includes(bytes.readUInt32LE(12));
	if (bytes.readUInt32BE(0) !== 0xcafebabe) return false;
	const offset = bytes.readUInt32BE(16);
	return offset + 32 <= bytes.length && macho(bytes.subarray(offset));
}

async function copySupplementLicenses(root, work, download, macOS) {
	const all = JSON.parse(readFileSync(join(directory, "postgres-supplement-license-inputs.json"), "utf8"));
	const selected = Object.fromEntries(
		Object.entries(all).filter(([name]) => ["CURL-8.20.0", "LIBXSLT-1.1.45"].includes(name) === macOS),
	);
	const destination = join(root, "supplement-licenses");
	mkdirSync(destination, { recursive: true });
	for (const [name, input] of Object.entries(selected))
		copyFileSync(await fetchInput(input, work, download), join(destination, `${name}.txt`));
	writeFileSync(join(destination, "license-provenance.json"), `${JSON.stringify(selected, null, 2)}\n`);
}

export async function supplementMacOSRuntime(root, work, download) {
	const postgresModules = files(join(root, "lib/postgresql"))
		.filter((path) => path.endsWith(".dylib"))
		.map((path) => relative(root, path));
	const signer = signerHashes[`${process.platform}-${process.arch}`];
	if (!signer) throw new Error(`Unsupported PostgreSQL signing host: ${process.platform}-${process.arch}`);
	const signerInput = {
		url: `https://github.com/indygreg/apple-platform-rs/releases/download/apple-codesign/0.29.0/apple-codesign-0.29.0-${signer[0]}.tar.gz`,
		sha256: signer[1],
	};
	const inputs = { ...MACOS_RUNTIME_INPUTS, signer: signerInput };
	const paths = Object.fromEntries(
		await Promise.all(
			Object.entries(inputs).map(async ([name, input]) => [name, await fetchInput(input, work, download)]),
		),
	);
	const unpack = join(work, "supplement");
	mkdirSync(unpack);
	run("unzip", ["-q", paths.extractor, "-d", join(unpack, "python")]);
	run("unzip", ["-q", paths.languagepack, "-d", join(unpack, "installer")]);
	const installer = join(unpack, "installer/edb-languagepack-6.5-1-osx.app/Contents/Resources/installbuilder");
	run(
		"python3",
		[
			join(directory, "unpack-postgres-languagepack.py"),
			installer,
			"--extract",
			join(unpack, "languagepack"),
			"--yes-all",
		],
		{ env: { ...process.env, PYTHONPATH: join(unpack, "python") } },
	);
	cpSync(join(unpack, "languagepack/default/programfilesosx"), join(root, "lp"), {
		recursive: true,
		verbatimSymlinks: true,
	});
	const framework = "pgsql/stackbuilder/stackbuilder.app/Contents/Frameworks/";
	const members = [
		"pgsql/lib/libxslt.1.dylib",
		...["libcurl.4.dylib", "libssl.3.dylib", "libcrypto.3.dylib", "libz.1.3.2.dylib"].map((name) => framework + name),
	];
	run("unzip", ["-q", paths.edb, ...members, "-d", unpack]);
	mkdirSync(join(root, "Frameworks"));
	copyFileSync(join(unpack, "pgsql/lib/libxslt.1.dylib"), join(root, "lib/libxslt.1.dylib"));
	for (const [name, destination] of [
		["libcurl.4.dylib", "lib/libcurl.4.dylib"],
		["libssl.3.dylib", "Frameworks/libssl.3.dylib"],
		["libcrypto.3.dylib", "Frameworks/libcrypto.3.dylib"],
		["libz.1.3.2.dylib", "Frameworks/libz.1.dylib"],
	])
		copyFileSync(join(unpack, framework, name), join(root, destination));
	// The arm64 plpython transform has no header padding for a long install name.
	// Keep its reference short and supply its two loader-relative dependencies.
	for (const [source, target] of [
		["libpython3.13.dylib", "P"],
		["libintl.8.dylib", "libintl.8.dylib"],
		["libiconv.2.dylib", "libiconv.2.dylib"],
	])
		copyFileSync(join(root, "lp/Python-3.13/lib", source), join(root, "lib/postgresql", target));
	run("tar", ["-xzf", paths.signer, "-C", unpack]);
	const rcodesign = join(unpack, `apple-codesign-0.29.0-${signer[0]}/rcodesign`);
	const changed = [];
	for (const path of files(root)) {
		if (!macho(readFileSync(path))) continue;
		const replacements = new Map([["/lib/libpython3.13.dylib", "@loader_path/P"]]);
		for (const [language, library] of [
			["Perl-5.42", "lib/CORE/libperl.dylib"],
			["Python-3.13", "lib/libpython3.13.dylib"],
			["Tcl-8.6", "lib/libtcl8.6.dylib"],
		]) {
			replacements.set(
				`/Library/edb/languagepack/v6/${language}/${library}`,
				`@loader_path/${relative(dirname(path), join(root, "lp", language, library))}`,
			);
		}
		const modified = relocateMachO(path, replacements);
		// Vendor signatures on untouched PostgreSQL/EDB images remain intact. The raw
		// languagepack's inner images are unsigned; sign these and changed modules.
		if (
			modified ||
			path.startsWith(`${join(root, "lp")}/`) ||
			["P", "libintl.8.dylib", "libiconv.2.dylib"].some((name) => path === join(root, "lib/postgresql", name))
		) {
			run(rcodesign, [
				"sign",
				"--config-file",
				"/dev/null",
				"--binary-identifier",
				`org.bastani.postgres.${basename(path)}`,
				path,
			]);
			if (process.platform === "darwin") run("codesign", ["--verify", "--all-architectures", path]);
			changed.push(relative(root, path));
		}
	}
	const notices = join(root, "supplement-licenses");
	mkdirSync(notices);
	copyFileSync(join(root, "lp/languagepack_3rd_party_licenses.txt"), join(notices, "EDB-LANGUAGEPACK.txt"));
	copyFileSync(
		join(unpack, "python/bitrock_unpacker-0.1.2.dist-info/licenses/LICENSE.md"),
		join(notices, "BUILD-EXTRACTOR-MIT.txt"),
	);
	copyFileSync(join(unpack, `apple-codesign-0.29.0-${signer[0]}/COPYING`), join(notices, "BUILD-SIGNER-COPYING.txt"));
	writeFileSync(
		join(root, "language-runtime.json"),
		`${JSON.stringify(
			{ PYTHONHOME: ["lp/Python-3.13"], PERL5LIB: ["lp/Perl-5.42/lib"], TCL_LIBRARY: ["lp/Tcl-8.6/lib/tcl8.6"] },
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(root, "supplement-provenance.json"),
		`${JSON.stringify(
			{
				inputs,
				postgresModules,
				transformation: "fixed-size loader-relative imports; ad-hoc signatures on changed/unsigned images only",
				signedImages: changed,
			},
			null,
			2,
		)}\n`,
	);
	await copySupplementLicenses(root, work, download, true);
}

function copyDebTree(source, destination, archiveRoot, stack = new Set()) {
	if (stack.has(source)) throw new Error(`cyclic Debian runtime alias: ${source}`);
	const inside = relative(archiveRoot, source);
	if (isAbsolute(inside) || inside === ".." || inside.startsWith("../"))
		throw new Error("Debian runtime alias escapes archive");
	const stat = lstatSync(source);
	if (stat.isSymbolicLink()) {
		const link = readlinkSync(source);
		const target = isAbsolute(link) ? resolve(archiveRoot, `.${link}`) : resolve(dirname(source), link);
		return copyDebTree(target, destination, archiveRoot, new Set([...stack, source]));
	}
	if (stat.isDirectory()) {
		mkdirSync(destination, { recursive: true });
		for (const name of readdirSync(source))
			copyDebTree(join(source, name), join(destination, name), archiveRoot, stack);
	} else if (stat.isFile()) {
		mkdirSync(dirname(destination), { recursive: true });
		copyFileSync(source, destination);
	} else throw new Error(`unsupported Debian runtime entry: ${source}`);
}

function linuxInputs(target) {
	const arm = target.includes("arm64"),
		musl = target.endsWith("-musl");
	const arch = arm ? "arm64" : "amd64";
	const base = musl
		? `https://dl-cdn.alpinelinux.org/alpine/v3.9/main/${arm ? "aarch64" : "x86_64"}/`
		: arm
			? "https://ports.ubuntu.com/ubuntu-ports/pool/main/"
			: "https://archive.ubuntu.com/ubuntu/pool/main/";
	const inputs = JSON.parse(
		readFileSync(
			join(directory, musl ? "postgres-alpine-language-inputs.json" : "postgres-linux-language-inputs.json"),
			"utf8",
		),
	).map(([path, armHash, x64Hash]) => ({ url: base + path.replace("ARCH", arch), sha256: arm ? armHash : x64Hash }));
	return inputs;
}

export function validateRuntimeSupplement(root, target) {
	const provenance = JSON.parse(readFileSync(join(root, "supplement-provenance.json"), "utf8"));
	const expected = target.startsWith("darwin-") ? MACOS_RUNTIME_INPUTS : linuxInputs(target);
	for (const [name, input] of Object.entries(expected)) {
		if (provenance.inputs?.[name]?.url !== input.url || provenance.inputs?.[name]?.sha256 !== input.sha256)
			throw new Error(`supplement provenance mismatch: ${target} ${name}`);
	}
	if (!Array.isArray(provenance.postgresModules) || provenance.postgresModules.length === 0)
		throw new Error("supplement provenance mismatch: missing PostgreSQL modules");
}

export async function supplementLinuxRuntime(root, work, target, download) {
	const musl = target.endsWith("-musl");
	const triplet = target.includes("arm64") ? "aarch64-linux-gnu" : "x86_64-linux-gnu";
	const inputs = linuxInputs(target);
	const postgresModules = files(join(root, "lib/postgresql"))
		.filter((path) => path.endsWith(".so"))
		.map((path) => relative(root, path));
	const archives = await Promise.all(inputs.map((input) => fetchInput(input, work, download)));
	const unpack = join(work, "linux-languages"),
		payload = join(unpack, "payload");
	mkdirSync(payload, { recursive: true });
	const notices = join(root, "supplement-licenses");
	mkdirSync(notices);
	for (let i = 0; i < archives.length; i++) {
		if (musl) {
			run("tar", ["-xzf", archives[i], "-C", payload]);
			copyFileSync(join(payload, ".PKGINFO"), join(notices, `${basename(inputs[i].url)}.PKGINFO`));
		} else {
			const part = join(unpack, String(i));
			mkdirSync(part);
			run("ar", ["x", archives[i]], { cwd: part });
			const data = readdirSync(part).find((name) => /^data\.tar\.(xz|gz)$/u.test(name));
			if (!data) throw new Error("Debian runtime artifact has no data archive");
			run("tar", ["-xf", join(part, data), "-C", payload]);
		}
	}
	for (const path of ["lib", "usr/lib", "usr/share"]) {
		const source = join(payload, path);
		if (!existsSync(source)) continue;
		// Select interpreter/library payloads, not Alpine's separate terminal database
		// package. Its usr/lib/terminfo alias is not a library or a language standard library.
		if (musl && path === "usr/lib") {
			for (const name of readdirSync(source))
				if (name !== "terminfo") copyDebTree(join(source, name), join(root, "lp", path, name), payload);
		} else copyDebTree(source, join(root, "lp", path), payload);
	}
	// Only shared libraries at the distribution's public library roots are placed
	// in PostgreSQL's loader directory. Language extensions retain their layout.
	for (const path of musl
		? ["lib", "usr/lib", "usr/lib/perl5/core_perl/CORE"]
		: [`lib/${triplet}`, `usr/lib/${triplet}`]) {
		const source = join(root, "lp", path);
		if (!existsSync(source)) continue;
		for (const name of readdirSync(source))
			if (/\.so(?:\.|$)/u.test(name) && lstatSync(join(source, name)).isFile()) {
				const destination = join(root, "lib", name);
				if (existsSync(destination)) throw new Error(`Debian runtime would replace upstream library: ${name}`);
				copyFileSync(join(source, name), destination);
			}
	}
	const toolName = process.arch === "arm64" ? "aarch64" : "x86_64";
	const sourceBuild = process.platform === "darwin";
	const toolInput = {
		url: `https://github.com/NixOS/patchelf/releases/download/0.18.0/patchelf-0.18.0${sourceBuild ? "" : `-${toolName}`}.tar.gz`,
		sha256: sourceBuild
			? "64de10e4c6b8b8379db7e87f58030f336ea747c0515f381132e810dbf84a86e7"
			: process.arch === "arm64"
				? "ae13e2effe077e829be759182396b931d8f85cfb9cfe9d49385516ea367ef7b2"
				: "ce84f2447fb7a8679e58bc54a20dc2b01b37b5802e12c57eece772a6f14bf3f0",
	};
	const toolArchive = await fetchInput(toolInput, work, download);
	const toolRoot = join(unpack, "patchelf");
	mkdirSync(toolRoot);
	run("tar", ["-xzf", toolArchive, "-C", toolRoot]);
	let patcher = join(toolRoot, "bin/patchelf");
	if (sourceBuild) {
		const source = join(toolRoot, "patchelf-0.18.0");
		run("./configure", [], { cwd: source });
		run("make", ["-j2"], { cwd: source });
		patcher = join(source, "src/patchelf");
	}
	for (const path of files(root)) {
		const bytes = readFileSync(path);
		if (bytes.length < 64 || bytes.readUInt32BE(0) !== 0x7f454c46 || ![2, 3].includes(bytes.readUInt16LE(16)))
			continue;
		const rpath = relative(dirname(path), join(root, "lib"));
		const mode = lstatSync(path).mode & 0o777;
		chmodSync(path, mode | 0o200);
		try {
			run(patcher, ["--set-rpath", rpath ? `$ORIGIN/${rpath}` : "$ORIGIN", path]);
		} finally {
			chmodSync(path, mode);
		}
	}
	if (musl) await copySupplementLicenses(root, work, download, false);
	writeFileSync(
		join(root, "language-runtime.json"),
		`${JSON.stringify(
			{
				PYTHONHOME: ["lp/usr"],
				PERL5LIB: musl
					? ["lp/usr/lib/perl5/core_perl", "lp/usr/share/perl5/core_perl"]
					: [`lp/usr/lib/${triplet}/perl/5.26.1`, "lp/usr/share/perl/5.26.1"],
				TCL_LIBRARY: [musl ? "lp/usr/lib/tcl8.6" : "lp/usr/share/tcltk/tcl8.6"],
			},
			null,
			2,
		)}\n`,
	);
	writeFileSync(
		join(root, "supplement-provenance.json"),
		`${JSON.stringify(
			{
				inputs,
				toolInput,
				postgresModules,
				transformation: `ABI-compatible ${musl ? "Alpine 3.9" : "Ubuntu Bionic"} language libraries; contained regular-file aliases; per-image ORIGIN rpaths`,
				licenses: "supplement-licenses and lp/usr/share/doc/*/copyright and lp/usr/share/common-licenses",
			},
			null,
			2,
		)}\n`,
	);
}

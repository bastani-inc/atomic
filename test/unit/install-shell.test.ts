import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
	chmodSync,
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
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { spawnSyncCollect } from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
const installerPath = join(root, "install.sh");
const unixTest = process.platform === "win32" ? test.skip : test;
const systemSysctl = "/usr/sbin/sysctl";
const darwinRosettaFallbackTest =
	process.platform === "darwin" &&
	existsSync(systemSysctl) &&
	spawnSyncCollect([systemSysctl, "-in", "hw.optional.arm64"]).stdout.toString().trim() === "1"
		? test
		: test.skip;
const LARGE_RELEASE_JSON_BYTES = 42_322;
const JSON_PARSER_CPU_LIMIT_SECONDS = 4;
const JSON_PARSER_WALL_TIMEOUT_MS = 5_000;

const unixAssets = [
	"atomic-darwin-arm64.tar.gz",
	"atomic-darwin-x64.tar.gz",
	"atomic-linux-x64.tar.gz",
	"atomic-linux-arm64.tar.gz",
	"atomic-linux-x64-musl.tar.gz",
	"atomic-linux-arm64-musl.tar.gz",
] as const;

test("POSIX installer has valid sh syntax and declares the archive install contract", () => {
	if (process.platform !== "win32") {
		const syntax = spawnSyncCollect(["sh", "-n", installerPath]);
		assert.equal(syntax.exitCode, 0, syntax.stderr.toString());
	}

	const source = readFileSync(installerPath, "utf8");
	assert.ok(source.startsWith("#!/bin/sh\n"));
	for (const option of ["--ref <tag>", "--ref=<tag>", "-r <tag>", "--help"]) assert.ok(source.includes(option));
	for (const variable of ["ATOMIC_INSTALL_DIR", "ATOMIC_BIN_DIR", "ATOMIC_VERSION", "GITHUB_TOKEN", "GH_TOKEN"])
		assert.ok(source.includes(variable));
	for (const asset of unixAssets) assert.equal(source.split(asset).length - 1, 1, asset);
	for (const tool of ["curl", "wget", "sha256sum", "shasum", "openssl"])
		assert.match(source, new RegExp(`command -v ${tool}`, "u"));
	assert.match(source, /for required_command in [^\n]*\bawk\b/u);
	const shellSource = source.replace(/\| awk '\n[\s\S]*?\n {4}'/u, "| awk '<embedded POSIX awk>'");
	assert.notEqual(shellSource, source);
	assert.doesNotMatch(shellSource, /\[\[|\]\]|\b(?:local|function)\s|pipefail|\$BASH|<\(|>\(/u);
	assert.doesNotMatch(source, /\b(?:npm|pnpm|yarn|bun|node|git|jq)(?:\.exe)?\b/iu);
	assert.match(source, /sysctl -in hw\.optional\.arm64/u);
	assert.match(source, /\/usr\/sbin\/sysctl -in hw\.optional\.arm64/u);
	assert.match(source, /\/etc\/alpine-release/u);
	assert.match(source, /ldd --version/u);
	assert.match(source, /CHECKSUM_MATCHES.*-eq 1/u);
	assert.match(source, /staged atomic --version check failed/u);
	assert.match(source, /installed atomic --version check failed/u);
	assert.ok(source.indexOf("checksum verification failed") < source.indexOf('mkdir -p "$INSTALL_ROOT"'));
	assert.equal(source.match(/pwd -P/gu)?.length, 1);
	assert.match(source, /INSTALL_ROOT=\$\(normalize_absolute_path "\$INSTALL_ROOT"\)/u);
	assert.match(source, /BIN_DIR=\$\(normalize_absolute_path "\$BIN_DIR"\)/u);
	assert.match(source, /canonical_physical=\$\(CDPATH= cd -P "\$canonical_probe"[^\n]+&& pwd\)/u);
	assert.match(source, /PHYSICAL_INSTALL_ROOT=\$\(canonicalize_existing_prefix "\$INSTALL_ROOT"\)/u);
	assert.match(source, /PHYSICAL_BIN_PATH=\$\(canonicalize_existing_prefix "\$BIN_PATH"\)/u);
	assert.match(source, /\[ "\$PHYSICAL_BIN_PATH" != "\$PHYSICAL_INSTALL_ROOT" \]/u);
	assert.match(source, /\*:"\$BIN_DIR":\*\) ;;/u);
	assert.match(source, /REQUESTED_REF_ENCODED=\$\(percent_encode "\$REQUESTED_REF"\)/u);
	assert.match(source, /RELEASE_TAG_ENCODED=\$\(percent_encode "\$RELEASE_TAG"\)/u);
	assert.match(source, /percent_decode "\$resolved_url_tag"/u);
	assert.match(source, /VERSION_PATH=\$VERSIONS_DIR\/\$RELEASE_TAG_ENCODED/u);
	assert.match(source, /ln -s "versions\/\$RELEASE_TAG_ENCODED"/u);
	assert.ok(source.indexOf("ATOMIC_INSTALL_DIR conflicts") < source.indexOf("for required_command"));
});

function resolveExecutable(name: string): string {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		if (existsSync(candidate)) return realpathSync(candidate);
	}
	throw new Error(`Required fixture command not found: ${name}`);
}

interface FixtureRelease {
	tag: string;
	encodedTag: string;
	assets: Map<string, string>;
	checksums: string;
}

interface InstallerFixture {
	workspace: string;
	home: string;
	tempRoot: string;
	installRoot: string;
	binDir: string;
	requestLog: string;
	tools: string;
	releases: Map<string, FixtureRelease>;
	cleanup(): void;
	run(options?: RunOptions): ReturnType<typeof spawnSyncCollect>;
}

interface RunOptions {
	args?: readonly string[];
	downloader?: "curl" | "wget";
	os?: string;
	arch?: string;
	arm64Sysctl?: string;
	libc?: string;
	sysctl?: boolean;
	cpuLimitSeconds?: number;
	timeout?: number;
	ldd?: boolean;
	environment?: Record<string, string | undefined>;
	pathEntries?: readonly string[];
}

function writeExecutable(path: string, source: string): void {
	writeFileSync(path, source);
	chmodSync(path, 0o755);
}

function createArchive(workspace: string, tag: string, asset: string): { path: string; checksum: string } {
	const encodedTag = encodeURIComponent(tag);
	const sourceRoot = join(workspace, `payload-${encodedTag}-${asset}`);
	const payload = join(sourceRoot, "atomic");
	mkdirSync(join(payload, "builtin"), { recursive: true });
	mkdirSync(join(payload, "node_modules", "fixture"), { recursive: true });
	writeExecutable(
		join(payload, "atomic"),
		`#!/bin/sh\nversion='${tag}'\nif [ "\${ATOMIC_FIXTURE_FAIL_STAGED_VERSION:-}" = "$version" ]; then exit 17; fi\ncase "$0" in\n  *atomic-install.*) ;;\n  *) if [ "\${ATOMIC_FIXTURE_FAIL_FINAL_VERSION:-}" = "$version" ]; then exit 23; fi ;;\nesac\nif [ "\${1:-}" = --version ]; then printf '%s\\n' "$version"; exit 0; fi\nprintf '%s\\n' "$version:$*"\n`,
	);
	writeFileSync(join(payload, "package.json"), JSON.stringify({ name: "@bastani/atomic", version: tag }));
	writeFileSync(join(payload, "app.js"), `fixture-${tag}`);
	writeFileSync(join(payload, "builtin", "payload.txt"), `builtin-${tag}`);
	writeFileSync(join(payload, "node_modules", "fixture", "payload.txt"), `modules-${tag}`);
	writeFileSync(join(payload, "asset.txt"), asset);

	const archive = join(workspace, `${encodedTag}-${asset}`);
	const result = spawnSyncCollect([resolveExecutable("tar"), "-czf", archive, "-C", sourceRoot, "atomic"]);
	assert.equal(result.exitCode, 0, result.stderr.toString());
	const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
	rmSync(sourceRoot, { recursive: true, force: true });
	return { path: archive, checksum };
}

function addRelease(fixture: InstallerFixture, tag: string): FixtureRelease {
	const assets = new Map<string, string>();
	const rows: string[] = [];
	for (const asset of unixAssets) {
		const archive = createArchive(fixture.workspace, tag, asset);
		assets.set(asset, archive.path);
		rows.push(`${archive.checksum}  ${asset}`);
	}
	const release = { tag, encodedTag: encodeURIComponent(tag), assets, checksums: `${rows.join("\n")}\n` };
	fixture.releases.set(tag, release);
	return release;
}

function shellExpansion(expression: string): string {
	return ["$", `{${expression}}`].join("");
}

const curlWrapper = [
	"#!/bin/sh",
	"output=",
	"url=",
	'while [ "$#" -gt 0 ]; do',
	"    case $1 in",
	"        -o) shift; output=$1 ;;",
	"        -w) shift ;;",
	`        -H) shift; printf 'HEADER %s\\n' "$1" >> "$ATOMIC_FIXTURE_LOG" ;;`,
	"        -*) ;;",
	"        *) url=$1 ;;",
	"    esac",
	"    shift",
	"done",
	`printf 'GET %s\\n' "$url" >> "$ATOMIC_FIXTURE_LOG"`,
	"case $url in",
	"    https://github.com/bastani-inc/atomic/releases/latest)",
	`        [ "${shellExpansion("ATOMIC_FIXTURE_REDIRECT_FAIL:-0")}" = 1 ] && exit 22`,
	`        printf 'https://github.com/bastani-inc/atomic/releases/tag/%s' "$ATOMIC_FIXTURE_LATEST_TAG"`,
	"        ;;",
	"    https://api.github.com/repos/bastani-inc/atomic/releases/latest)",
	`        [ "${shellExpansion("ATOMIC_FIXTURE_FAIL_API:-0")}" = 1 ] && exit 22`,
	`        printf '{"tag_name":"%s"}\\n' "$ATOMIC_FIXTURE_LATEST_TAG"`,
	"        ;;",
	"    https://api.github.com/repos/bastani-inc/atomic/releases/tags/*)",
	`        [ "${shellExpansion("ATOMIC_FIXTURE_FAIL_API:-0")}" = 1 ] && exit 22`,
	`        tag=${shellExpansion("url##*/")}`,
	"        case $tag in",
	"            release%2F1.0) canonical='release/1.0' ;;",
	"            hash%23tag) canonical='hash#tag' ;;",
	"            percent%25tag) canonical='percent%tag' ;;",
	`            *) canonical=${shellExpansion("ATOMIC_FIXTURE_CANONICAL_TAG:-$tag")} ;;`,
	"        esac",
	`        if [ "${shellExpansion("ATOMIC_FIXTURE_RELEASE_JSON+x")}" = x ]; then`,
	`            printf '%s\\n' "$ATOMIC_FIXTURE_RELEASE_JSON"`,
	"        else",
	`            printf '{"tag_name":"%s"}\\n' "$canonical"`,
	"        fi",
	"        ;;",
	"    https://github.com/bastani-inc/atomic/releases/download/*/*)",
	`        name=${shellExpansion("url##*/")}`,
	`        rest=${shellExpansion("url%/*")}`,
	`        tag=${shellExpansion("rest##*/")}`,
	`        [ "${shellExpansion("ATOMIC_FIXTURE_FAIL_FILE:-")}" = "$name" ] && exit 22`,
	`        /bin/cp "$ATOMIC_FIXTURE_RELEASES/$tag/$name" "$output"`,
	"        ;;",
	"    *) exit 22 ;;",
	"esac",
].join("\n");

const wgetWrapper = [
	"#!/bin/sh",
	"output=",
	"spider=0",
	"url=",
	'while [ "$#" -gt 0 ]; do',
	"    case $1 in",
	"        -O) shift; output=$1 ;;",
	"        --spider) spider=1 ;;",
	`        --header=*) printf 'HEADER %s\\n' "${shellExpansion("1#--header=")}" >> "$ATOMIC_FIXTURE_LOG" ;;`,
	"        -*) ;;",
	"        *) url=$1 ;;",
	"    esac",
	"    shift",
	"done",
	`printf 'GET %s\\n' "$url" >> "$ATOMIC_FIXTURE_LOG"`,
	"case $url in",
	"    https://github.com/bastani-inc/atomic/releases/latest)",
	'        [ "$spider" = 1 ] || exit 1',
	`        [ "${shellExpansion("ATOMIC_FIXTURE_REDIRECT_FAIL:-0")}" = 1 ] && exit 1`,
	`        printf '  Location: https://github.com/bastani-inc/atomic/releases/tag/%s [following]\\n' "$ATOMIC_FIXTURE_LATEST_TAG" >&2`,
	"        ;;",
	"    https://api.github.com/repos/bastani-inc/atomic/releases/latest)",
	`        [ "${shellExpansion("ATOMIC_FIXTURE_FAIL_API:-0")}" = 1 ] && exit 1`,
	`        printf '{"tag_name":"%s"}\\n' "$ATOMIC_FIXTURE_LATEST_TAG"`,
	"        ;;",
	"    https://api.github.com/repos/bastani-inc/atomic/releases/tags/*)",
	`        [ "${shellExpansion("ATOMIC_FIXTURE_FAIL_API:-0")}" = 1 ] && exit 1`,
	`        tag=${shellExpansion("url##*/")}`,
	"        case $tag in",
	"            release%2F1.0) canonical='release/1.0' ;;",
	"            hash%23tag) canonical='hash#tag' ;;",
	"            percent%25tag) canonical='percent%tag' ;;",
	`            *) canonical=${shellExpansion("ATOMIC_FIXTURE_CANONICAL_TAG:-$tag")} ;;`,
	"        esac",
	`        if [ "${shellExpansion("ATOMIC_FIXTURE_RELEASE_JSON+x")}" = x ]; then`,
	`            printf '%s\\n' "$ATOMIC_FIXTURE_RELEASE_JSON"`,
	"        else",
	`            printf '{"tag_name":"%s"}\\n' "$canonical"`,
	"        fi",
	"        ;;",
	"    https://github.com/bastani-inc/atomic/releases/download/*/*)",
	`        name=${shellExpansion("url##*/")}`,
	`        rest=${shellExpansion("url%/*")}`,
	`        tag=${shellExpansion("rest##*/")}`,
	`        [ "${shellExpansion("ATOMIC_FIXTURE_FAIL_FILE:-")}" = "$name" ] && exit 1`,
	`        /bin/cp "$ATOMIC_FIXTURE_RELEASES/$tag/$name" "$output"`,
	"        ;;",
	"    *) exit 1 ;;",
	"esac",
].join("\n");

function createFixture(): InstallerFixture {
	const workspace = mkdtempSync(join(tmpdir(), "atomic-sh-installer-"));
	const home = join(workspace, "home");
	const tempRoot = join(workspace, "tmp");
	const installRoot = join(workspace, "install root");
	const binDir = join(workspace, "bin root");
	const requestLog = join(workspace, "requests.log");
	const tools = join(workspace, "tools");
	const releasesRoot = join(workspace, "releases");
	mkdirSync(home);
	mkdirSync(tempRoot);
	mkdirSync(tools);
	mkdirSync(releasesRoot);
	writeFileSync(requestLog, "");

	for (const command of ["awk", "tar", "mkdir", "chmod", "ln", "rm", "rmdir", "cat", "gzip"]) {
		const source = resolveExecutable(command);
		symlinkSync(source, join(tools, command));
	}
	writeExecutable(
		join(tools, "mv"),
		[
			"#!/bin/sh",
			'"$ATOMIC_FIXTURE_REAL_MV" "$@" || exit $?',
			`case "${shellExpansion("ATOMIC_FIXTURE_SIGNAL_AFTER_MOVE:-")}:$2" in`,
			"    version-backup:*/versions/.backup-*|version-install:*/versions/[!.]*|current-backup:*/.current-backup-*|current-install:*/current|bin-backup:*/.atomic-backup-*|bin-install:*/atomic)",
			'        if [ ! -e "$ATOMIC_FIXTURE_SIGNAL_MARKER" ]; then',
			'            : > "$ATOMIC_FIXTURE_SIGNAL_MARKER"',
			`            kill -"${shellExpansion("ATOMIC_FIXTURE_SIGNAL:-TERM")}" "$PPID"`,
			"        fi",
			"        ;;",
			"esac",
		].join("\n"),
	);
	let checksumCommand: "sha256sum" | "shasum";
	try {
		checksumCommand = "sha256sum";
		symlinkSync(resolveExecutable(checksumCommand), join(tools, checksumCommand));
	} catch {
		checksumCommand = "shasum";
		symlinkSync(resolveExecutable(checksumCommand), join(tools, checksumCommand));
	}
	assert.ok(checksumCommand);

	writeExecutable(
		join(tools, "uname"),
		'#!/bin/sh\ncase "$1" in -s) printf \'%s\\n\' "$ATOMIC_FIXTURE_OS" ;; -m) printf \'%s\\n\' "$ATOMIC_FIXTURE_ARCH" ;; *) exit 1 ;; esac\n',
	);
	writeExecutable(
		join(tools, "sysctl"),
		`#!/bin/sh\nprintf '%s\\n' "${shellExpansion("ATOMIC_FIXTURE_ARM64_SYSCTL:-0")}"\n`,
	);
	writeExecutable(join(tools, "ldd"), `#!/bin/sh\nprintf '%s\\n' "${shellExpansion("ATOMIC_FIXTURE_LIBC:-glibc")}"\n`);
	writeExecutable(join(tools, "curl"), curlWrapper);
	writeExecutable(join(tools, "wget"), wgetWrapper);

	const releases = new Map<string, FixtureRelease>();
	const fixture: InstallerFixture = {
		workspace,
		home,
		tempRoot,
		installRoot,
		binDir,
		requestLog,
		tools,
		releases,
		cleanup: () => rmSync(workspace, { recursive: true, force: true }),
		run: (options = {}) => {
			const downloader = options.downloader ?? "curl";
			const runTools = join(workspace, `tools-${downloader}-${Math.random().toString(16).slice(2)}`);
			mkdirSync(runTools);
			for (const entry of readdirSync(tools)) {
				if ((entry === "curl" || entry === "wget") && entry !== downloader) continue;
				if (entry === "ldd" && options.ldd === false) continue;
				if (entry === "sysctl" && options.sysctl === false) continue;
				symlinkSync(realpathSync(join(tools, entry)), join(runTools, entry));
			}
			for (const release of releases.values()) {
				const releaseDir = join(releasesRoot, release.encodedTag);
				rmSync(releaseDir, { recursive: true, force: true });
				mkdirSync(releaseDir, { recursive: true });
				for (const [asset, archive] of release.assets) symlinkSync(archive, join(releaseDir, asset));
				writeFileSync(join(releaseDir, "SHA256SUMS"), release.checksums);
			}
			const env: Record<string, string | undefined> = {
				...process.env,
				PATH: [...(options.pathEntries ?? []), runTools].join(delimiter),
				HOME: home,
				TMPDIR: tempRoot,
				ATOMIC_INSTALL_DIR: installRoot,
				ATOMIC_BIN_DIR: binDir,
				ATOMIC_VERSION: undefined,
				GITHUB_TOKEN: undefined,
				GH_TOKEN: undefined,
				ATOMIC_FIXTURE_LOG: requestLog,
				ATOMIC_FIXTURE_RELEASES: releasesRoot,
				ATOMIC_FIXTURE_REAL_MV: resolveExecutable("mv"),
				ATOMIC_FIXTURE_SIGNAL_MARKER: join(runTools, "signal-sent"),
				ATOMIC_FIXTURE_LATEST_TAG: "2.0.0",
				ATOMIC_FIXTURE_OS: options.os ?? "Linux",
				ATOMIC_FIXTURE_ARCH: options.arch ?? "x86_64",
				ATOMIC_FIXTURE_ARM64_SYSCTL: options.arm64Sysctl ?? "0",
				ATOMIC_FIXTURE_LIBC: options.libc ?? "ldd (GNU libc) 2.36",
				...options.environment,
			};
			const installerCommand = ["/bin/sh", installerPath, ...(options.args ?? [])];
			const command =
				options.cpuLimitSeconds === undefined
					? installerCommand
					: [
							"/bin/sh",
							"-c",
							'ulimit -t "$1"; shift; exec "$@"',
							"atomic-installer-timeout",
							String(options.cpuLimitSeconds),
							...installerCommand,
						];
			return spawnSyncCollect(command, {
				cwd: workspace,
				env,
				timeout: options.timeout ?? 15_000,
			});
		},
	};
	addRelease(fixture, "1.0.0");
	addRelease(fixture, "2.0.0");
	return fixture;
}

function output(result: ReturnType<typeof spawnSyncCollect>): string {
	return `${result.stdout.toString()}${result.stderr.toString()}`;
}

function assertSuccess(result: ReturnType<typeof spawnSyncCollect>): void {
	assert.equal(result.exitCode, 0, output(result));
}

function currentVersion(fixture: InstallerFixture): string {
	return basename(realpathSync(join(fixture.installRoot, "current")));
}

function assertNoTemporaryState(fixture: InstallerFixture): void {
	assert.deepEqual(readdirSync(fixture.tempRoot), []);
	if (existsSync(join(fixture.installRoot, "versions"))) {
		assert.equal(
			readdirSync(join(fixture.installRoot, "versions")).filter(
				(name) => name.startsWith(".stage-") || name.startsWith(".backup-"),
			).length,
			0,
		);
	}
	if (existsSync(fixture.installRoot)) {
		assert.equal(readdirSync(fixture.installRoot).filter((name) => name.startsWith(".current-")).length, 0);
	}
	if (existsSync(fixture.binDir)) {
		assert.equal(readdirSync(fixture.binDir).filter((name) => name.startsWith(".atomic-")).length, 0);
	}
}

unixTest("shell installer follows the stable redirect, installs the full tar payload, and prints a PATH hint", () => {
	const fixture = createFixture();
	try {
		const result = fixture.run({ environment: { ATOMIC_FIXTURE_FAIL_API: "1" } });
		assertSuccess(result);
		assert.equal(currentVersion(fixture), "2.0.0");
		assert.ok(lstatSync(join(fixture.installRoot, "current")).isSymbolicLink());
		assert.ok(lstatSync(join(fixture.binDir, "atomic")).isSymbolicLink());
		for (const path of [
			"atomic",
			"package.json",
			"app.js",
			"builtin/payload.txt",
			"node_modules/fixture/payload.txt",
		]) {
			assert.ok(existsSync(join(fixture.installRoot, "versions", "2.0.0", path)), path);
		}
		const installed = spawnSyncCollect([join(fixture.binDir, "atomic"), "--version"], {
			env: { PATH: fixture.tools },
		});
		assert.equal(installed.exitCode, 0, installed.stderr.toString());
		assert.equal(installed.stdout.toString().trim(), "2.0.0");
		assert.match(result.stdout.toString(), /export PATH=".*bin root:\$PATH"/u);
		const requests = readFileSync(fixture.requestLog, "utf8");
		assert.match(requests, /GET https:\/\/github\.com\/bastani-inc\/atomic\/releases\/latest/u);
		assert.doesNotMatch(requests, /api\.github\.com/u);
		assert.match(requests, /atomic-linux-x64\.tar\.gz/u);
		assert.match(requests, /SHA256SUMS/u);
		assertNoTemporaryState(fixture);
	} finally {
		fixture.cleanup();
	}
});

unixTest("shell installer supports curl and wget fallback, API fallback, every ref form, and token precedence", () => {
	for (const downloader of ["curl", "wget"] as const) {
		const fixture = createFixture();
		try {
			assertSuccess(
				fixture.run({
					downloader,
					environment: { ATOMIC_FIXTURE_REDIRECT_FAIL: "1", GITHUB_TOKEN: "github-token", GH_TOKEN: "gh-token" },
				}),
			);
			assert.match(
				readFileSync(fixture.requestLog, "utf8"),
				/GET https:\/\/api\.github\.com\/repos\/bastani-inc\/atomic\/releases\/latest/u,
			);
			assert.match(readFileSync(fixture.requestLog, "utf8"), /HEADER Authorization: Bearer github-token/u);
		} finally {
			fixture.cleanup();
		}
	}

	for (const args of [["--ref", "1.0.0"], ["--ref=1.0.0"], ["-r", "1.0.0"]]) {
		const fixture = createFixture();
		try {
			assertSuccess(fixture.run({ args, environment: { ATOMIC_VERSION: "2.0.0", GH_TOKEN: "gh-token" } }));
			assert.equal(currentVersion(fixture), "1.0.0");
			const requests = readFileSync(fixture.requestLog, "utf8");
			assert.match(requests, /releases\/tags\/1\.0\.0/u);
			assert.doesNotMatch(requests, /releases\/tags\/2\.0\.0/u);
			assert.match(requests, /HEADER Authorization: Bearer gh-token/u);
		} finally {
			fixture.cleanup();
		}
	}

	const fixture = createFixture();
	try {
		assertSuccess(fixture.run({ environment: { ATOMIC_VERSION: "1.0.0" } }));
		assert.equal(currentVersion(fixture), "1.0.0");
	} finally {
		fixture.cleanup();
	}

	const canonicalFixture = createFixture();
	try {
		assertSuccess(
			canonicalFixture.run({
				args: ["--ref", "requested-alias"],
				environment: { ATOMIC_FIXTURE_CANONICAL_TAG: "1.0.0" },
			}),
		);
		assert.equal(currentVersion(canonicalFixture), "1.0.0");
		const canonicalRequests = readFileSync(canonicalFixture.requestLog, "utf8");
		assert.match(canonicalRequests, /releases\/tags\/requested-alias/u);
		assert.match(canonicalRequests, /releases\/download\/1\.0\.0/u);
	} finally {
		canonicalFixture.cleanup();
	}
});

unixTest("shell installer resolves relative install and bin roots against one physical working directory", () => {
	const fixture = createFixture();
	try {
		const relativeBin = "relative bin";
		const absoluteBin = join(realpathSync(fixture.workspace), relativeBin);
		const result = fixture.run({
			args: ["--ref", "1.0.0"],
			environment: { ATOMIC_INSTALL_DIR: "install root", ATOMIC_BIN_DIR: relativeBin },
		});
		assertSuccess(result);
		assert.equal(currentVersion(fixture), "1.0.0");
		const binTarget = readlinkSync(join(absoluteBin, "atomic"));
		assert.ok(binTarget.startsWith("/"), `bin target is not absolute: ${binTarget}`);
		assert.equal(
			realpathSync(join(absoluteBin, "atomic")),
			realpathSync(join(fixture.installRoot, "current", "atomic")),
		);
		assert.ok(result.stdout.toString().includes(`export PATH="${absoluteBin}:$PATH"`));

		const otherDirectory = join(fixture.workspace, "other working directory");
		mkdirSync(otherDirectory);
		const installed = spawnSyncCollect(["/bin/sh", "-c", "command -v atomic && atomic --version"], {
			cwd: otherDirectory,
			env: { PATH: `${absoluteBin}${delimiter}${fixture.tools}` },
		});
		assert.equal(installed.exitCode, 0, installed.stderr.toString());
		assert.equal(installed.stdout.toString().trim(), `${join(absoluteBin, "atomic")}\n1.0.0`);
		assertNoTemporaryState(fixture);
	} finally {
		fixture.cleanup();
	}
});

unixTest("shell installer compares metacharacters in PATH entries literally", () => {
	const fixture = createFixture();
	try {
		const relativeBin = "literal[7]*? bin";
		const absoluteBin = join(realpathSync(fixture.workspace), relativeBin);
		const nearMatch = join(realpathSync(fixture.workspace), "literal7-many-q bin");
		const first = fixture.run({
			args: ["--ref", "1.0.0"],
			pathEntries: [nearMatch],
			environment: { ATOMIC_BIN_DIR: relativeBin },
		});
		assertSuccess(first);
		assert.ok(first.stdout.toString().includes(`export PATH="${absoluteBin}:$PATH"`));

		const second = fixture.run({
			args: ["--ref", "1.0.0"],
			pathEntries: [absoluteBin],
			environment: { ATOMIC_BIN_DIR: relativeBin },
		});
		assertSuccess(second);
		assert.doesNotMatch(second.stdout.toString(), /Add Atomic to PATH|export PATH=/u);

		const otherDirectory = join(fixture.workspace, "path literal other cwd");
		mkdirSync(otherDirectory);
		const installed = spawnSyncCollect(["/bin/sh", "-c", "command -v atomic && atomic --version"], {
			cwd: otherDirectory,
			env: { PATH: `${absoluteBin}${delimiter}${fixture.tools}` },
		});
		assert.equal(installed.exitCode, 0, installed.stderr.toString());
		assert.equal(installed.stdout.toString().trim(), `${join(absoluteBin, "atomic")}\n1.0.0`);
		assertNoTemporaryState(fixture);
	} finally {
		fixture.cleanup();
	}
});

unixTest("shell installer percent-encodes exact refs once for API, downloads, and version directories", () => {
	for (const downloader of ["curl", "wget"] as const) {
		for (const tag of ["release/1.0", "hash#tag", "percent%tag"] as const) {
			const fixture = createFixture();
			try {
				addRelease(fixture, tag);
				const encodedTag = encodeURIComponent(tag);
				const result = fixture.run({ downloader, args: ["--ref", tag] });
				assertSuccess(result);
				assert.ok(existsSync(join(fixture.installRoot, "versions", encodedTag, "atomic")));
				assert.equal(readlinkSync(join(fixture.installRoot, "current")), `versions/${encodedTag}`);
				assert.match(
					result.stdout.toString(),
					new RegExp(`Atomic ${tag.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")} installed`, "u"),
				);
				const requests = readFileSync(fixture.requestLog, "utf8");
				assert.match(
					requests,
					new RegExp(`GET https://api\\.github\\.com/repos/bastani-inc/atomic/releases/tags/${encodedTag}`, "u"),
				);
				assert.match(
					requests,
					new RegExp(
						`GET https://github\\.com/bastani-inc/atomic/releases/download/${encodedTag}/atomic-linux-x64\\.tar\\.gz`,
						"u",
					),
				);
				assert.match(
					requests,
					new RegExp(
						`GET https://github\\.com/bastani-inc/atomic/releases/download/${encodedTag}/SHA256SUMS`,
						"u",
					),
				);
				const installed = spawnSyncCollect([join(fixture.binDir, "atomic"), "--version"], {
					env: { PATH: fixture.tools },
				});
				assert.equal(installed.exitCode, 0, installed.stderr.toString());
				assert.equal(installed.stdout.toString().trim(), tag);
				assertNoTemporaryState(fixture);
			} finally {
				fixture.cleanup();
			}
		}
	}

	const redirectFixture = createFixture();
	try {
		const rawTag = "release/1.0";
		const encodedTag = encodeURIComponent(rawTag);
		addRelease(redirectFixture, rawTag);
		const result = redirectFixture.run({
			downloader: "curl",
			environment: { ATOMIC_FIXTURE_LATEST_TAG: encodedTag, ATOMIC_FIXTURE_FAIL_API: "1" },
		});
		assertSuccess(result);
		assert.ok(existsSync(join(redirectFixture.installRoot, "versions", encodedTag, "atomic")));
		assert.match(result.stdout.toString(), /Atomic release\/1\.0 installed/u);
		const requests = readFileSync(redirectFixture.requestLog, "utf8");
		assert.doesNotMatch(requests, /api\.github\.com|release%252F1\.0/u);
		assert.match(requests, /releases\/download\/release%2F1\.0\/atomic-linux-x64\.tar\.gz/u);
	} finally {
		redirectFixture.cleanup();
	}
});

unixTest("shell installer parses a 42,322-byte escaped release response within five seconds", () => {
	const rawTag = 'release/🚀"v1';
	const encodedTag = encodeURIComponent(rawTag);
	const releaseJsonPrefix = String.raw`{"url":"${"x".repeat(512)}","assets_url":"${"x".repeat(512)}","upload_url":"${"x".repeat(512)}","html_url":"${"x".repeat(512)}","id":1,"author":{"login":"tag_name","nested":[{"quoted":"\"tag_name\"","bio":"${"x".repeat(512)}"}]},"node_id":"${"x".repeat(512)}","name":"decoy \"tag_name\":\"wrong\"","tag_name":"\u0072elease\/\uD83D\uDE80\"v1","body":"`;
	const releaseJsonSuffix = '"}';
	const paddingBytes = LARGE_RELEASE_JSON_BYTES - Buffer.byteLength(releaseJsonPrefix + releaseJsonSuffix);
	assert.ok(paddingBytes > 0);
	const releaseJson = releaseJsonPrefix + "x".repeat(paddingBytes) + releaseJsonSuffix;
	assert.equal(Buffer.byteLength(releaseJson), LARGE_RELEASE_JSON_BYTES);

	for (const downloader of ["curl", "wget"] as const) {
		const fixture = createFixture();
		try {
			addRelease(fixture, rawTag);
			const result = fixture.run({
				downloader,
				args: ["--ref", "requested-alias"],
				cpuLimitSeconds: JSON_PARSER_CPU_LIMIT_SECONDS,
				timeout: JSON_PARSER_WALL_TIMEOUT_MS,
				environment: { ATOMIC_FIXTURE_RELEASE_JSON: releaseJson },
			});
			assertSuccess(result);
			assert.ok(existsSync(join(fixture.installRoot, "versions", encodedTag, "atomic")));
			assert.equal(readlinkSync(join(fixture.installRoot, "current")), `versions/${encodedTag}`);
			assert.ok(result.stdout.toString().includes(`Atomic ${rawTag} installed successfully.`));
			const requests = readFileSync(fixture.requestLog, "utf8");
			assert.match(requests, /releases\/tags\/requested-alias/u);
			assert.ok(requests.includes(`/releases/download/${encodedTag}/atomic-linux-x64.tar.gz`));
			assert.doesNotMatch(requests, /%255Cu0072|%255C%2F|%2522/u);
			const installed = spawnSyncCollect([join(fixture.binDir, "atomic"), "--version"], {
				env: { PATH: fixture.tools },
			});
			assert.equal(installed.exitCode, 0, installed.stderr.toString());
			assert.equal(installed.stdout.toString().trim(), rawTag);
			assertNoTemporaryState(fixture);
		} finally {
			fixture.cleanup();
		}
	}
});

unixTest("shell installer rejects only the impossible install-root and launcher-path equality before requests", () => {
	for (const paths of [
		{ install: "collision/atomic", bin: "collision" },
		{ install: "collision/./atomic", bin: "collision/nested/.." },
	]) {
		const fixture = createFixture();
		try {
			const result = fixture.run({
				args: ["--ref", "1.0.0"],
				environment: { ATOMIC_INSTALL_DIR: paths.install, ATOMIC_BIN_DIR: paths.bin },
			});
			assert.notEqual(result.exitCode, 0);
			assert.match(output(result), /ATOMIC_INSTALL_DIR conflicts with ATOMIC_BIN_DIR\/atomic/u);
			assert.equal(readFileSync(fixture.requestLog, "utf8"), "");
			assert.deepEqual(readdirSync(fixture.tempRoot), []);
			assert.ok(!existsSync(join(fixture.workspace, "collision")));
		} finally {
			fixture.cleanup();
		}
	}

	const fixture = createFixture();
	try {
		const installRoot = "collision/atomic";
		assertSuccess(
			fixture.run({
				args: ["--ref", "1.0.0"],
				environment: { ATOMIC_INSTALL_DIR: installRoot, ATOMIC_BIN_DIR: "working-bin" },
			}),
		);
		const absoluteInstallRoot = join(fixture.workspace, installRoot);
		writeFileSync(join(absoluteInstallRoot, "versions", "1.0.0", "preserve.txt"), "old-state");
		writeFileSync(fixture.requestLog, "");
		const rejected = fixture.run({
			args: ["--ref", "2.0.0"],
			environment: { ATOMIC_INSTALL_DIR: "collision/./atomic", ATOMIC_BIN_DIR: "collision/nested/.." },
		});
		assert.notEqual(rejected.exitCode, 0);
		assert.match(output(rejected), /ATOMIC_INSTALL_DIR conflicts with ATOMIC_BIN_DIR\/atomic/u);
		assert.equal(readFileSync(fixture.requestLog, "utf8"), "");
		assert.equal(readFileSync(join(absoluteInstallRoot, "versions", "1.0.0", "preserve.txt"), "utf8"), "old-state");
		assert.equal(basename(realpathSync(join(absoluteInstallRoot, "current"))), "1.0.0");
		const oldLauncher = spawnSyncCollect([join(fixture.workspace, "working-bin", "atomic"), "--version"], {
			env: { PATH: fixture.tools },
		});
		assert.equal(oldLauncher.exitCode, 0, oldLauncher.stderr.toString());
		assert.equal(oldLauncher.stdout.toString().trim(), "1.0.0");
		assert.deepEqual(readdirSync(fixture.tempRoot), []);
	} finally {
		fixture.cleanup();
	}
});

unixTest("shell installer resolves symlink aliases before collision preflight without mutation", () => {
	for (const existing of [false, true]) {
		const fixture = createFixture();
		try {
			const physicalParent = join(
				realpathSync(fixture.workspace),
				`physical collision ${existing ? "existing" : "fresh"}`,
			);
			const installRoot = join(physicalParent, "atomic");
			const binAlias = join(realpathSync(fixture.workspace), `bin alias ${existing ? "existing" : "fresh"}`);
			const workingBin = join(realpathSync(fixture.workspace), "working collision bin");
			mkdirSync(physicalParent);
			writeFileSync(join(physicalParent, "parent-marker.txt"), "keep-parent");
			symlinkSync(physicalParent, binAlias);

			if (existing) {
				assertSuccess(
					fixture.run({
						args: ["--ref", "1.0.0"],
						environment: { ATOMIC_INSTALL_DIR: installRoot, ATOMIC_BIN_DIR: workingBin },
					}),
				);
				writeFileSync(join(installRoot, "versions", "1.0.0", "preserve.txt"), "old-state");
				writeFileSync(fixture.requestLog, "");
			}

			const beforeParentEntries = readdirSync(physicalParent).sort();
			const rejected = fixture.run({
				args: ["--ref", "2.0.0"],
				environment: {
					ATOMIC_INSTALL_DIR: join(physicalParent, ".", "missing", "..", "atomic"),
					ATOMIC_BIN_DIR: join(binAlias, ".", "missing", ".."),
				},
			});
			assert.notEqual(rejected.exitCode, 0);
			assert.match(output(rejected), /ATOMIC_INSTALL_DIR conflicts with ATOMIC_BIN_DIR\/atomic/u);
			assert.equal(readFileSync(fixture.requestLog, "utf8"), "");
			assert.deepEqual(readdirSync(fixture.tempRoot), []);
			assert.deepEqual(readdirSync(physicalParent).sort(), beforeParentEntries);
			assert.equal(readFileSync(join(physicalParent, "parent-marker.txt"), "utf8"), "keep-parent");
			assert.ok(lstatSync(binAlias).isSymbolicLink());

			if (existing) {
				assert.equal(readFileSync(join(installRoot, "versions", "1.0.0", "preserve.txt"), "utf8"), "old-state");
				assert.equal(basename(realpathSync(join(installRoot, "current"))), "1.0.0");
				const oldLauncher = spawnSyncCollect([join(workingBin, "atomic"), "--version"], {
					env: { PATH: fixture.tools },
				});
				assert.equal(oldLauncher.exitCode, 0, oldLauncher.stderr.toString());
				assert.equal(oldLauncher.stdout.toString().trim(), "1.0.0");
			} else {
				assert.ok(!existsSync(installRoot));
			}
		} finally {
			fixture.cleanup();
		}
	}
});

darwinRosettaFallbackTest("shell installer detects Rosetta with /usr/sbin/sysctl outside restricted PATH", () => {
	const fixture = createFixture();
	try {
		const result = fixture.run({
			args: ["--ref", "1.0.0"],
			os: "Darwin",
			arch: "x86_64",
			sysctl: false,
		});
		assertSuccess(result);
		assert.equal(
			readFileSync(join(fixture.installRoot, "current", "asset.txt"), "utf8"),
			"atomic-darwin-arm64.tar.gz",
		);
		assert.match(readFileSync(fixture.requestLog, "utf8"), /atomic-darwin-arm64\.tar\.gz$/mu);
		assertNoTemporaryState(fixture);
	} finally {
		fixture.cleanup();
	}
});
unixTest("shell installer selects every Darwin and Linux archive, including Rosetta and musl", () => {
	const cases = [
		[{ os: "Darwin", arch: "x86_64", arm64Sysctl: "1" }, "atomic-darwin-arm64.tar.gz"],
		[{ os: "Darwin", arch: "x86_64", arm64Sysctl: "0" }, "atomic-darwin-x64.tar.gz"],
		[{ os: "Linux", arch: "x86_64", libc: "ldd (GNU libc) 2.36" }, "atomic-linux-x64.tar.gz"],
		[
			{ os: "Linux", arch: "aarch64", libc: "GNU C Library stable release version 2.39" },
			"atomic-linux-arm64.tar.gz",
		],
		[{ os: "Linux", arch: "x86_64", libc: "musl libc" }, "atomic-linux-x64-musl.tar.gz"],
		[{ os: "Linux", arch: "arm64", libc: "musl libc" }, "atomic-linux-arm64-musl.tar.gz"],
	] as const;
	for (const [host, asset] of cases) {
		const fixture = createFixture();
		try {
			assertSuccess(fixture.run({ ...host, args: ["--ref", "1.0.0"] }));
			assert.equal(readFileSync(join(fixture.installRoot, "current", "asset.txt"), "utf8"), asset);
			assert.match(readFileSync(fixture.requestLog, "utf8"), new RegExp(`${asset.replaceAll(".", "\\.")}$`, "mu"));
		} finally {
			fixture.cleanup();
		}
	}
});

unixTest("shell installer rejects unsupported hosts and malformed invocations without network or install state", () => {
	for (const [options, message] of [
		[{ os: "FreeBSD" }, "unsupported operating system: FreeBSD"],
		[{ arch: "riscv64" }, "unsupported architecture: riscv64"],
		[{ libc: "uClibc 1.0.43" }, "unsupported Linux libc: uClibc"],
		[{ libc: "Android bionic libc" }, "unsupported Linux libc: bionic"],
		[{ libc: "mystery libc 9" }, "unsupported Linux libc: unknown"],
		[{ ldd: false }, "unable to identify Linux libc: ldd not found"],
		[{ environment: { ANDROID_ROOT: "/system" } }, "unsupported Linux libc: bionic"],
		[{ args: ["--ref"] }, "--ref requires a release tag"],
		[{ args: ["--ref="] }, "--ref requires a non-empty release tag"],
		[{ args: ["--unknown"] }, "unknown option: --unknown"],
	] as const) {
		const fixture = createFixture();
		try {
			const result = fixture.run(options);
			assert.notEqual(result.exitCode, 0);
			assert.match(output(result), new RegExp(message.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
			assert.equal(readFileSync(fixture.requestLog, "utf8"), "");
			assert.ok(!existsSync(fixture.installRoot));
			assertNoTemporaryState(fixture);
		} finally {
			fixture.cleanup();
		}
	}

	const fixture = createFixture();
	try {
		const help = fixture.run({ args: ["--help"] });
		assertSuccess(help);
		assert.match(help.stdout.toString(), /Usage:/u);
		assert.equal(readFileSync(fixture.requestLog, "utf8"), "");
	} finally {
		fixture.cleanup();
	}
});

unixTest("checksum and archive failures preserve an existing install and clean temporary state", () => {
	const cases = [
		"missing",
		"malformed",
		"duplicate",
		"mismatch",
		"download",
		"checksum-download",
		"extract",
		"staged-smoke",
	] as const;
	for (const failure of cases) {
		const fixture = createFixture();
		try {
			assertSuccess(fixture.run({ args: ["--ref", "1.0.0"] }));
			writeFileSync(join(fixture.installRoot, "versions", "1.0.0", "preserve.txt"), "old-state");
			const next = fixture.releases.get("2.0.0") as FixtureRelease;
			const target = "atomic-linux-x64.tar.gz";
			const targetArchive = next.assets.get(target) as string;
			const validHash = createHash("sha256").update(readFileSync(targetArchive)).digest("hex");
			let environment: Record<string, string> = {};
			switch (failure) {
				case "missing":
					next.checksums = next.checksums
						.split("\n")
						.filter((line) => !line.endsWith(target))
						.join("\n");
					break;
				case "malformed":
					next.checksums = `not-a-hash  ${target}\n`;
					break;
				case "duplicate":
					next.checksums = `${validHash}  ${target}\n${validHash}  ${target}\n`;
					break;
				case "mismatch":
					next.checksums = `${"0".repeat(64)}  ${target}\n`;
					break;
				case "download":
					environment = { ATOMIC_FIXTURE_FAIL_FILE: target };
					break;
				case "checksum-download":
					environment = { ATOMIC_FIXTURE_FAIL_FILE: "SHA256SUMS" };
					break;
				case "extract":
					writeFileSync(targetArchive, "not a tar archive");
					next.checksums = `${createHash("sha256").update("not a tar archive").digest("hex")}  ${target}\n`;
					break;
				case "staged-smoke":
					environment = { ATOMIC_FIXTURE_FAIL_STAGED_VERSION: "2.0.0" };
					break;
			}
			const result = fixture.run({ args: ["--ref", "2.0.0"], environment });
			assert.notEqual(result.exitCode, 0, `${failure} unexpectedly passed`);
			assert.equal(currentVersion(fixture), "1.0.0", failure);
			assert.equal(
				readFileSync(join(fixture.installRoot, "versions", "1.0.0", "preserve.txt"), "utf8"),
				"old-state",
			);
			assert.ok(!existsSync(join(fixture.installRoot, "versions", "2.0.0")));
			assertNoTemporaryState(fixture);
		} finally {
			fixture.cleanup();
		}
	}
});

unixTest("same-version reinstall and upgrade are clean, idempotent, and roll back a final launcher failure", () => {
	const fixture = createFixture();
	try {
		assertSuccess(fixture.run({ args: ["--ref", "1.0.0"] }));
		const versionOne = join(fixture.installRoot, "versions", "1.0.0");
		writeFileSync(join(versionOne, "stale.txt"), "stale");
		assertSuccess(fixture.run({ args: ["--ref", "1.0.0"] }));
		assert.ok(!existsSync(join(versionOne, "stale.txt")));
		assert.equal(currentVersion(fixture), "1.0.0");

		const failed = fixture.run({
			args: ["--ref", "2.0.0"],
			environment: { ATOMIC_FIXTURE_FAIL_FINAL_VERSION: "2.0.0" },
		});
		assert.notEqual(failed.exitCode, 0);
		assert.match(output(failed), /installed atomic --version check failed/u);
		assert.equal(currentVersion(fixture), "1.0.0");
		assert.ok(existsSync(join(versionOne, "atomic")));
		assert.ok(!existsSync(join(fixture.installRoot, "versions", "2.0.0")));

		assertSuccess(fixture.run({ args: ["--ref", "2.0.0"] }));
		assert.equal(currentVersion(fixture), "2.0.0");
		assert.ok(existsSync(join(versionOne, "atomic")), "upgrade should retain older versions");
		assertNoTemporaryState(fixture);
	} finally {
		fixture.cleanup();
	}
});

unixTest("catchable signals after transaction moves restore the complete previous install", () => {
	const cases = [
		["version-backup", "TERM"],
		["version-install", "INT"],
		["current-backup", "TERM"],
		["current-install", "INT"],
		["bin-backup", "TERM"],
		["bin-install", "INT"],
	] as const;
	for (const [move, signal] of cases) {
		const fixture = createFixture();
		try {
			assertSuccess(fixture.run({ args: ["--ref", "1.0.0"] }));
			const versionOne = join(fixture.installRoot, "versions", "1.0.0");
			writeFileSync(join(versionOne, "preserve.txt"), `${move}-${signal}`);
			const interrupted = fixture.run({
				args: ["--ref", "1.0.0"],
				environment: {
					ATOMIC_FIXTURE_SIGNAL: signal,
					ATOMIC_FIXTURE_SIGNAL_AFTER_MOVE: move,
				},
			});
			assert.notEqual(interrupted.exitCode, 0, `${move} ${signal} unexpectedly passed`);
			assert.equal(readFileSync(join(versionOne, "preserve.txt"), "utf8"), `${move}-${signal}`);
			assert.equal(currentVersion(fixture), "1.0.0");
			const installed = spawnSyncCollect([join(fixture.binDir, "atomic"), "--version"], {
				env: { PATH: fixture.tools },
			});
			assert.equal(installed.exitCode, 0, `${move} ${signal}: ${installed.stderr.toString()}`);
			assert.equal(installed.stdout.toString().trim(), "1.0.0");
			assertNoTemporaryState(fixture);
		} finally {
			fixture.cleanup();
		}
	}
});

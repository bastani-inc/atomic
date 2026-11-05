import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, vi } from "vitest";

const reads = vi.hoisted(() => ({ paths: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		readFileSync: ((path: string, ...rest: unknown[]) => {
			reads.paths.push(String(path));
			return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest);
		}) as typeof actual.readFileSync,
	};
});

import { gitInstallCommand, parseOsRelease, readOsRelease } from "../src/utils/git-install-command.ts";

const release = (text: string) => parseOsRelease(text);

describe("git install command (#4322)", () => {
	it.each([
		[
			`ID=ubuntu\nVERSION_ID="20.04"\nID_LIKE=debian`,
			"add-apt-repository ppa:git-core/ppa && apt update && apt install git",
		],
		[`ID=ubuntu\nVERSION_ID="21.10"`, "add-apt-repository ppa:git-core/ppa && apt update && apt install git"],
		[`ID=ubuntu\nVERSION_ID="22.04"\nID_LIKE=debian`, "apt-get install git"],
		[`ID=ubuntu\nVERSION_ID="24.04"`, "apt-get install git"],
		[`ID=debian\nVERSION_ID="11"`, "apt-get install git"],
		[`ID=linuxmint\nID_LIKE="ubuntu debian"\nVERSION_ID="21"`, "apt-get install git"],
		[`ID="rhel"\nID_LIKE="fedora"\nVERSION_ID="8.10"`, "dnf install git"],
		[`ID=rocky\nID_LIKE="rhel centos fedora"`, "dnf install git"],
		[`ID=fedora\nVERSION_ID=41`, "dnf install git"],
		[`ID=ol\nID_LIKE="fedora"`, "dnf install git"],
		[`ID=amzn\nVERSION_ID="2"`, "yum install git"],
		[`ID=amzn\nVERSION_ID="2023"`, "dnf install git"],
		[`ID=opensuse-leap\nID_LIKE="suse opensuse"`, "zypper install git"],
		[`ID=sles`, "zypper install git"],
		[`ID=arch`, "pacman -S git"],
		[`ID=manjaro\nID_LIKE=arch`, "pacman -S git"],
		[`ID=gentoo`, "emerge --ask --verbose dev-vcs/git"],
		[`ID=mageia`, "urpmi git"],
		[`ID=nixos`, "nix-env -i git"],
		[`ID=alpine`, "apk add git"],
		[`ID=void`, "xbps-install git"],
		[`ID=unknownos`, undefined],
	])("maps os-release %j to %s", (text, command) => {
		assert.equal(gitInstallCommand("linux", release(text)), command);
	});

	it.each([
		["darwin", "xcode-select --install"],
		["win32", "winget install --id Git.Git -e --source winget"],
		["android", "pkg install git"],
		["freebsd", "pkg install git"],
		["openbsd", "pkg_add git"],
		["sunos", "pkg install developer/versioning/git"],
		["aix", undefined],
	])("maps %s to %s without reading os-release", (platform, command) => {
		assert.equal(gitInstallCommand(platform, release("ID=ubuntu")), command);
	});

	it("treats a musl host without a known distribution as Alpine, and a known one by its own manager", () => {
		assert.equal(gitInstallCommand("linux", undefined, true), "apk add git");
		assert.equal(gitInstallCommand("linux", release("ID=unknownos"), true), "apk add git");
		assert.equal(gitInstallCommand("linux", release("ID=void"), true), "xbps-install git");
		assert.equal(gitInstallCommand("linux", undefined, false), undefined);
	});

	it("parses quoting, comments and missing fields", () => {
		assert.deepEqual(release(`# comment\nID='Debian'\nID_LIKE="a  b"\nVERSION_ID=12\nNAME="x=y"`), {
			id: "debian",
			idLike: ["a", "b"],
			versionId: "12",
		});
		assert.deepEqual(release("ID=alpine"), { id: "alpine", idLike: [] });
		assert.equal(release("NAME=nothing"), undefined);
		assert.equal(release("ID="), undefined);
		assert.equal(release(""), undefined);
	});

	it("reads the first existing file and never merges the second", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-os-release-"));
		try {
			const first = join(dir, "first");
			const second = join(dir, "second");
			writeFileSync(second, "ID=arch\n");
			assert.equal(readOsRelease([join(dir, "missing"), second])?.id, "arch");
			writeFileSync(first, "NAME=no-id\n");
			assert.equal(readOsRelease([first, second]), undefined);
			writeFileSync(first, "ID=void\n");
			assert.equal(readOsRelease([first, second])?.id, "void");
			assert.equal(readOsRelease([join(dir, "missing")]), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.skipIf(process.getuid?.() === 0)("treats an unreadable file as an unknown distribution", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-os-release-"));
		try {
			const locked = join(dir, "locked");
			const fallback = join(dir, "fallback");
			writeFileSync(locked, "ID=void\n");
			chmodSync(locked, 0o000);
			writeFileSync(fallback, "ID=arch\n");
			assert.equal(readOsRelease([locked, fallback]), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it.each([
		["opensuse", "zypper install git"],
		["opensuse-leap", "zypper install git"],
		["opensuse-tumbleweed", "zypper install git"],
		["sles", "zypper install git"],
		["suse", "zypper install git"],
		["arch", "pacman -S git"],
		["manjaro", "pacman -S git"],
		["fedora", "dnf install git"],
		["rhel", "dnf install git"],
		["centos", "dnf install git"],
		["rocky", "dnf install git"],
		["almalinux", "dnf install git"],
		["ol", "dnf install git"],
	])("recognizes %s by its own ID", (id, command) => {
		assert.equal(gitInstallCommand("linux", release(`ID=${id}`)), command);
	});

	it("applies the Ubuntu version rule at the 22 boundary", () => {
		assert.equal(gitInstallCommand("linux", release("ID=ubuntu\nVERSION_ID=22")), "apt-get install git");
		assert.equal(
			gitInstallCommand("linux", release("ID=ubuntu\nVERSION_ID=21.99")),
			"add-apt-repository ppa:git-core/ppa && apt update && apt install git",
		);
		assert.equal(gitInstallCommand("linux", release("ID=ubuntu")), "apt-get install git");
		assert.equal(gitInstallCommand("linux", release("ID=ubuntu\nVERSION_ID=rolling")), "apt-get install git");
	});

	it("takes the version rule from the distribution that names itself, not a derivative", () => {
		assert.equal(
			gitInstallCommand("linux", release('ID=pop\nID_LIKE="ubuntu debian"\nVERSION_ID="20.04"')),
			"apt-get install git",
		);
		assert.equal(
			gitInstallCommand("linux", release('ID=amznx\nID_LIKE="amzn fedora"\nVERSION_ID="2"')),
			"dnf install git",
		);
	});

	it("only unquotes a value that is quoted at both ends, and only on a line that starts with the key", () => {
		assert.equal(release('ID=ab"c"')?.id, 'ab"c"');
		assert.equal(release('ID="a"b')?.id, '"a"b');
		assert.equal(release("ID='void'")?.id, "void");
		assert.equal(release("ID=debian\n# ID=ubuntu")?.id, "debian");
		assert.equal(release("   ID=void\n")?.id, "void");
		assert.equal(release("ID= alpine")?.id, "alpine");
		assert.equal(release("ID=debian\nID_LIKE=ubuntu  ")?.idLike[0], "ubuntu");
	});

	it("reads the default files once per process and never serves them for other paths", () => {
		const dir = mkdtempSync(join(tmpdir(), "atomic-os-release-cache-"));
		try {
			const custom = join(dir, "custom");
			writeFileSync(custom, "ID=void\n");
			const first = readOsRelease();
			const afterFirst = reads.paths.length;
			const second = readOsRelease();
			assert.deepEqual(second, first);
			assert.equal(reads.paths.length, afterFirst);

			assert.equal(readOsRelease([custom])?.id, "void");
			writeFileSync(custom, "ID=arch\n");
			assert.equal(readOsRelease([custom])?.id, "arch");
			assert.deepEqual(readOsRelease(), first);
			assert.equal(reads.paths.filter((path) => path === custom).length, 2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
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
});

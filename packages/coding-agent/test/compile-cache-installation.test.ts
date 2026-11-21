import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "vitest";
import {
	INSTALLER_AT_WORK_MS,
	type InstallationSnapshot,
	installationChanged,
	installerAtWork,
	readInstallationSnapshot,
} from "../src/utils/compile-cache-installation.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const start: InstallationSnapshot = { directory: "7:100", manifest: "512:200", entry: true, beside: [".cache"] };

describe("a compile-cache helper's installation", () => {
	test("counts as changed once an installer starts on it (#6132)", () => {
		const changes: [string, Partial<InstallationSnapshot>][] = [
			["the package directory is gone (renamed or removed)", { directory: undefined }],
			["another package directory is in its place", { directory: "8:300" }],
			["package.json is gone", { manifest: undefined }],
			["package.json was rewritten (another version)", { manifest: "530:400" }],
			["the CLI entry is gone", { entry: false }],
			["npm moved a package aside next to it", { beside: [".cache", ".atomic-Xd93kq2"] }],
		];
		for (const [what, change] of changes)
			assert.equal(installationChanged(start, { ...start, ...change }), true, what);
	});

	test("does not count as changed while it stays as it was (#6132)", () => {
		assert.equal(installationChanged(start, { ...start, beside: [".cache"] }), false);
		assert.equal(installationChanged(start, { ...start, beside: [] }), false);
	});

	test("is read from the package directory and what is next to it (#6132)", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-installation-"));
		tempDirs.push(root);
		const packageDir = join(root, "atomic");
		mkdirSync(join(packageDir, "dist"), { recursive: true });
		writeFileSync(join(packageDir, "package.json"), '{"version":"1.0.0"}');
		writeFileSync(join(packageDir, "dist", "cli.js"), "");
		const before = readInstallationSnapshot(packageDir);
		assert.equal(before.entry, true);
		assert.notEqual(before.directory, undefined);
		assert.equal(installationChanged(before, readInstallationSnapshot(packageDir)), false);
		// What npm does first when it replaces a package: it moves the old directory aside.
		renameSync(packageDir, join(root, ".atomic-retired"));
		assert.equal(installationChanged(before, readInstallationSnapshot(packageDir)), true);
	});

	test("is taken as an installer at work only while a hidden entry beside it is recent (#6132)", () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-installer-"));
		tempDirs.push(root);
		const packageDir = join(root, "atomic");
		mkdirSync(packageDir);
		assert.equal(installerAtWork(packageDir), false);
		// What an install interrupted long ago leaves behind does not hold warming back for good.
		const leftover = join(root, ".atomic-leftover");
		mkdirSync(leftover);
		const old = (Date.now() - 2 * INSTALLER_AT_WORK_MS) / 1000;
		utimesSync(leftover, old, old);
		assert.equal(installerAtWork(packageDir), false);
		mkdirSync(join(root, ".atomic-Xd93kq2"));
		assert.equal(installerAtWork(packageDir), true);
	});
});

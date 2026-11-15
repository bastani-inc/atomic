import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

/** While set, the next read of this path returns its first half, as a read during an in-place write would. */
const torn = vi.hoisted(() => ({ path: undefined as string | undefined, reads: 0 }));

vi.mock("fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fs")>();
	const readFileSync = ((path: Parameters<typeof actual.readFileSync>[0], options?: unknown) => {
		const content = actual.readFileSync(path, options as BufferEncoding);
		if (path === torn.path && typeof content === "string") {
			torn.reads++;
			if (torn.reads === 1) return content.slice(0, Math.floor(content.length / 2));
		}
		return content;
	}) as typeof actual.readFileSync;
	return { ...actual, default: { ...actual, readFileSync }, readFileSync };
});

let directory: string;

beforeEach(() => {
	directory = realpathSync(mkdtempSync(join(tmpdir(), "atomic-settings-torn-read-")));
	torn.path = undefined;
	torn.reads = 0;
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

it("rereads under the lock a settings file read halfway through an in-place write (#5161)", () => {
	const agentDir = join(directory, "agent");
	mkdirSync(agentDir, { recursive: true });
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ defaultProjectTrust: "always", theme: "dark" }));
	torn.path = settingsPath;
	const manager = SettingsManager.create(join(directory, "project"), agentDir, { projectTrusted: false });
	assert.equal(manager.getGlobalSettingsLoadError(), null);
	assert.equal(manager.getDefaultProjectTrust(), "always");
	assert.equal(torn.reads, 2);
	assert.equal(existsSync(`${settingsPath}.lock`), false, "the lock taken for the reread is released");
});

it("reads a settings file that parses once, without rereading it under the lock (#5161)", () => {
	const agentDir = join(directory, "agent");
	mkdirSync(agentDir, { recursive: true });
	const settingsPath = join(agentDir, "settings.json");
	writeFileSync(settingsPath, JSON.stringify({ defaultProjectTrust: "always" }));
	torn.path = settingsPath;
	torn.reads = 1;
	const manager = SettingsManager.create(join(directory, "project"), agentDir, { projectTrusted: false });
	assert.equal(manager.getDefaultProjectTrust(), "always");
	assert.equal(torn.reads, 2, "read once");
});

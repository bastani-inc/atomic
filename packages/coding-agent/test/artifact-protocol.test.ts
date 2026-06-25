import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactManager, getArtifactManager, resetArtifactManagerCache } from "../src/core/tools/artifacts.ts";
import { createArtifactRouter, readArtifactUrl, registerArtifactDir, resolveArtifactUrl, unregisterArtifactDir } from "../src/core/tools/artifact-protocol.ts";

const dirs: string[] = [];
async function tempDir() { const d = await mkdtemp(join(tmpdir(), "atomic-art-")); dirs.push(d); return d; }
beforeEach(() => { resetArtifactManagerCache(); });
afterEach(async () => { for (const d of dirs.splice(0)) { unregisterArtifactDir(d); await rm(d, { recursive: true, force: true }); } });

describe("artifact manager", () => {
	it("saves with sequential ids and scan-inits existing", async () => {
		const dir = await tempDir();
		const m1 = new ArtifactManager(dir);
		expect(m1.save("a", "read")).toBe("0");
		expect(m1.save("b", "read")).toBe("1");
		const m2 = new ArtifactManager(dir);
		expect(m2.save("c", "read")).toBe("2");
	});

	it("resolves by id prefix and lists", async () => {
		const dir = await tempDir();
		const m = getArtifactManager(dir);
		const id = m.save("content", "bash");
		expect(m.resolve(id)).toBe(join(dir, `${id}.bash.log`));
		expect(m.list()).toEqual([id]);
	});
});

describe("artifact protocol", () => {
	it("resolves artifact:// via pinned and active dirs", async () => {
		const dir = await tempDir();
		registerArtifactDir(dir);
		const m = getArtifactManager(dir);
		const id = m.save("hello world", "read");
		const path = resolveArtifactUrl(`artifact://${id}`, []);
		expect(path).toBe(join(dir, `${id}.read.log`));
		expect(readArtifactUrl(`artifact://${id}`, [])).toBe("hello world");
	});

	it("router resolves and reads artifact urls only", async () => {
		const dir = await tempDir();
		const m = getArtifactManager(dir);
		const id = m.save("body", "read");
		const router = createArtifactRouter(() => [dir]);
		expect(router.resolve?.("skill://x")).toBeUndefined();
		expect(router.resolve?.(`artifact://${id}`)).toBe(join(dir, `${id}.read.log`));
		expect(router.read?.(`artifact://${id}`)).toBe("body");
	});

	it("rejects non-numeric ids", () => {
		expect(() => resolveArtifactUrl("artifact://abc", [])).toThrow(/numeric/);
	});
});

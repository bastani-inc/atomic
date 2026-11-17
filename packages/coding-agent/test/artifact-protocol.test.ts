import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createArtifactRouter,
	readArtifactUrl,
	registerArtifactDir,
	resolveArtifactUrl,
	unregisterArtifactDir,
} from "../src/core/tools/artifact-protocol.ts";
import { ArtifactManager, getArtifactManager, resetArtifactManagerCache } from "../src/core/tools/artifacts.ts";

const dirs: string[] = [];
async function tempDir() {
	const d = await mkdtemp(join(tmpdir(), "atomic-art-"));
	dirs.push(d);
	return d;
}
beforeEach(() => {
	resetArtifactManagerCache();
});
afterEach(async () => {
	for (const d of dirs.splice(0)) {
		unregisterArtifactDir(d);
		await rm(d, { recursive: true, force: true });
	}
});

describe("artifact manager", () => {
	it("saves with sequential ids and scan-inits existing", async () => {
		const dir = await tempDir();
		const m1 = new ArtifactManager(dir);
		expect(await m1.save("a", "read")).toBe("0");
		expect(await m1.save("b", "read")).toBe("1");
		const m2 = new ArtifactManager(dir);
		expect(await m2.save("c", "read")).toBe("2");
	});

	it("resolves by id prefix and lists", async () => {
		const dir = await tempDir();
		const m = getArtifactManager(dir);
		const id = await m.save("content", "bash");
		expect(await m.resolve(id)).toBe(join(dir, `${id}.bash.log`));
		expect(await m.list()).toEqual([id]);
	});
});

describe("artifact protocol", () => {
	it("resolves artifact:// via pinned and active dirs", async () => {
		const dir = await tempDir();
		registerArtifactDir(dir);
		const m = getArtifactManager(dir);
		const id = await m.save("hello world", "read");
		const path = await resolveArtifactUrl(`artifact://${id}`, []);
		expect(path).toBe(join(dir, `${id}.read.log`));
		expect(await readArtifactUrl(`artifact://${id}`, [])).toBe("hello world");
	});

	it("router resolves and reads artifact urls only", async () => {
		const dir = await tempDir();
		const m = getArtifactManager(dir);
		const id = await m.save("body", "read");
		const router = createArtifactRouter(() => [dir]);
		expect(await router.resolve?.("skill://x")).toBeUndefined();
		expect(await router.resolve?.(`artifact://${id}`)).toBe(join(dir, `${id}.read.log`));
		expect(await router.read?.(`artifact://${id}`)).toBe("body");
	});

	it("rejects non-numeric ids", async () => {
		await expect(resolveArtifactUrl("artifact://abc", [])).rejects.toThrow(/numeric/);
	});
});

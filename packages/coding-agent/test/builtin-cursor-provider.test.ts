import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { copyFilteredDirectory } from "../scripts/copy-builtin-packages.ts";
import { getBuiltinPackagePaths } from "../src/core/builtin-packages.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(name: string): string {
	const dir = join(tmpdir(), `${name}-${randomUUID()}`);
	tempDirs.push(dir);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("built-in Cursor provider package discovery", () => {
	it("includes the experimental @bastani/cursor-provider workspace package", () => {
		const paths = getBuiltinPackagePaths();
		expect(paths.some((path) => path.endsWith("packages/cursor-provider"))).toBe(true);
	});

	it("copies Cursor runtime bridge and proto files while skipping tests", () => {
		const source = tempDir("cursor-provider-source");
		const dest = tempDir("cursor-provider-dest");
		mkdirSync(join(source, "proto"), { recursive: true });
		mkdirSync(join(source, "test"), { recursive: true });
		writeFileSync(join(source, "h2-bridge.mjs"), "export {};\n");
		writeFileSync(join(source, "proto", "agent_pb.ts"), "export {};\n");
		writeFileSync(join(source, "test", "proxy.test.ts"), "export {};\n");

		copyFilteredDirectory(source, dest);

		expect(existsSync(join(dest, "h2-bridge.mjs"))).toBe(true);
		expect(existsSync(join(dest, "proto", "agent_pb.ts"))).toBe(true);
		expect(existsSync(join(dest, "test", "proxy.test.ts"))).toBe(false);
	});
});

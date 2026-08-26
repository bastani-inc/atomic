import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePackageDirFrom } from "../src/config-package-identity.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { resolveExtensionEntries } from "../src/core/package-manager-resource-files.ts";
import { migrateAuthJsonConfigValues } from "../src/migrations-config-values.ts";

const temporaryDirectories: string[] = [];

function temporaryDirectory(label: string): string {
	const directory = mkdtempSync(join(tmpdir(), `atomic-bom-${label}-`));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

describe("UTF-8 BOM reader doors", () => {
	it("loads layered auth storage through its file backend", async () => {
		const directory = temporaryDirectory("auth");
		const authPath = join(directory, "auth.json");
		writeFileSync(authPath, `\uFEFF${JSON.stringify({ anthropic: { type: "api_key", key: "secret" } })}`);

		const storage = AuthStorage.create(authPath);
		await expect(storage.read("anthropic")).resolves.toEqual({ type: "api_key", key: "secret" });
	});

	it("recognizes app identity and extension manifests", async () => {
		const appDirectory = temporaryDirectory("packages");
		const companionDirectory = join(appDirectory, "packages", "workflows");
		const extensionDirectory = join(appDirectory, "extension");
		mkdirSync(companionDirectory, { recursive: true });
		mkdirSync(extensionDirectory, { recursive: true });
		writeFileSync(join(appDirectory, "package.json"), `\uFEFF${JSON.stringify({ name: "@bastani/atomic" })}`);
		writeFileSync(
			join(companionDirectory, "package.json"),
			`\uFEFF${JSON.stringify({ name: "@bastani/workflows" })}`,
		);
		writeFileSync(
			join(extensionDirectory, "package.json"),
			`\uFEFF${JSON.stringify({ atomic: { extensions: ["main.ts"] } })}`,
		);
		writeFileSync(join(extensionDirectory, "main.ts"), "export default () => {};\n");

		expect(resolvePackageDirFrom(companionDirectory)).toBe(appDirectory);
		await expect(resolveExtensionEntries(extensionDirectory)).resolves.toEqual([join(extensionDirectory, "main.ts")]);
	});

	it("migrates BOM-prefixed credential config values", () => {
		const directory = temporaryDirectory("migration");
		const authPath = join(directory, "auth.json");
		const previous = process.env.ATOMIC_BOM_MIGRATION_KEY;
		process.env.ATOMIC_BOM_MIGRATION_KEY = "configured";
		try {
			writeFileSync(
				authPath,
				`\uFEFF${JSON.stringify({ provider: { type: "api_key", key: "ATOMIC_BOM_MIGRATION_KEY" } })}`,
			);

			expect(migrateAuthJsonConfigValues(directory)).toHaveLength(1);
			expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
				provider: { type: "api_key", key: "$ATOMIC_BOM_MIGRATION_KEY" },
			});
		} finally {
			if (previous === undefined) delete process.env.ATOMIC_BOM_MIGRATION_KEY;
			else process.env.ATOMIC_BOM_MIGRATION_KEY = previous;
		}
	});
});

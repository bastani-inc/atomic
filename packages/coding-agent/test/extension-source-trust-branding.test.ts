import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_TITLE } from "../src/config.ts";
import { formatBorrowedExtensionSourceTrustPrompt } from "../src/core/project-trust.ts";

const mainSource = readFileSync(fileURLToPath(new URL("../src/main.ts", import.meta.url)), "utf-8");

afterEach(() => {
	vi.resetModules();
	vi.doUnmock("../src/config.ts");
});

describe("extension-source trust prompt branding", () => {
	it("names the product through the branding constant", () => {
		const prompt = formatBorrowedExtensionSourceTrustPrompt("/tmp/borrowed-source");
		expect(prompt).toContain(`This allows ${APP_TITLE} to load`);
		expect(prompt).toContain("/tmp/borrowed-source");
	});

	it("follows a rebranded distribution instead of a hardcoded name", async () => {
		vi.resetModules();
		vi.doMock("../src/config.ts", async () => {
			const actual = await vi.importActual<typeof import("../src/config.ts")>("../src/config.ts");
			return { ...actual, APP_TITLE: "Rebrand" };
		});

		const rebranded = await import("../src/core/project-trust.ts");
		const prompt = rebranded.formatBorrowedExtensionSourceTrustPrompt("/tmp/borrowed-source");

		expect(prompt).toContain("This allows Rebrand to load");
		expect(prompt).not.toContain("Atomic");
		// The two compatibility directories the loader reads from that source are
		// paths, not branding, and must survive the rename.
		expect(prompt).toContain("project-local .atomic/.pi resources and .agents/skills");
		expect(prompt).toContain("extensions and workflows that can execute code");
	});

	it("keeps the prompt out of main.ts, where no branding constant is in scope", () => {
		// The literal lived here and named Atomic regardless of the configured
		// branding. A trust prompt assembled at this call site cannot use APP_TITLE
		// without importing it, so the prompt belongs to core/project-trust.ts.
		expect(mainSource).toContain("formatBorrowedExtensionSourceTrustPrompt(source)");
		expect(mainSource).not.toContain("This allows");
	});
});

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-render-chat.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const TRUST_WARNING = "This project is not trusted.";

let projectDir: string;

beforeAll(() => initTheme("dark"));
beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "atomic-trust-warning-"));
});
afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
});

function writeProjectSettings(): void {
	mkdirSync(join(projectDir, ".atomic"));
	writeFileSync(join(projectDir, ".atomic", "settings.json"), JSON.stringify({ defaultTools: ["+codemode"] }));
}

function renderInitialChat(projectTrusted: boolean): string {
	const chatContainer = new Container();
	const mode = {
		chatContainer,
		session: {},
		ui: { requestRender: vi.fn() },
		attachStartupNoticesContainer: vi.fn(),
		renderSessionEntries: vi.fn(),
		sessionManager: { getEntries: () => [], getLeafId: () => null, getCwd: () => projectDir },
		settingsManager: { isProjectTrusted: () => projectTrusted },
	};
	InteractiveModeBase.prototype.renderInitialMessages.call(mode as never);
	return stripTerminalSequences(chatContainer.render(200).join("\n"));
}

test("warns that untrusted project settings are ignored", () => {
	writeProjectSettings();

	const chat = renderInitialChat(false);

	expect(chat).toContain(TRUST_WARNING);
	expect(chat).toContain("Project .atomic resources and packages are ignored. Use /trust");
});

test("does not warn once the project is trusted", () => {
	writeProjectSettings();

	expect(renderInitialChat(true)).not.toContain(TRUST_WARNING);
});

test("does not warn for a project without trust-gated resources", () => {
	expect(renderInitialChat(false)).not.toContain(TRUST_WARNING);
});

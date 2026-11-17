import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@bastani/atomic-tui";
import { beforeAll, beforeEach, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import type { TrustSelectorComponent } from "../src/modes/interactive/components/trust-selector.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import "../src/modes/interactive/interactive-session-routing.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark"));
beforeEach(() => setKeybindings(new KeybindingsManager()));

it.each(["cancel", "save"] as const)("/trust retries a failed save and can %s (#5237)", async (action) => {
	const directory = mkdtempSync(join(tmpdir(), "atomic-trust-retry-"));
	const agentDir = join(directory, "agent");
	const errors: string[] = [];
	let closed = false;
	let mounted: { component: TrustSelectorComponent; dispose?: () => void } | undefined;
	const mode = {
		sessionManager: { getCwd: () => directory },
		runtimeHost: {
			services: { agentDir },
			session: {
				extensionRunner: {
					withProjectTrustPrompt: (_kind: string, _title: string, run: () => Promise<void>) => run(),
				},
			},
		},
		settingsManager: { isProjectTrusted: () => false },
		showSelector: (create: (done: () => void) => NonNullable<typeof mounted>) => {
			mounted = create(() => {
				closed = true;
				mounted?.dispose?.();
			});
		},
		showStatus: () => {},
		showError: (message: string) => errors.push(message),
		ui: { requestRender: () => {} },
	};
	try {
		InteractiveModeBase.prototype.showTrustSelector.call(mode as never);
		assert.ok(mounted);
		writeFileSync(agentDir, "blocks trust storage");
		mounted.component.handleInput("\r");
		assert.equal(errors.length, 1);
		assert.equal(closed, false);
		mounted.component.handleInput("\r");
		assert.equal(errors.length, 2);
		assert.equal(closed, false);
		if (action === "cancel") {
			mounted.component.handleInput("\x1b");
		} else {
			rmSync(agentDir);
			mounted.component.handleInput("\r");
			assert.equal(new ProjectTrustStore(agentDir).get(directory), true);
		}
		assert.equal(closed, true);
		await Promise.resolve();
		assert.equal(errors.length, 2);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

/**
 * The `Webhooks` settings screen (`WebhooksSubmenu` in
 * `src/modes/interactive/components/settings-selector-submenus.ts`).
 *
 * Issue #2345: one entry point in `/settings` that inspects what is configured,
 * enables or disables each destination, and appends a preset template. The file
 * stays authoritative, so every change here is a write to `webhooks.json` that
 * preserves whatever else the file holds, and a template carries a placeholder
 * URL rather than asking for a credential.
 *
 * Rows are read through the component's own render; writes are checked by
 * reading the file back, which is what the user would open next.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, test } from "vitest";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import { readWebhooksFile, webhooksConfigPath } from "../../packages/coding-agent/src/extensions/webhooks/config.js";
import { presetDestinationTemplate } from "../../packages/coding-agent/src/extensions/webhooks/presets.js";
import { WebhooksSubmenu } from "../../packages/coding-agent/src/modes/interactive/components/settings-selector-submenus.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

beforeAll(() => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
});

const FAKE_TOKEN = "test-token-not-a-secret";
const previousAgentDir = process.env[ENV_AGENT_DIR];

afterEach(() => {
	if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
	else process.env[ENV_AGENT_DIR] = previousAgentDir;
});

/**
 * Point the agent directory at a scratch dir, which is the seam
 * `webhooksConfigPath()` resolves through, and optionally seed the file.
 */
function withConfig(document?: unknown): string {
	process.env[ENV_AGENT_DIR] = mkdtempSync(join(tmpdir(), "webhooks-settings-"));
	const path = webhooksConfigPath();
	if (document !== undefined) writeFileSync(path, JSON.stringify(document, null, 2), "utf8");
	return path;
}

const readBack = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, never>;

function destination(over: Record<string, unknown> = {}): unknown {
	return {
		name: "Team channel",
		type: "slack",
		enabled: true,
		events: ["agent_finished"],
		url: "https://example.invalid/hook",
		headers: { Authorization: `Bearer ${FAKE_TOKEN}` },
		...over,
	};
}

const rendered = (submenu: WebhooksSubmenu, width = 100): string =>
	submenu
		.render(width)
		.map((line) => stripVTControlCharacters(line))
		.join("\n");

/** The list's change handler is private to the component; drive it as the user does. */
function toggle(submenu: WebhooksSubmenu, id: string, value: string): void {
	const list = (submenu as unknown as { settingsList: { onChange?: (id: string, value: string) => void } })
		.settingsList;
	const change = (list as unknown as { onChange: (id: string, value: string) => void }).onChange;
	change.call(list, id, value);
}

describe("webhooks settings screen (#2345)", () => {
	test("shows the resolved file path, so the user can find where URLs are entered", () => {
		const path = withConfig({ version: 1, destinations: [] });
		const text = rendered(new WebhooksSubmenu(() => undefined));
		assert.ok(text.includes(path), "the path is shown in full, not an assumed home directory");
	});

	test("lists each destination with its state, and says when none are configured", () => {
		withConfig({ version: 1, destinations: [destination(), destination({ name: "Alerts", enabled: false })] });
		const text = rendered(new WebhooksSubmenu(() => undefined));
		assert.match(text, /Team channel/);
		assert.match(text, /Alerts/);
		assert.match(text, /2 configured/);

		withConfig({ version: 1, destinations: [] });
		assert.match(rendered(new WebhooksSubmenu(() => undefined)), /none configured/);
	});

	test("an absent file is offered for setup rather than reported as broken", () => {
		withConfig(undefined);
		const text = rendered(new WebhooksSubmenu(() => undefined));
		assert.match(text, /none configured/);
		assert.doesNotMatch(text, /could not be used/);
	});

	test("a file that cannot be parsed is reported and never silently replaced", () => {
		const path = withConfig("not a webhooks document");
		const before = readFileSync(path, "utf8");
		const text = rendered(new WebhooksSubmenu(() => undefined));
		assert.match(text, /could not be used/);
		assert.doesNotMatch(text, /none configured/, "no editing rows over a file we cannot read");
		assert.equal(readFileSync(path, "utf8"), before, "the file is left exactly as it was");
	});

	test("toggling a destination writes the file and keeps every other key it held", () => {
		const path = withConfig({
			version: 1,
			destinations: [destination({ retainedByTheUser: "keep me" })],
			somethingElse: { kept: true },
		});
		toggle(new WebhooksSubmenu(() => undefined), "destination:0", "disabled");

		const after = readBack(path) as unknown as {
			version: number;
			somethingElse: { kept: boolean };
			destinations: { enabled: boolean; retainedByTheUser: string; url: string }[];
		};
		assert.equal(after.destinations[0]?.enabled, false);
		assert.equal(after.destinations[0]?.retainedByTheUser, "keep me", "unknown keys survive the round trip");
		assert.deepEqual(after.somethingElse, { kept: true }, "and so do unknown top-level keys");
		assert.equal(after.version, 1);
	});
});

describe("adding a preset (#2345)", () => {
	/** `appendPreset` is private to the component; drive it as the nested picker does. */
	function addPreset(submenu: WebhooksSubmenu, type: "slack" | "teams" | "custom"): void {
		(submenu as unknown as { appendPreset: (type: string) => void }).appendPreset(type);
	}

	test("a template is disabled, carries a placeholder URL, and holds no credential", () => {
		for (const type of ["slack", "teams", "custom"] as const) {
			const entry = presetDestinationTemplate(type, "Name") as unknown as {
				enabled: boolean;
				url: string;
				headers: Record<string, string>;
				type: string;
			};
			assert.equal(entry.enabled, false, `${type}: never enabled before the user has pasted a URL`);
			assert.equal(entry.type, type);
			assert.match(entry.url, /example\.invalid/, `${type}: an unroutable placeholder, never a real URL`);
			assert.match(entry.url, /replace/i, `${type}: the placeholder says what to do`);
			assert.deepEqual(entry.headers, {}, `${type}: no credential is invented`);
		}
	});

	test("the template Atomic writes is one Atomic's own validator accepts", () => {
		const path = withConfig({ version: 1, destinations: [] });
		addPreset(new WebhooksSubmenu(() => undefined), "slack");

		const result = readWebhooksFile(path);
		assert.equal(result.kind, "current");
		if (result.kind !== "current") return;
		assert.deepEqual(result.diagnostics, [], "a template must not produce a diagnostic against its own reader");
		assert.equal(result.destinations.length, 1);
		assert.equal(result.destinations[0]?.type, "slack");
		assert.equal(result.destinations[0]?.enabled, false);
	});

	test("appending keeps what was already there and never reuses a name", () => {
		const path = withConfig({ version: 1, destinations: [destination({ name: "Slack" })], kept: true });
		const submenu = new WebhooksSubmenu(() => undefined);
		addPreset(submenu, "slack");
		addPreset(new WebhooksSubmenu(() => undefined), "slack");

		const after = readBack(path) as unknown as {
			kept: boolean;
			destinations: { name: string }[];
		};
		assert.equal(after.kept, true, "unknown top-level keys survive");
		assert.deepEqual(
			after.destinations.map((entry) => entry.name),
			["Slack", "Slack 2", "Slack 3"],
			"each template gets its own name, so the list stays readable",
		);
	});

	test("a preset can be added to a file that does not exist yet", () => {
		const path = withConfig(undefined);
		addPreset(new WebhooksSubmenu(() => undefined), "teams");
		const result = readWebhooksFile(path);
		assert.equal(result.kind, "current");
		if (result.kind !== "current") return;
		assert.equal(result.destinations[0]?.name, "Microsoft Teams");
	});
});

test("a row will not toggle a different destination when the file was reordered underneath it", () => {
	const path = withConfig({
		version: 1,
		destinations: [destination({ name: "Team channel" }), destination({ name: "Alerts", enabled: true })],
	});
	const submenu = new WebhooksSubmenu(() => undefined);
	// The user edits the file by hand while the screen is open: the entry at
	// position 0 is no longer the one row 0 was labelled from.
	writeFileSync(
		path,
		JSON.stringify({ version: 1, destinations: [destination({ name: "Alerts", enabled: true })] }, null, 2),
		"utf8",
	);
	toggle(submenu, "destination:0", "disabled");

	const after = readBack(path) as unknown as { destinations: { name: string; enabled: boolean }[] };
	assert.equal(after.destinations.length, 1);
	assert.equal(after.destinations[0]?.name, "Alerts");
	assert.equal(after.destinations[0]?.enabled, true, "the surviving destination is untouched by a stale row");
});

import assert from "node:assert/strict";
import { setKeybindings } from "@earendil-works/pi-tui";
import { beforeAll, describe, test, vi } from "vitest";
import { shouldRunDurabilitySetup } from "../src/cli/startup-ui.js";
import { KeybindingsManager } from "../src/core/keybindings.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { runFirstTimeSetup } from "../src/main-first-time-setup.js";
import { FirstTimeSetupComponent } from "../src/modes/interactive/components/first-time-setup.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

const QUESTION = "What durable backend would you like to use for workflows?";

function rendered(component: FirstTimeSetupComponent): string {
	return component.render(100).join("\n");
}

beforeAll(() => {
	initTheme("dark", false);
	setKeybindings(KeybindingsManager.create());
});

test("detects absent, embedded, external, and environment-selected onboarding states", () => {
	const manager = SettingsManager.inMemory();
	assert.equal(shouldRunDurabilitySetup(manager, undefined), true);
	assert.equal(shouldRunDurabilitySetup(manager, " \n"), true);
	assert.equal(shouldRunDurabilitySetup(manager, "postgresql://database.example/workflows"), false);

	manager.setDbosSystemDatabaseUrl("");
	assert.equal(shouldRunDurabilitySetup(manager, undefined), false);
	manager.setDbosSystemDatabaseUrl("postgresql://database.example/workflows");
	assert.equal(shouldRunDurabilitySetup(manager, undefined), false);
});

test("leaves first-time setup untouched in every non-interactive mode", async () => {
	for (const appMode of ["print", "json", "rpc"] as const) {
		const manager = SettingsManager.inMemory();
		const capture = { consume: vi.fn(() => ({ text: "", submissions: [] })) };
		const setDbosSystemDatabaseUrl = vi.spyOn(manager, "setDbosSystemDatabaseUrl");

		assert.equal(await runFirstTimeSetup(appMode, manager, capture), capture);
		assert.equal(capture.consume.mock.calls.length, 0);
		assert.equal(setDbosSystemDatabaseUrl.mock.calls.length, 0);
		assert.equal(manager.getDbosSystemDatabaseUrl(), undefined);
	}
});

describe("first-time durability setup", () => {
	test("orders theme, durability, then analytics with the required copy", async () => {
		const validate = vi.fn(async (value: string) => value.trim());
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: vi.fn(),
			onValidateDurability: validate,
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
		});

		assert.match(rendered(component), /Pick a theme/);
		component.handleInput("\n");
		assert.match(rendered(component), new RegExp(QUESTION.replace(/[?]/g, "\\?")));
		assert.match(rendered(component), /Leave empty to use Atomic’s embedded PostgreSQL/);
		component.handleInput("postgresql://database.example/workflows");
		component.handleInput("\n");
		await vi.waitFor(() => assert.match(rendered(component), /Opt in to anonymous usage analytics/));
		assert.deepEqual(validate.mock.calls, [["postgresql://database.example/workflows"]]);
	});

	test("keeps the durability input active and renders validation failures", async () => {
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: vi.fn(),
			onValidateDurability: async () => {
				throw new Error("Database host is unreachable");
			},
			onSubmit: vi.fn(),
			onCancel: vi.fn(),
		});
		component.handleInput("\n");
		component.handleInput("postgresql://database.example/workflows");
		component.handleInput("\n");

		await vi.waitFor(() => assert.match(rendered(component), /Database host is unreachable/));
		assert.match(rendered(component), new RegExp(QUESTION.replace(/[?]/g, "\\?")));
	});

	test("returns the validated durability choice only after analytics completes", async () => {
		const onSubmit = vi.fn();
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: vi.fn(),
			onValidateDurability: async () => "",
			onSubmit,
			onCancel: vi.fn(),
		});
		component.handleInput("\n");
		component.handleInput("\n");
		await vi.waitFor(() => assert.match(rendered(component), /Opt in to anonymous usage analytics/));
		component.handleInput("\n");

		assert.deepEqual(onSubmit.mock.calls[0]?.[0], { theme: "dark", dbosSystemDatabaseUrl: "", shareAnalytics: true });
	});
	test("skips durability without inventing a saved choice when the environment selected PostgreSQL", () => {
		const onSubmit = vi.fn();
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			skipDurability: true,
			onThemePreview: vi.fn(),
			onValidateDurability: async () => {
				throw new Error("validation must not run");
			},
			onSubmit,
			onCancel: vi.fn(),
		});
		component.handleInput("\n");
		assert.match(rendered(component), /Opt in to anonymous usage analytics/);
		component.handleInput("\n");

		assert.deepEqual(onSubmit.mock.calls[0]?.[0], { theme: "dark", shareAnalytics: true });
	});

	test("cancelling during durability does not complete or persist the wizard", () => {
		const onSubmit = vi.fn();
		const onCancel = vi.fn();
		const component = new FirstTimeSetupComponent({
			detectedTheme: "dark",
			onThemePreview: vi.fn(),
			onValidateDurability: async () => "",
			onSubmit,
			onCancel,
		});
		component.handleInput("\n");
		component.handleInput("\u001b");

		assert.equal(onCancel.mock.calls.length, 1);
		assert.equal(onSubmit.mock.calls.length, 0);
	});
});

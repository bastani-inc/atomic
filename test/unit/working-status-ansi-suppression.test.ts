/**
 * The four suites that assert Atomic's working indicator read ANSI escapes, so
 * an exported `NO_COLOR` in the developer's shell decided their verdict: seven
 * assertions failed against unpainted output that the product was right to
 * produce. `test/helpers/ansi-color-env.ts` pins that variable for them.
 *
 * This file is the counterweight. It never calls `useAnsiColorEnvironment`,
 * because it exists to prove the two halves the helper depends on: that
 * suppression really is what silenced those suites, and that clearing it hands
 * the environment back untouched so no other file in the shared worker inherits
 * this one's preference.
 */

import assert from "node:assert/strict";
import { afterEach, beforeAll, test } from "vitest";
import { ChatSessionHost } from "../../packages/coding-agent/src/index.ts";
import { setThemeInstance } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { loadTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme-loading.ts";
import { ANSI_SUPPRESSION_ENV_VAR, clearAnsiSuppression } from "../helpers/ansi-color-env.ts";
import {
	editorTheme,
	installLifecycleFakeClock,
	plainStyle,
	rawWorkingLine,
} from "./chat-session-host-working-lifecycle-fixture.ts";

const accentStyle = {
	...plainStyle,
	accent: (text: string) => `<accent>${text}</accent>`,
	accentBold: (text: string) => `<accent-bold>${text}</accent-bold>`,
};

const palettedStyle = {
	...plainStyle,
	workingIndicatorPalette: () => ({
		dark: "#101010",
		lift: "#1c2c3c",
		muted: "#2d537a",
		accent: "#4080c0",
		bright: "#a1beda",
		peak: "#f0f0f0",
	}),
};

const original = process.env[ANSI_SUPPRESSION_ENV_VAR];

function restoreSuppression(): void {
	if (original === undefined) delete process.env[ANSI_SUPPRESSION_ENV_VAR];
	else process.env[ANSI_SUPPRESSION_ENV_VAR] = original;
}

/** Render the working line of a streaming host built with `style`. */
function workingStatusLine(style: typeof plainStyle): string {
	const timers = installLifecycleFakeClock();
	const host = new ChatSessionHost<never>({ style, editorTheme });
	try {
		host.applyAgentEvent({ type: "agent_start" } as never);
		return rawWorkingLine(host) ?? "";
	} finally {
		host.dispose();
		timers.restore();
	}
}

beforeAll(() => {
	setThemeInstance(loadTheme("dark", "truecolor"));
});

afterEach(restoreSuppression);

test("a set NO_COLOR is what strips caller styling and the palette ramp from the working status", () => {
	process.env[ANSI_SUPPRESSION_ENV_VAR] = "1";

	assert.equal(workingStatusLine(accentStyle).trimEnd(), " ∀ Working...");
	assert.doesNotMatch(workingStatusLine(palettedStyle), /\u001b\[38;2;/);
});

test("an empty NO_COLOR suppresses exactly as a set one does", () => {
	process.env[ANSI_SUPPRESSION_ENV_VAR] = "";

	assert.equal(workingStatusLine(accentStyle).trimEnd(), " ∀ Working...");
});

test("clearing the suppression restores the caller accent and the palette ramp", () => {
	process.env[ANSI_SUPPRESSION_ENV_VAR] = "1";
	const restore = clearAnsiSuppression();
	try {
		assert.equal(process.env[ANSI_SUPPRESSION_ENV_VAR], undefined);
		assert.equal(workingStatusLine(accentStyle).trimEnd(), " <accent>∀</accent> Working...");
		assert.match(workingStatusLine(palettedStyle), /\u001b\[38;2;16;16;16m∀/);
	} finally {
		restore();
	}
	assert.equal(process.env[ANSI_SUPPRESSION_ENV_VAR], "1", "the inherited value comes back verbatim");
});

test("clearing an absent suppression leaves it absent rather than empty", () => {
	delete process.env[ANSI_SUPPRESSION_ENV_VAR];
	const restore = clearAnsiSuppression();
	restore();

	assert.equal(
		ANSI_SUPPRESSION_ENV_VAR in process.env,
		false,
		"an empty string would still read as suppression to the renderer",
	);
});

test("clearing an empty suppression restores the empty string, not absence", () => {
	process.env[ANSI_SUPPRESSION_ENV_VAR] = "";
	const restore = clearAnsiSuppression();
	assert.equal(process.env[ANSI_SUPPRESSION_ENV_VAR], undefined);
	restore();

	assert.equal(process.env[ANSI_SUPPRESSION_ENV_VAR], "");
});

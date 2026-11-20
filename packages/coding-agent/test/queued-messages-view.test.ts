import assert from "node:assert/strict";
import { type Component, Spacer, TruncatedText } from "@bastani/atomic-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import { QueuedMessagesView, queuedMessageRows } from "../src/modes/interactive/components/queued-messages-view.js";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.js";

beforeEach(() => {
	vi.stubEnv("FORCE_COLOR", undefined);
	vi.stubEnv("NO_COLOR", undefined);
	initTheme("dark");
});

afterEach(() => {
	vi.unstubAllEnvs();
	initTheme("dark");
});

/** The queued rows exactly as the main chat built them before it drew them with QueuedMessagesView. */
function mainChatRowsBefore(steering: string[], followUp: string[], dequeueKey: string): Component[] {
	const children: Component[] = [];
	if (steering.length > 0 || followUp.length > 0) {
		children.push(new Spacer(1));
		for (const message of steering) children.push(new TruncatedText(theme.fg("dim", `Steering: ${message}`), 1, 0));
		for (const message of followUp) children.push(new TruncatedText(theme.fg("dim", `Follow-up: ${message}`), 1, 0));
		children.push(new TruncatedText(theme.fg("dim", `↳ ${dequeueKey} to edit all queued messages`), 1, 0));
	}
	return children;
}

const queues: Array<{ name: string; steering: string[]; followUp: string[] }> = [
	{ name: "nothing queued", steering: [], followUp: [] },
	{ name: "one steering message", steering: ["steer alpha"], followUp: [] },
	{ name: "steering and follow-ups", steering: ["steer alpha", "steer beta"], followUp: ["follow gamma"] },
	{ name: "only follow-ups", steering: [], followUp: ["follow one", "follow two"] },
	{ name: "a message wider than the screen", steering: ["x".repeat(300)], followUp: [] },
	{ name: "wide characters and emoji", steering: ["漢字のメッセージ 🚀 with text"], followUp: ["絵文字 👩‍👩‍👧"] },
	{ name: "a message of several lines", steering: ["first line\nsecond line\nthird"], followUp: ["a\r\nb"] },
	{ name: "a message with its own styling", steering: ["\x1b[31mred\x1b[39m text"], followUp: [] },
	{ name: "an empty message and repeated ones", steering: ["", "same", "same"], followUp: ["same"] },
	{ name: "tabs and trailing spaces", steering: ["tab\there   "], followUp: [] },
];

test("dim styling is on, so the comparison covers the escape sequences as well as the text", () => {
	assert.notEqual(theme.fg("dim", "x"), "x");
});

for (const { name, steering, followUp } of queues) {
	test(`draws the same bytes the main chat drew for ${name}, at every width`, () => {
		for (const key of ["alt+up", "ctrl+shift+up"]) {
			const view = new QueuedMessagesView(queuedMessageRows({ steering, followUp }), key, (text) =>
				theme.fg("dim", text),
			);
			const before = mainChatRowsBefore(steering, followUp, key);
			for (const width of [1, 2, 3, 8, 20, 40, 80, 200]) {
				const expected = before.flatMap((component) => component.render(width));
				assert.deepEqual(view.render(width), expected, `width ${width}, key ${key}`);
			}
		}
	});
}

test("lists every steering message before any follow-up, each lane in the order it was queued", () => {
	assert.deepEqual(queuedMessageRows({ steering: ["s1", "s2"], followUp: ["f1", "f2"] }), [
		{ lane: "steer", text: "s1" },
		{ lane: "steer", text: "s2" },
		{ lane: "followUp", text: "f1" },
		{ lane: "followUp", text: "f2" },
	]);
});

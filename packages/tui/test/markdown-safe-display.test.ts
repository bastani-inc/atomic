import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { resetCapabilitiesCache, setCapabilities } from "../src/terminal-image.ts";
import { stripTerminalSequences } from "../src/utils.ts";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};
afterEach(() => resetCapabilitiesCache());

test("a markdown instance can keep links and images inert without changing terminal capabilities (#5224)", () => {
	setCapabilities({ hyperlinks: true, images: "kitty", trueColor: true });
	const text = "[guide](https://example.test/guide) and ![photo](https://example.test/photo.png)";
	const safe = new Markdown(text, 0, 0, theme, undefined, { hyperlinks: false, images: false });
	const rendered = safe.render(160).join("\n");
	assert.ok(!rendered.includes("\u001b]8;"));
	assert.match(stripTerminalSequences(rendered), /guide \(https:\/\/example\.test\/guide\)/);
	assert.match(stripTerminalSequences(rendered), /\[image\]/);
	const normal = new Markdown(text, 0, 0, theme).render(160).join("\n");
	assert.ok(normal.includes("\u001b]8;"), "the other instance retains clickable links");
});

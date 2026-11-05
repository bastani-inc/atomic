import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { displayUrl, webUrl } from "../src/utils/web-url.js";

describe("web URLs for sign-in", () => {
	test("accepts http and https URLs and normalizes them", () => {
		assert.equal(webUrl("https://Example.test/a b"), "https://example.test/a%20b");
		assert.equal(webUrl("http://127.0.0.1:1455/auth/callback"), "http://127.0.0.1:1455/auth/callback");
		assert.equal(webUrl("https://example.test/\u0007end"), "https://example.test/%07end");
	});

	test("rejects files, custom protocols and text that is not a URL", () => {
		assert.equal(webUrl("file:///etc/passwd"), undefined);
		assert.equal(webUrl("javascript:alert(1)"), undefined);
		assert.equal(webUrl("vscode://open"), undefined);
		assert.equal(webUrl("example.test/login"), undefined);
		assert.equal(webUrl(""), undefined);
	});

	test("displays web URLs normalized and anything else with control characters replaced", () => {
		assert.equal(displayUrl("https://example.test/\u001b]8;;"), "https://example.test/%1B]8;;");
		assert.equal(displayUrl("not a url \u001b]8;;\u0007"), "not a url  ]8;; ");
		assert.equal(displayUrl("file:///tmp/a"), "file:///tmp/a");
	});
});

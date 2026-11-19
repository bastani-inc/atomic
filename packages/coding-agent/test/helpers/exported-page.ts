import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";

/** Open a standalone page, including its initial navigation to the selected branch. */
export function openExportedPage(file: string, search = "", withoutArrayAt = false) {
	const { window, document } = parseHTML(readFileSync(file, "utf8"));
	Object.assign(window.HTMLElement.prototype, { scrollIntoView: () => undefined });
	Object.defineProperty(window, "getSelection", { configurable: true, value: () => ({ toString: () => "" }) });
	const location = { search, hash: "" };
	Object.defineProperty(window, "location", { configurable: true, value: location });
	const context = {
		window,
		document,
		atob,
		TextDecoder,
		URLSearchParams,
		console,
		location,
		navigator: { clipboard: undefined },
		history: { replaceState: () => undefined },
		localStorage: { getItem: () => null, setItem: () => undefined },
		matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
		requestAnimationFrame: (callback: () => void) => {
			callback();
			return 0;
		},
		setTimeout: () => 0,
		clearTimeout: () => undefined,
	};
	// The standalone viewer must also open in browsers predating the newer array search helpers.
	runInNewContext("delete Array.prototype.findLast; delete Array.prototype.findLastIndex", context);
	if (withoutArrayAt) runInNewContext("delete Array.prototype.at", context);
	for (const script of document.querySelectorAll("script")) {
		if (script.getAttribute("type") !== "application/json") runInNewContext(script.textContent ?? "", context);
	}
	return document;
}

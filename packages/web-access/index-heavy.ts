import type { ExtensionAPI } from "@bastani/atomic";
import { CONFIG_DIR_NAME } from "@bastani/atomic";
import { appendFileSync } from "node:fs";
import { getActiveGoogleEmail, isGeminiWebAvailable } from "./gemini-web.js";
import { isBrowserCookieAccessAllowed } from "./gemini-web-config.js";
import { deleteResult, getAllResults } from "./storage.js";
import { loadConfigForExtensionInit, resolveWorkflow, saveConfig, type WebSearchWorkflow } from "./web-search-config.js";

if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE) {
	appendFileSync(process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL_FILE, "web-access\n");
}

if (process.env.ATOMIC_TEST_LAZY_IMPORT_SENTINEL === "1") {
	process.env.ATOMIC_WEB_ACCESS_HEAVY_IMPORTED = "1";
}
import { registerWebSearchFeatures } from "./web-search-features.js";

export default function (pi: ExtensionAPI) {
	const initConfig = loadConfigForExtensionInit();
	registerWebSearchFeatures(pi, initConfig);
	pi.registerCommand("curator", {
		description: "Toggle or configure the search curator workflow",
		handler: async (args, ctx) => {
			const arg = args.trim().toLowerCase();

			let newWorkflow: WebSearchWorkflow;
			if (arg.length === 0) {
				const current = resolveWorkflow(loadConfigForExtensionInit().workflow, true);
				newWorkflow = current === "none" ? "summary-review" : "none";
			} else if (arg === "on") {
				newWorkflow = "summary-review";
			} else if (arg === "off") {
				newWorkflow = "none";
			} else if (arg === "none" || arg === "summary-review") {
				newWorkflow = arg;
			} else {
				ctx.ui.notify(`Unknown option: ${arg}. Use on, off, or summary-review.`, "error");
				return;
			}

			try {
				saveConfig({ workflow: newWorkflow });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				ctx.ui.notify(`Failed to save config: ${message}`, "error");
				return;
			}

			const label = newWorkflow === "none"
				? "Curator disabled — web_search will return raw results"
				: "Curator enabled — web_search will open curator and auto-generate a summary draft";
			pi.sendMessage({
				customType: "curator-config",
				content: [{ type: "text", text: label }],
				display: "tool",
				details: { workflow: newWorkflow },
			}, { triggerTurn: false, deliverAs: "followUp" });
		},
	});

	pi.registerCommand("google-account", {
		description: "Show the active Google account for Gemini Web",
		handler: async () => {
			if (!isBrowserCookieAccessAllowed()) {
				pi.sendMessage({
					customType: "google-account",
					content: [{ type: "text", text: `Gemini Web browser cookie access is disabled. Set allowBrowserCookies: true in ~/${CONFIG_DIR_NAME}/web-search.json to enable it.` }],
					display: "tool",
					details: { available: false, cookieAccessAllowed: false },
				}, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}

			const cookies = await isGeminiWebAvailable();
			if (!cookies) {
				pi.sendMessage({
					customType: "google-account",
					content: [{ type: "text", text: "Gemini Web is unavailable. Sign into gemini.google.com in a supported Chromium-based browser." }],
					display: "tool",
					details: { available: false, cookieAccessAllowed: true },
				}, { triggerTurn: true, deliverAs: "followUp" });
				return;
			}

			const email = await getActiveGoogleEmail(cookies);
			const text = email
				? `Active Google account: ${email}`
				: "Gemini Web is available, but the active Google account could not be determined.";

			pi.sendMessage({
				customType: "google-account",
				content: [{ type: "text", text }],
				display: "tool",
				details: { available: true, email: email ?? null },
			}, { triggerTurn: true, deliverAs: "followUp" });
		},
	});

	pi.registerCommand("search", {
		description: "Browse stored web search results",
		handler: async (_args, ctx) => {
			const results = getAllResults();

			if (results.length === 0) {
				ctx.ui.notify("No stored search results", "info");
				return;
			}

			const options = results.map((r) => {
				const age = Math.floor((Date.now() - r.timestamp) / 60000);
				const ageStr = age < 60 ? `${age}m ago` : `${Math.floor(age / 60)}h ago`;
				if (r.type === "search" && r.queries) {
					const query = r.queries[0]?.query || "unknown";
					return `[${r.id.slice(0, 6)}] "${query}" (${r.queries.length} queries) - ${ageStr}`;
				}
				if (r.type === "fetch" && r.urls) {
					return `[${r.id.slice(0, 6)}] ${r.urls.length} URLs fetched - ${ageStr}`;
				}
				return `[${r.id.slice(0, 6)}] ${r.type} - ${ageStr}`;
			});

			const choice = await ctx.ui.select("Stored Search Results", options);
			if (!choice) return;

			const match = choice.match(/^\[([a-z0-9]+)\]/);
			if (!match) return;

			const selected = results.find((r) => r.id.startsWith(match[1]));
			if (!selected) return;

			const actions = ["View details", "Delete"];
			const action = await ctx.ui.select(`Result ${selected.id.slice(0, 6)}`, actions);

			if (action === "Delete") {
				deleteResult(selected.id);
				ctx.ui.notify(`Deleted ${selected.id.slice(0, 6)}`, "info");
			} else if (action === "View details") {
				let info = `ID: ${selected.id}\nType: ${selected.type}\nAge: ${Math.floor((Date.now() - selected.timestamp) / 60000)}m\n\n`;
				if (selected.type === "search" && selected.queries) {
					info += "Queries:\n";
					const queries = selected.queries.slice(0, 10);
					for (const q of queries) {
						info += `- "${q.query}" (${q.results.length} results)\n`;
					}
					if (selected.queries.length > 10) {
						info += `... and ${selected.queries.length - 10} more\n`;
					}
				}
				if (selected.type === "fetch" && selected.urls) {
					info += "URLs:\n";
					const urls = selected.urls.slice(0, 10);
					for (const u of urls) {
						const urlDisplay = u.url.length > 50 ? u.url.slice(0, 47) + "..." : u.url;
						info += `- ${urlDisplay} (${u.error || `${u.content.length} chars`})\n`;
					}
					if (selected.urls.length > 10) {
						info += `... and ${selected.urls.length - 10} more\n`;
					}
				}
				ctx.ui.notify(info, "info");
			}
		},
	});
}

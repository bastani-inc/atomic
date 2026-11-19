import { appendFileSync } from "node:fs";
import { createRequire } from "node:module";
import { SelectList, SettingsList } from "@bastani/atomic-tui";

const load = createRequire(import.meta.url);
const labels = ["Alpha", "Bravo", "Charlie"];

export default (pi) => {
	pi.registerAgentPanelSource({
		items: () => [{ id: "sample-task", kind: "shell", state: "running", name: "shell", task: "Single shell row" }],
		subscribe: () => () => {},
	});
	pi.registerCommand("sample-menu", {
		description: "Open a menu with fixed sample data",
		handler: async (name, ctx) => {
			if (name === "ready") {
				ctx.ui.notify("Menu commands ready", "info");
				return;
			}
			if (name === "preview") {
				return ctx.ui.custom(() => ({ render: () => ["Passive preview"], invalidate() {} }), {
					overlay: true,
					overlayOptions: { anchor: "top-right", width: 20, nonCapturing: true },
				});
			}
			if (name === "runs" || name === "empty") {
				const { openWorkflowsListing } = await import("../../packages/workflows/src/tui/workflows-listing.ts");
				return openWorkflowsListing(ctx.ui, {
					runs: () =>
						name === "empty"
							? []
							: labels.map((label, index) => ({
									id: `run-${label}`,
									name: "sample",
									status: "running",
									inputs: { objective: `${label} objective` },
									stages: [],
									toolNodes: [],
									startedAt: 1000 - index,
								})),
				});
			}
			if (name === "llama" || name === "search") {
				const { showLlamaUi } = load("../../packages/coding-agent/dist/extensions/llama/ui.js");
				return showLlamaUi(ctx, (ui) =>
					name === "llama"
						? ui.select("Model chooser", labels)
						: ui.searchModels(async () => labels.map((v, i) => ({ id: `models/${v}`, downloads: i + 1 }))),
				);
			}
			return ctx.ui.custom(
				async (tui, theme, keys, done) => {
					if (name === "drag") {
						let held = false;
						return {
							render: () => [`Drag handle: ${held ? "dragging" : "idle"}`],
							invalidate() {},
							handleInput(key) {
								if (key === "v") void ctx.ui.confirm("Move handle?", "Confirm new position?");
							},
							handleMouse(event) {
								if (event.type === "move") return undefined;
								appendFileSync(process.env.DRAFT_CHANGES, `${event.type}\n`);
								if (event.type === "press") held = true;
								if (event.type === "release") held = false;
								return { handled: true, capture: event.type === "press", render: true };
							},
						};
					}
					if (name === "repeated") {
						const plain = (s) => s;
						const row = (label) => ({ label, value: label });
						const repeat = row("Repeat");
						const list = new SelectList([repeat, row("Bravo"), repeat, row("Delta")], 4, {
							selectedPrefix: plain,
							selectedText: plain,
							description: plain,
							scrollInfo: plain,
							noMatch: plain,
						});
						list.onSelect = (item) => appendFileSync(process.env.DRAFT_CHANGES, `choose ${item.label}\n`);
						list.onSelectionChange = (item) => appendFileSync(process.env.DRAFT_CHANGES, `move ${item.label}\n`);
						return list;
					}
					if (name === "settings") {
						const plain = (s) => s;
						const list = new SettingsList(
							labels.map((label) => ({ id: label, label, currentValue: "on", values: ["on", "off"] })),
							3,
							{ label: plain, value: plain, description: plain, hint: plain, cursor: "❯ " },
							() => {},
							done,
							{ enableSearch: true },
						);
						list.selectItem("Bravo");
						return list;
					}
					if (name === "mcp") {
						const { McpManagerView } = load("../../packages/coding-agent/dist/extensions/mcp/ui.js");
						const view = new McpManagerView(tui, theme, keys);
						void view
							.menu(() => ({
								title: "Server chooser",
								items: labels.map((label) => ({ label, value: label })),
								confirmLabel: "open",
								cancelLabel: "close",
							}))
							.then(done);
						return view;
					}
					if (name === "intercom") {
						const { SessionListOverlay } = await import("../../packages/intercom/ui/session-list.ts");
						const session = (label) => ({
							id: `id-${label}`,
							name: label,
							cwd: process.cwd(),
							model: "sample",
							pid: 1234,
							startedAt: 1,
							lastActivity: 2,
						});
						return new SessionListOverlay(theme, keys, session("self"), labels.map(session), done);
					}
					if (name === "resources") {
						const { ResourceList } = load(
							"../../packages/coding-agent/dist/modes/interactive/components/config-selector-list.js",
						);
						const items = labels.map((label) => ({
							path: `skills/${label}/SKILL.md`,
							enabled: true,
							metadata: { source: "local", scope: "user", origin: "top-level" },
							resourceType: "skills",
							displayName: label,
							groupKey: "user",
							subgroupKey: "skills",
						}));
						return new ResourceList(
							[
								{
									key: "user",
									label: "User",
									scope: "user",
									origin: "top-level",
									source: "local",
									subgroups: [{ type: "skills", label: "Skills", items }],
								},
							],
							{ getGlobalSettings: () => ({}) },
							process.cwd(),
							process.cwd(),
							20,
						);
					}
					throw new Error(`Unknown menu: ${name}`);
				},
				name === "intercom" ? { overlay: true } : {},
			);
		},
	});
	pi.on("session_start", (_event, ctx) => {
		if (ctx.isPresentationOnly) return;
		pi.sendMessage({
			customType: "numbered-transcript",
			display: true,
			content: Array.from(
				{ length: 140 },
				(_, i) => `Transcript line ${i} (${process.stdout.isTTY ? "local" : "engine"})`,
			).join("\n"),
		});
	});
};

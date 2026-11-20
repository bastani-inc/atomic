import { clickableHintText, type ExtensionContext } from "@bastani/atomic";
import {
	type Component,
	type Focusable,
	Input,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@bastani/atomic-tui";
import type { AgentConfig } from "../agents/agents.js";

type Theme = ExtensionContext["ui"]["theme"];
const sources = ["project", "user", "builtin", "package"] as const;
const sourceLabels = {
	project: "Project agents",
	user: "User agents",
	builtin: "Built-in agents",
	package: "Package agents",
};
const clean = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f]/g, " ");

/** Read-only catalog. Browsing a definition never launches or changes an agent. */
export class AgentBrowser implements Component, Focusable {
	private readonly search = new Input({ prompt: "Search: ", placeholder: "name, role, or source" });
	private index = 0;
	private detail = false;
	private scroll = 0;
	private readonly agents: AgentConfig[];
	get focused(): boolean {
		return this.search.focused;
	}
	set focused(value: boolean) {
		this.search.focused = value;
	}
	constructor(
		agents: readonly AgentConfig[],
		private readonly theme: Theme,
		private readonly close: () => void,
		private readonly height: () => number,
		query = "",
	) {
		this.agents = sources.flatMap((source) =>
			agents.filter((agent) => agent.source === source).sort((a, b) => a.name.localeCompare(b.name)),
		);
		this.search.setValue(query);
		this.search.handleInput("\x05");
	}
	invalidate(): void {}
	private matches(): AgentConfig[] {
		const query = this.search.getValue().toLowerCase().trim();
		return this.agents.filter((agent) =>
			`${agent.name} ${agent.description} ${agent.source}${agent.packageOrigin ? ` ${agent.packageOrigin.source}` : ""}`
				.toLowerCase()
				.includes(query),
		);
	}
	handleInput(data: string): boolean {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			if (this.detail) {
				this.detail = false;
				this.scroll = 0;
			} else this.close();
			return true;
		}
		if (this.detail) {
			if (matchesKey(data, "up")) this.scroll = Math.max(0, this.scroll - 1);
			else if (matchesKey(data, "down")) this.scroll++;
			else if (matchesKey(data, "pageDown")) this.scroll += 10;
			else if (matchesKey(data, "pageUp")) this.scroll = Math.max(0, this.scroll - 10);
			else if (matchesKey(data, "enter")) {
				this.detail = false;
				this.scroll = 0;
			}
			return true;
		}
		const agents = this.matches();
		if (matchesKey(data, "up")) this.index = Math.max(0, this.index - 1);
		else if (matchesKey(data, "down")) this.index = Math.min(Math.max(0, agents.length - 1), this.index + 1);
		else if (matchesKey(data, "enter")) this.detail = agents.length > 0;
		else {
			this.search.handleInput(data);
			this.index = 0;
		}
		return true;
	}
	render(width: number): string[] {
		const theme = this.theme;
		const budget = Math.max(4, this.height() - 6);
		const framed = width >= 24 && budget >= 7;
		const inner = Math.max(1, width - (framed ? 4 : 0));
		const agents = this.matches();
		const agent = agents[this.index];
		const title = this.detail && agent ? agent.name : "Agents";
		const heading = theme.bold(truncateToWidth(clean(title), Math.max(1, width - 6)));
		const top =
			theme.fg("borderMuted", "╭─ ") +
			heading +
			theme.fg("borderMuted", ` ${"─".repeat(Math.max(0, width - visibleWidth(heading) - 5))}╮`);
		const body: string[] = [];
		let selectedRow = 0;
		if (this.detail && agent) {
			const section = (label: string, value: string) => {
				body.push("", theme.fg("muted", theme.bold(label)), ...wrapTextWithAnsi(clean(value), inner));
			};
			body.push(
				theme.fg(
					"dim",
					`${sourceLabels[agent.source]}${agent.packageOrigin ? ` · ${agent.packageOrigin.source}` : ""} · ${agent.defaultContext ?? "fresh"} context`,
				),
			);
			section("Description", agent.description || "No description provided.");
			section("Model", agent.model ?? "Inherits the current model");
			if (agent.fallbackModels?.length) section("Fallbacks", agent.fallbackModels.join(" → "));
			section("Tools", agent.tools ? agent.tools.join(", ") || "None" : "Inherited tools");
			if (agent.skills?.length) section("Skills", agent.skills.join(", "));
			section("Definition", agent.filePath);
			section("System prompt", agent.systemPrompt || "No additional system prompt.");
		} else {
			if (!agents.length)
				body.push(theme.fg("muted", "No matching agents."), theme.fg("dim", "Try a name, role, or source."));
			for (const source of sources) {
				const group = agents.filter((agent) => agent.source === source);
				if (!group.length) continue;
				body.push(theme.fg("muted", theme.bold(`${sourceLabels[source]} (${group.length})`)));
				for (const item of group) {
					const selected = item === agent;
					if (selected) selectedRow = body.length;
					const name = `${selected ? "›" : " "} ${clean(item.name)}`;
					body.push(selected ? theme.fg("accent", theme.bold(name)) : name);
					if (selected) body.push(theme.fg("muted", `  ${clean(item.description)}`));
				}
				body.push("");
			}
		}
		const pinned = this.detail ? [] : this.search.render(inner);
		const room = Math.max(1, budget - (framed ? 3 : 2) - pinned.length);
		this.scroll = Math.min(this.scroll, Math.max(0, body.length - room));
		const offset = this.detail ? this.scroll : Math.max(0, selectedRow - room + Math.min(2, room));
		const rows = [...pinned, ...body.slice(offset, offset + room)].map((line) => {
			const text = truncateToWidth(line, inner);
			if (!framed) return text;
			return (
				theme.fg("borderMuted", "│ ") +
				text +
				" ".repeat(Math.max(0, inner - visibleWidth(text))) +
				theme.fg("borderMuted", " │")
			);
		});
		const hint = this.detail
			? "↑↓ scroll · Enter / Esc back"
			: "Type to filter · ↑↓ select · Enter details · Esc close";
		return [
			framed ? top : heading,
			...rows,
			...(framed ? [theme.fg("borderMuted", `╰${"─".repeat(Math.max(0, width - 2))}╯`)] : []),
			theme.fg("dim", clickableHintText(hint)),
		].map((line) => truncateToWidth(line, width));
	}
}

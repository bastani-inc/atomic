#!/usr/bin/env node
// Generate the root README badge region, all checked-in SVG badges, and their
// attribution record from manifest.json. No network access or package is used.
//
//   node scripts/readme-badges/generate.mjs
//   node scripts/readme-badges/generate.mjs --check
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const MANIFEST = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const README_PATH = join(REPO, "README.md");
const ASSET_ROOT = join(REPO, "assets", "readme-badges");
const START = "<!-- readme-badges:start -->";
const END = "<!-- readme-badges:end -->";
const LEGACY_HEADING = "### Works with your engineering stack";

const escapeXml = (value) =>
	String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const labelWidth = (label) => {
	let width = 0;
	for (const character of label) {
		if (/[ilI1.]/.test(character)) width += 3.2;
		else if (/[MW@]/.test(character)) width += 9;
		else if (/[A-Z0-9]/.test(character)) width += 7;
		else width += 6.1;
	}
	return Math.max(52, Math.ceil(36 + width));
};

const renderIcon = (icon) => {
	if (icon.kind === "monogram") {
		const fontSize = icon.monogram.length >= 3 ? 5.5 : icon.monogram.length === 2 ? 7 : 9;
		return [
			'<g class="badge-icon">',
			'<rect x="3" y="3" width="14" height="14" rx="3" fill="#313244" stroke="#585b70"/>',
			`<text x="10" y="12.5" text-anchor="middle" fill="#cdd6f4" font-family="Verdana,DejaVu Sans,sans-serif" font-size="${fontSize}" font-weight="700">${escapeXml(icon.monogram)}</text>`,
			"</g>",
		].join("");
	}
	if (icon.kind !== "vector" || !icon.viewBox || !icon.markup) throw new Error("badge icon has no vector geometry");
	const markup = icon.tint
		? icon.markup.replace(/fill=(['"])(?:black|#000(?:000)?|#1a1a1a)\1/gi, 'fill="currentColor"')
		: icon.markup;
	return `<svg class="badge-icon" x="3" y="3" width="14" height="14" viewBox="${escapeXml(icon.viewBox)}" preserveAspectRatio="xMidYMid meet" color="${icon.color ?? MANIFEST.style.icon}" fill="${icon.color ?? MANIFEST.style.icon}">${markup}</svg>`;
};

const renderBadge = (group, entry) => {
	const icon = MANIFEST.icons[entry.icon];
	if (!icon) throw new Error(`${group.id}/${entry.slug}: unknown icon ${entry.icon}`);
	const width = labelWidth(entry.label);
	return [
		`<svg xmlns="http://www.w3.org/2000/svg" role="img" aria-labelledby="title" width="${width}" height="${MANIFEST.style.height}" viewBox="0 0 ${width} ${MANIFEST.style.height}">`,
		`<title id="title">${escapeXml(entry.label)}</title>`,
		`<rect width="${width}" height="${MANIFEST.style.height}" fill="${MANIFEST.style.background}"/>`,
		renderIcon(icon),
		`<text class="badge-label" x="22" y="14" fill="${MANIFEST.style.text}" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11">${escapeXml(entry.label)}</text>`,
		"</svg>",
		"",
	].join("\n");
};

const groupMarkup = (group) =>
	[
		group.heading,
		"",
		'<p align="center">',
		...group.entries.map(
			(entry) => `  <a href="${entry.href}"><img src="${entry.path}" alt="${escapeXml(entry.alt)}"></a>`,
		),
		"</p>",
	].join("\n");

const [stack, providers, local] = MANIFEST.groups;
const readmeRegion = [
	START,
	"",
	groupMarkup(stack),
	"",
	"Atomic connects through installed CLIs, MCP servers, APIs, scripts, and custom extensions; you supply the credentials and permissions.",
	"",
	groupMarkup(providers),
	"",
	"See [provider setup and the current catalog](https://docs.bastani.ai/providers). Availability depends on your credentials, subscription, region, and the provider catalog; one login does not unlock every provider.",
	"",
	groupMarkup(local),
	"",
	"Atomic can run tool-capable models exposed through llama.cpp, Ollama, LM Studio, vLLM, SGLang, Hugging Face, or a compatible OpenAI, Anthropic, or Google endpoint. Actual model and tool support depends on the server and model.",
	"",
	"The model-family badges are representative open families, not a closed allowlist. See [Models](https://docs.bastani.ai/models) and [llama.cpp](https://docs.bastani.ai/llama-cpp).",
	"",
	END,
].join("\n");

const replaceReadmeRegion = (readme) => {
	const startAt = readme.indexOf(START);
	const endAt = readme.indexOf(END);
	if (startAt >= 0 || endAt >= 0) {
		if (startAt < 0 || endAt < startAt) throw new Error("README has an incomplete readme-badges marker pair");
		return readme.slice(0, startAt) + readmeRegion + readme.slice(endAt + END.length);
	}
	const legacyAt = readme.indexOf(LEGACY_HEADING);
	const separatorAt = readme.indexOf("\n---\n", legacyAt);
	if (legacyAt < 0 || separatorAt < 0) throw new Error("could not find the README badge region or legacy stack bar");
	return readme.slice(0, legacyAt) + readmeRegion + readme.slice(separatorAt);
};

const sourceLink = (icon) => icon.source.vector ?? icon.source.brand;
const sourceLabel = (icon) => {
	if (icon.source.type === "Monogram fallback" || icon.source.type === "Generic glyph") {
		return `${icon.source.type}: ${icon.source.reason}`;
	}
	return icon.source.type;
};
const attribution = [
	"# README badge sources",
	"",
	"These 62 badges are generated from `scripts/readme-badges/manifest.json`. Each SVG is checked in, self-contained, and contains local icon geometry plus visible label text. Generation performs no network fetch.",
	"",
	`Exact groups: **${stack.entries.length} engineering stack**, **${providers.entries.length} provider brands**, and **${local.entries.length} local/open entries**.`,
	"",
	"Simple Icons vectors come from the pinned `simple-icons@16.28.0` package. Simple Icons does not grant trademark rights; each brand's own rules still apply. Official vectors and every audited monogram fallback are recorded below.",
	"",
	"| Group | Badge | Geometry source | Brand/guidelines | Note |",
	"|---|---|---|---|---|",
	...MANIFEST.groups.flatMap((group) =>
		group.entries.map((entry) => {
			const icon = MANIFEST.icons[entry.icon];
			return `| ${group.id} | ${entry.label} | [${icon.source.type}](${sourceLink(icon)}) | [Brand source](${icon.source.guidelines ?? icon.source.brand}) | ${sourceLabel(icon).replaceAll("|", "\\|")} |`;
		}),
	),
	"",
	"The same brand can appear in more than one group because provider integration and representative local/open model families are separate claims. Regional or product variants collapse only where the provider contract says they share one brand badge.",
	"",
].join("\n");

const expected = new Map();
for (const group of MANIFEST.groups) {
	for (const entry of group.entries) {
		expected.set(join(REPO, entry.path), renderBadge(group, entry));
	}
}
expected.set(join(ASSET_ROOT, "README.md"), attribution);
expected.set(README_PATH, replaceReadmeRegion(readFileSync(README_PATH, "utf8")));

const actualSvgPaths = existsSync(ASSET_ROOT)
	? MANIFEST.groups.flatMap((group) => {
			const directory = join(ASSET_ROOT, group.id);
			return existsSync(directory)
				? readdirSync(directory)
						.filter((name) => name.endsWith(".svg"))
						.map((name) => join(directory, name))
				: [];
		})
	: [];
const expectedSvgPaths = new Set([...expected.keys()].filter((path) => path.endsWith(".svg")));
const extraSvgPaths = actualSvgPaths.filter((path) => !expectedSvgPaths.has(path));

if (process.argv.includes("--check")) {
	const stale = [...expected].filter(([path, content]) => !existsSync(path) || readFileSync(path, "utf8") !== content);
	if (stale.length || extraSvgPaths.length) {
		for (const [path] of stale) console.error(`stale or missing: ${path.replace(`${REPO}/`, "")}`);
		for (const path of extraSvgPaths) console.error(`unexpected generated SVG: ${path.replace(`${REPO}/`, "")}`);
		process.exit(1);
	}
	console.log(`README badge region and ${expectedSvgPaths.size} local SVG badges are up to date`);
} else {
	for (const path of extraSvgPaths) rmSync(path);
	for (const [path, content] of expected) {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}
	console.log(
		`wrote ${stack.entries.length} stack, ${providers.entries.length} provider, and ${local.entries.length} local/open README badges`,
	);
}

#!/usr/bin/env node
// Generate the README feature wall from manifest.json.
//
//   node scripts/readme-feature-wall/build-readme.mjs          write README.md
//   node scripts/readme-feature-wall/build-readme.mjs --check  fail if stale
//
// The wall is a two-column HTML table: copy, public Atomic docs, and lesson link
// on the left, with the product capture on the right as <picture> markup. The
// animated GIF is the source and the JPG poster is the <img> fallback.
//
// The generator owns the region between the two feature-wall markers and
// nothing else, so the surrounding README structure and the opening evidence
// section are never touched. On first run it replaces the "Core capabilities:"
// bullet list, which the wall exists to supersede.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const MANIFEST = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const README_PATH = join(REPO, "README.md");

const START = "<!-- feature-wall:start -->";
const END = "<!-- feature-wall:end -->";
const COURSE = MANIFEST.course.url;

const rows = MANIFEST.lessons
	.map((l) => {
		const courseLink = `${COURSE}${l.anchor}`;
		const docsLink = l.docs.url;
		return [
			"<tr>",
			'<td width="42%" valign="top">',
			`<h4>${l.title}</h4>`,
			`<p>${l.blurb}</p>`,
			`<p><a href="${docsLink}"><sub>Atomic docs · ${l.docs.label}</sub></a></p>`,
			`<p><a href="${courseLink}"><sub>Crash course · ${l.lesson}</sub></a></p>`,
			"</td>",
			'<td width="58%" valign="top">',
			`<a href="${courseLink}">`,
			"<picture>",
			`<source srcset="${l.media.gif}" type="image/gif">`,
			`<img src="${l.media.jpg}" alt="${l.alt}" width="100%">`,
			"</picture>",
			"</a>",
			"</td>",
			"</tr>",
		].join("\n");
	})
	.join("\n");

const wall = [
	START,
	"",
	"**Core capabilities** — every row is a real Atomic session, recorded from the",
	"installed product. Open the Atomic docs for reference or follow the crash course step by step.",
	"",
	"<table>",
	rows,
	"</table>",
	"",
	END,
].join("\n");

let readme = readFileSync(README_PATH, "utf8");

if (readme.includes(START) && readme.includes(END)) {
	const head = readme.slice(0, readme.indexOf(START));
	const tail = readme.slice(readme.indexOf(END) + END.length);
	readme = head + wall + tail;
} else {
	// First run: the wall replaces the Core capabilities bullet list in place.
	const bullets = /\*\*Core capabilities:\*\*\n\n(?:- \*\*[^\n]*\n)+/;
	if (!bullets.test(readme)) {
		console.error("could not find the Core capabilities bullet list to replace, and no feature-wall markers exist");
		process.exit(1);
	}
	readme = readme.replace(bullets, `${wall}\n`);
}

if (process.argv.includes("--check")) {
	const current = readFileSync(README_PATH, "utf8");
	if (current !== readme) {
		console.error("README.md feature wall is stale; run build-readme.mjs");
		process.exit(1);
	}
	console.log("README.md feature wall is up to date");
} else {
	writeFileSync(README_PATH, readme);
	console.log(`wrote ${MANIFEST.lessons.length} feature rows into README.md`);
}

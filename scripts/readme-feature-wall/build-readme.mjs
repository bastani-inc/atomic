#!/usr/bin/env node
// Generate both README feature-table regions from manifest.json.
//
//   node scripts/readme-feature-wall/build-readme.mjs          write README.md
//   node scripts/readme-feature-wall/build-readme.mjs --check  fail if either region is stale
//
// Each region is a two-column HTML table: copy, public Atomic docs, and lesson
// link on the left, with the product capture on the right as <picture> markup.
// The animated GIF is the source and the JPG poster is the <img> fallback.
//
// The generator owns only the two explicit marked regions. The first six
// manifest rows form the verifiable-runtime showcase; the other 34 follow the
// complete Get started section.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const MANIFEST = JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8"));
const README_PATH = join(REPO, "README.md");

const FEATURED_START = "<!-- feature-wall:featured:start -->";
const FEATURED_END = "<!-- feature-wall:featured:end -->";
const MORE_START = "<!-- feature-wall:more:start -->";
const MORE_END = "<!-- feature-wall:more:end -->";
const LEGACY_START = "<!-- feature-wall:start -->";
const LEGACY_END = "<!-- feature-wall:end -->";
const FEATURED_COUNT = 6;
const COURSE = MANIFEST.course.url;

const renderRows = (lessons) =>
	lessons
		.map((lesson) => {
			const courseLink = `${COURSE}${lesson.anchor}`;
			return [
				"<tr>",
				'<td width="42%" valign="top">',
				`<h4>${lesson.display_title ?? lesson.title}</h4>`,
				`<p>${lesson.blurb}</p>`,
				`<p><a href="${lesson.docs.url}"><sub>Atomic docs · ${lesson.docs.label}</sub></a></p>`,
				`<p><a href="${courseLink}"><sub>Crash course · ${lesson.lesson}</sub></a></p>`,
				"</td>",
				'<td width="58%" valign="top">',
				`<a href="${courseLink}">`,
				"<picture>",
				`<source srcset="${lesson.media.gif}" type="image/gif">`,
				`<img src="${lesson.media.jpg}" alt="${lesson.alt}" width="100%">`,
				"</picture>",
				"</a>",
				"</td>",
				"</tr>",
			].join("\n");
		})
		.join("\n");

const featuredLessons = MANIFEST.lessons.slice(0, FEATURED_COUNT);
const remainingLessons = MANIFEST.lessons.slice(FEATURED_COUNT);

const featuredRegion = [
	FEATURED_START,
	"",
	"## Atomic Verifiable Runtime",
	"",
	"Every row is a real Atomic session recorded from the installed product. Open the Atomic docs for reference or follow the crash course step by step.",
	"",
	"<table>",
	renderRows(featuredLessons),
	"</table>",
	"",
	`<p><a href="#more-atomic-capabilities"><strong>Explore ${remainingLessons.length} more Atomic capabilities ↓</strong></a></p>`,
	"",
	FEATURED_END,
].join("\n");

const moreRegion = [
	MORE_START,
	"",
	"## More Atomic capabilities",
	"",
	"Explore the rest of Atomic’s real recorded capabilities, with public docs and crash-course links for each one.",
	"",
	"<table>",
	renderRows(remainingLessons),
	"</table>",
	"",
	MORE_END,
].join("\n");

const replaceRegion = (readme, start, end, replacement) => {
	const startAt = readme.indexOf(start);
	const endAt = readme.indexOf(end);
	if (startAt === -1 || endAt === -1 || endAt < startAt) {
		throw new Error(`could not find a complete ${start} ... ${end} region`);
	}
	return readme.slice(0, startAt) + replacement + readme.slice(endAt + end.length);
};

let readme = readFileSync(README_PATH, "utf8");
const hasNewMarkers = [FEATURED_START, FEATURED_END, MORE_START, MORE_END].every((marker) => readme.includes(marker));

if (hasNewMarkers) {
	readme = replaceRegion(readme, FEATURED_START, FEATURED_END, featuredRegion);
	readme = replaceRegion(readme, MORE_START, MORE_END, moreRegion);
} else if (readme.includes(LEGACY_START) && readme.includes(LEGACY_END)) {
	readme = replaceRegion(readme, LEGACY_START, LEGACY_END, featuredRegion);
	const howAtomicWorks = "\n---\n\n## How Atomic works";
	if (!readme.includes(howAtomicWorks)) {
		console.error("could not place the remaining feature region before How Atomic works");
		process.exit(1);
	}
	readme = readme.replace(howAtomicWorks, `\n${moreRegion}\n\n---\n\n## How Atomic works`);
} else {
	console.error("could not find both feature-wall regions or the legacy feature-wall region");
	process.exit(1);
}

if (process.argv.includes("--check")) {
	const current = readFileSync(README_PATH, "utf8");
	if (current !== readme) {
		console.error("README.md feature tables are stale; run build-readme.mjs");
		process.exit(1);
	}
	console.log("README.md featured and remaining capability tables are up to date");
} else {
	writeFileSync(README_PATH, readme);
	console.log(
		`wrote ${featuredLessons.length} featured and ${remainingLessons.length} remaining feature rows into README.md`,
	);
}

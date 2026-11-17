import { readFile } from "node:fs/promises";
import { Container, Image, Spacer, Text } from "@bastani/atomic-tui";
import { getBundledInteractiveAssetPathAsync } from "../../../config.js";
import { theme } from "../theme/theme.js";
import { DynamicBorder } from "./dynamic-border.ts";

const BLOG_URL = "https://mariozechner.at/posts/2026-04-08-ive-sold-out/";
const IMAGE_FILENAME = "clankolas.png";

let announcementImage: Promise<string | undefined> | undefined;

/** The announcement image, read once; undefined when the bundled asset cannot be read. */
export function loadEarendilAnnouncementImage(): Promise<string | undefined> {
	announcementImage ??= getBundledInteractiveAssetPathAsync(IMAGE_FILENAME)
		.then((path) => readFile(path))
		.then(
			(bytes) => bytes.toString("base64"),
			() => undefined,
		);
	return announcementImage;
}

export class EarendilAnnouncementComponent extends Container {
	constructor(imageBase64?: string) {
		super();

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
		this.addChild(new Text(theme.bold(theme.fg("accent", "pi has joined Earendil")), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("muted", "Read the blog post:"), 1, 0));
		this.addChild(new Text(theme.fg("mdLink", BLOG_URL), 1, 0));
		this.addChild(new Spacer(1));

		if (imageBase64) {
			this.addChild(
				new Image(
					imageBase64,
					"image/png",
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: 56, filename: IMAGE_FILENAME },
				),
			);
			this.addChild(new Spacer(1));
		}

		this.addChild(new DynamicBorder((text) => theme.fg("accent", text)));
	}
}

import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { getMarkdownTheme, theme } from "../theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

const FILE_TAG_PATTERN = /<file(?=[\s>/])([^>]*)>([\s\S]*?)<\/file>/giu;
const FILE_TAG_NAME_ATTRIBUTE_PATTERN = /\bname\s*=\s*(?:"([^"]*)"|'([^']*)')/iu;
const IMAGE_FILE_TAG_BODY_PATTERN = /^\[(?:Image:|Image omitted:)[^\r\n]*\]$/u;

function decodeFileNameAttribute(value: string): string {
	return value.replace(/&(#x[0-9a-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (entity, body: string) => {
		const key = body.toLowerCase();
		if (key.startsWith("#x")) {
			const codePoint = Number.parseInt(key.slice(2), 16);
			return Number.isInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
		}
		if (key.startsWith("#")) {
			const codePoint = Number.parseInt(key.slice(1), 10);
			return Number.isInteger(codePoint) && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
		}
		const namedEntities: Record<string, string> = {
			amp: "&",
			quot: '"',
			apos: "'",
			lt: "<",
			gt: ">",
		};
		return namedEntities[key] ?? entity;
	});
}

function imageFileTagLabel(attrs: string, body: string): string | undefined {
	const bodyText = body.trim();
	if (bodyText !== "" && !IMAGE_FILE_TAG_BODY_PATTERN.test(bodyText)) return undefined;

	const nameMatch = FILE_TAG_NAME_ATTRIBUTE_PATTERN.exec(attrs);
	const rawFilePath = nameMatch?.[1] ?? nameMatch?.[2];
	if (!rawFilePath) return undefined;

	const filePath = decodeFileNameAttribute(rawFilePath);
	const fileName = filePath.split(/[\\/]/u).pop() || filePath;
	return `Attached image: ${fileName}`;
}

export function formatUserMessageForDisplay(text: string): string {
	return text.replace(FILE_TAG_PATTERN, (match, attrs: string, body: string) => {
		return imageFileTagLabel(attrs, body) ?? match;
	});
}

/**
 * Component that renders a user message
 */
export class UserMessageComponent extends Container {
	private contentBox: Box;

	constructor(text: string, markdownTheme: MarkdownTheme = getMarkdownTheme()) {
		super();
		const displayText = formatUserMessageForDisplay(text);
		this.contentBox = new Box(1, 1, (content: string) => theme.bg("userMessageBg", content));
		this.contentBox.addChild(
			new Markdown(
				displayText,
				0,
				0,
				markdownTheme,
				{
					color: (content: string) => theme.fg("userMessageText", content),
				},
				{ preserveOrderedListMarkers: true },
			),
		);
		this.addChild(this.contentBox);
	}

	override render(width: number): string[] {
		const lines = super.render(width);
		if (lines.length === 0) {
			return lines;
		}

		lines[0] = OSC133_ZONE_START + lines[0];
		lines[lines.length - 1] = OSC133_ZONE_END + OSC133_ZONE_FINAL + lines[lines.length - 1];
		return lines;
	}
}

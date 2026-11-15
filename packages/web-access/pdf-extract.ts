/**
 * PDF Content Extractor
 * 
 * Extracts text from PDF files and saves to markdown.
 * Uses unpdf (pdfjs-dist wrapper) for text extraction.
 */

import { getDocumentProxy } from "unpdf";
import { writeFile, mkdir } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { homedir } from "node:os";

export interface PDFExtractResult {
  title: string;
  pages: number;
  chars: number;
  outputPath: string;
}

export interface PDFExtractOptions {
  maxPages?: number;
  outputDir?: string;
  filename?: string;
}

const DEFAULT_MAX_PAGES = 100;
/** pdf.js `VerbosityLevel.ERRORS`: suppresses warnings and info output. */
const PDF_JS_VERBOSITY_ERRORS = 0;
/** UTF-8 budget for the sanitised stem, leaving room for a `-N` suffix and `.md` within the 255-byte name limit. */
const MAX_FILENAME_STEM_BYTES = 200;
const MAX_FILENAME_STEM_CHARS = 100;

/**
 * Extract text from a PDF buffer and save to markdown file
 */
export async function extractPDFToMarkdown(
  buffer: ArrayBuffer,
  url: string,
  options: PDFExtractOptions = {}
): Promise<PDFExtractResult> {
  const {
    maxPages = DEFAULT_MAX_PAGES,
    outputDir = join(homedir(), "Downloads"),
    filename,
  } = options;

  const safeMaxPages = Number.isFinite(maxPages)
    ? Math.max(1, Math.floor(maxPages))
    : DEFAULT_MAX_PAGES;

  // pdf.js prints font warnings (e.g. "TT: undefined function: 32") straight to the console, which
  // corrupts the interactive TUI. Keep only errors; failures still reject the promise.
  const pdf = await getDocumentProxy(new Uint8Array(buffer), { verbosity: PDF_JS_VERBOSITY_ERRORS });
  const metadata = await pdf.getMetadata();
  const metadataInfo = metadata.info && typeof metadata.info === "object"
    ? metadata.info as Record<string, unknown>
    : null;

  // Extract title from metadata or URL
  const metaTitle = typeof metadataInfo?.Title === "string" ? metadataInfo.Title : undefined;
  const metaAuthor = typeof metadataInfo?.Author === "string" ? metadataInfo.Author : undefined;
  const urlTitle = extractTitleFromURL(url);
  const title = metaTitle?.trim() || urlTitle;

  // Determine pages to extract
  const pagesToExtract = Math.min(pdf.numPages, safeMaxPages);
  const truncated = pdf.numPages > safeMaxPages;

  // Extract text page by page for better structure
  const pages: { pageNum: number; text: string }[] = [];
  for (let i = 1; i <= pagesToExtract; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: unknown) => {
        const textItem = item as { str?: string };
        return textItem.str || "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    
    if (pageText) {
      pages.push({ pageNum: i, text: pageText });
    }
  }

  // Build markdown content
  const lines: string[] = [];
  
  // Header with metadata
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`> Source: ${url}`);
  lines.push(`> Pages: ${pdf.numPages}${truncated ? ` (extracted first ${pagesToExtract})` : ""}`);
  if (metaAuthor) {
    lines.push(`> Author: ${metaAuthor}`);
  }
  lines.push("");
  lines.push("---");
  lines.push("");

  // Content with page markers
  for (let i = 0; i < pages.length; i++) {
    if (i > 0) {
      lines.push("");
      lines.push(`<!-- Page ${pages[i].pageNum} -->`);
      lines.push("");
    }
    lines.push(pages[i].text);
  }

  if (truncated) {
    lines.push("");
    lines.push("---");
    lines.push("");
    lines.push(`*[Truncated: Only first ${pagesToExtract} of ${pdf.numPages} pages extracted]*`);
  }

  const content = lines.join("\n");

  const extension = filename ? extname(filename) : ".md";
  const stem = filename ? filename.slice(0, filename.length - extension.length) : sanitizeFilename(title);

  await mkdir(outputDir, { recursive: true });
  const outputPath = await writeNewFile(outputDir, stem, extension, content);

  return {
    title,
    pages: pdf.numPages,
    chars: content.length,
    outputPath,
  };
}

/**
 * Extract a reasonable title from URL
 */
function extractTitleFromURL(url: string): string {
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Get filename without extension
    let filename = basename(pathname, ".pdf");
    
    // Handle arxiv URLs: /pdf/1706.03762 → "arxiv-1706.03762"
    if (urlObj.hostname === "arxiv.org" || urlObj.hostname.endsWith(".arxiv.org")) {
      const match = pathname.match(/\/(?:pdf|abs)\/(\d+\.\d+)/);
      if (match) {
        filename = `arxiv-${match[1]}`;
      }
    }
    
    // Clean up filename
    filename = filename
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    
    return filename || "document";
  } catch {
    return "document";
  }
}

/**
 * Write `content` to a file that did not exist before: `<stem><ext>`, then `<stem>-2<ext>`, and so on.
 * Exclusive creation means an existing file, or one another extraction just claimed, is never overwritten.
 */
async function writeNewFile(dir: string, stem: string, extension: string, content: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    const path = join(dir, attempt === 1 ? `${stem}${extension}` : `${stem}-${attempt}${extension}`);
    try {
      await writeFile(path, content, { flag: "wx" });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
}

const WINDOWS_RESERVED_NAME = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(\.|$)/i;

/**
 * Turn a title into a file name stem. Letters in any script are kept; only characters that are
 * unsafe in paths on some platform (separators, `<>:"|?*`, control characters) are removed.
 */
function sanitizeFilename(name: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[<>:"/\\|?*\p{Cc}]/gu, "")
    .replace(/[\s-]+/g, "-")
    .replace(/^[-.]+/, "");
  let stem = "";
  let bytes = 0;
  let chars = 0;
  for (const char of cleaned) {
    bytes += Buffer.byteLength(char);
    if (bytes > MAX_FILENAME_STEM_BYTES || ++chars > MAX_FILENAME_STEM_CHARS) break;
    stem += char;
  }
  stem = stem.replace(/[-.]+$/, "");
  if (!stem) return "document";
  return WINDOWS_RESERVED_NAME.test(stem) ? `${stem}-document` : stem;
}

/**
 * Check if URL or content-type indicates a PDF
 */
export function isPDF(url: string, contentType?: string): boolean {
  if (contentType?.includes("application/pdf")) {
    return true;
  }
  try {
    const urlObj = new URL(url);
    return urlObj.pathname.toLowerCase().endsWith(".pdf");
  } catch {
    return false;
  }
}

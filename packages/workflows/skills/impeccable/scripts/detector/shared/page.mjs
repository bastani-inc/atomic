/** Remove complete script/style elements and comments without regex-based HTML sanitization. */
function stripHtmlBlocks(content, tagNames = []) {
  let out = String(content);
  for (const tagName of tagNames) {
    const opener = `<${tagName}`;
    const closer = `</${tagName}`;
    while (true) {
      const lower = out.toLowerCase();
      const start = lower.indexOf(opener);
      if (start === -1) break;
      const openEnd = lower.indexOf('>', start + opener.length);
      const closeStart = openEnd === -1 ? -1 : lower.indexOf(closer, openEnd + 1);
      const closeEnd = closeStart === -1 ? -1 : lower.indexOf('>', closeStart + closer.length);
      if (openEnd === -1 || closeStart === -1 || closeEnd === -1) break;
      out = out.slice(0, start) + ' ' + out.slice(closeEnd + 1);
    }
  }
  while (true) {
    const start = out.indexOf('<!--');
    if (start === -1) break;
    const normalEnd = out.indexOf('-->', start + 4);
    const bangEnd = out.indexOf('--!>', start + 4);
    const end = normalEnd === -1 ? bangEnd : bangEnd === -1 ? normalEnd : Math.min(normalEnd, bangEnd);
    if (end === -1) break;
    out = out.slice(0, start) + out.slice(end + (end === bangEnd ? 4 : 3));
  }
  return out;
}

/** Check if content looks like a full page (not a component/partial) */
function isFullPage(content) {
  return /<!doctype\s|<html[\s>]|<head[\s>]/i.test(stripHtmlBlocks(content));
}

export { isFullPage, stripHtmlBlocks };

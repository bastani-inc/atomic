/** Check if content looks like a full page (not a component/partial) */
function isFullPage(content) {
  // Strip comments to a fixpoint so nested/overlapping comment markers cannot
  // survive a single pass (CodeQL: complete sanitization).
  let stripped = String(content);
  let prev;
  do {
    prev = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, '');
  } while (stripped !== prev);
  return /<!doctype\s|<html[\s>]|<head[\s>]/i.test(stripped);
}

export { isFullPage };

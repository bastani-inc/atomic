/** Check if content looks like a full page (not a component/partial) */
function isFullPage(content) {
  let stripped = String(content || '');
  let previous;
  do {
    previous = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, '');
  } while (stripped !== previous);
  return /<!doctype\s|<html[\s>]|<head[\s>]/i.test(stripped);
}

export { isFullPage };

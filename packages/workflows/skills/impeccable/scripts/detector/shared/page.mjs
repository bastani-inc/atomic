/** Check if content looks like a full page (not a component/partial) */
function isFullPage(content) {
  // Strip comments until stable so a nested/overlapping <!-- ... --> cannot
  // survive a single pass (incomplete multi-character sanitization).
  let stripped = content;
  let prevStripped;
  do {
    prevStripped = stripped;
    stripped = stripped.replace(/<!--[\s\S]*?-->/g, '');
  } while (stripped !== prevStripped);
  return /<!doctype\s|<html[\s>]|<head[\s>]/i.test(stripped);
}

export { isFullPage };

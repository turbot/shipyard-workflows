'use strict';

// Text from outside (a PR title, a check's name, a login) made safe for a table cell, a list
// item or a sentence in the release PR's body. Shared by the cut's body and the audit record.

const { SECRET_PATTERNS } = require('./changelog-line');

const hasSecret = (text) => SECRET_PATTERNS.some(([, re]) => re.test(text));

// One line, no control characters, no secret pattern, no markup that a table or the page could
// read as syntax (a `#` is written out, so a title's "Closes #1" never closes an issue from the
// release PR), and a length cap.
function clean(value, max = 120) {
  let text = String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (hasSecret(text)) text = '(redacted)';
  if ([...text].length > max) text = `${[...text].slice(0, max - 1).join('')}…`;
  return text.replace(/[\\|`<>[\]*_~#&]/g, (c) => `&#${c.charCodeAt(0)};`);
}

module.exports = { clean, hasSecret };

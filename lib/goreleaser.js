'use strict';

// The archive file name a Go CLI's goreleaser file makes, in the pattern `shipyard homebrew --archive` takes (lib/homebrew.js):
// `{name}`, `{os}`, `{arch}` and `{version}` where goreleaser's `{{ .ProjectName }}`, `{{ .Os }}`, `{{ .Arch }}` and
// `{{ .Version }}` go, and the extension (`tar.gz`, `zip`, or `{ext}` where the file's `format_overrides` give some platforms the
// other one). Pure: the text of the file in, a pattern or a reason out. The file is read as data and never run.
//
// Only `archives[0]` of the kind goreleaser makes an archive of (not `format: binary`) is read, and only its `name_template` and
// formats: a template that holds anything else (a condition, `.Arm`, a function) is a reason, and so is a template whose Os is
// not goreleaser's lower-case `darwin` and `linux` (`{{ title .Os }}`). goreleaser's own default template is Title-cased
// (`Darwin`, `x86_64`), which a formula cannot name, so a file that sets none is a reason too: the repo sets `name_template`, or
// `homebrew.archive` in `.github/shipyard.yml`.

const { parseYaml } = require('./contract');

const FILE = '.goreleaser.yml';
const FORMATS = ['tar.gz', 'zip'];
// A template's own words, each the pattern's word of the same meaning.
const WORDS = Object.freeze({ Os: '{os}', Arch: '{arch}', Version: '{version}' });
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const isMap = (v) => v instanceof Map;
const one = (s) => String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').slice(0, 60);

/**
 * @param {string|null|undefined} text  the goreleaser file's text, or nothing when the repo has none
 * @returns {{archive: string|null, why: string|null}}  `archive` null and `why` null: nothing to derive from (no file, or no
 *   archive section), so the formula's own default stands; `why` a sentence naming what could not be read and the way out
 */
function archiveOfGoreleaser(text) {
  if (typeof text !== 'string' || !text.trim()) return { archive: null, why: null };
  const out = (why) => ({ archive: null, why: `${FILE} ${why}: set homebrew.archive in .github/shipyard.yml to the archive's file name, such as "{name}_{os}_{arch}.tar.gz".` });
  let doc;
  try {
    doc = parseYaml(text, FILE);
  } catch (e) {
    return out(`is not YAML Shipyard can read (${one(e.message)})`);
  }
  const archives = doc.get('archives');
  if (archives === undefined || archives === null) return { archive: null, why: null };
  // goreleaser v2 may spell the section as a map (`archives:` as one entry); a list is the usual spelling.
  const entries = (Array.isArray(archives) ? archives : [archives]).filter((a) => isMap(a) && a.get('format') !== 'binary');
  if (!entries.length) return { archive: null, why: null };
  const entry = entries[0];
  const template = entry.get('name_template');
  if (typeof template !== 'string' || !template.trim()) {
    return out('sets no name_template for its archive, so the files are named by goreleaser\'s default (Title-case Darwin, x86_64), which the formula cannot use');
  }

  const project = doc.get('project_name');
  const name = typeof project === 'string' && PROJECT.test(project) ? project : '{name}';
  let bad = null;
  const stem = template.trim().replace(/\{\{-?\s*([^{}]*?)\s*-?\}\}/g, (all, body) => {
    const m = /^\.(\w+)$/.exec(body);
    if (m && m[1] === 'ProjectName') return name;
    if (m && Object.hasOwn(WORDS, m[1])) return WORDS[m[1]];
    bad = bad || all;
    return '';
  });
  if (bad) return out(`makes its archive's name with ${one(bad)}, which Shipyard cannot map to a file name (it reads .ProjectName, .Os, .Arch and .Version)`);
  if (!stem.includes('{os}') || !stem.includes('{arch}')) return out('makes an archive name with no Os and Arch');
  if (!/^[A-Za-z0-9._{}@+=~-]{1,200}$/.test(stem)) return out(`makes the archive name ${JSON.stringify(one(stem))}, which holds a character a file name here does not`);

  // The extensions the platforms get: the file's format, and any a platform's override gives. Both of the two known ones are `{ext}`.
  const own = entry.get('formats');
  const base = Array.isArray(own) && own.length ? own[0] : (entry.get('format') ?? 'tar.gz');
  const formats = new Set([base]);
  const overrides = entry.get('format_overrides');
  if (Array.isArray(overrides)) {
    for (const o of overrides) {
      if (!isMap(o)) continue;
      const f = Array.isArray(o.get('formats')) && o.get('formats').length ? o.get('formats')[0] : o.get('format');
      if (f !== undefined) formats.add(f);
    }
  }
  if (![...formats].every((f) => FORMATS.includes(f))) return out(`makes archives of the format ${[...formats].map(one).join(', ')}, and the formula takes tar.gz or zip`);
  const ext = formats.size === 1 ? [...formats][0] : '{ext}';
  return { archive: `${stem}.${ext}`, why: null };
}

module.exports = { archiveOfGoreleaser, FILE };

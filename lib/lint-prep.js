'use strict';

// The rules for a prep file, checked against the facts of its range. Pure: no network and
// no files. The command (lint-prep-command.js) reads both files.
//
// A problem never repeats the text it matched: the log of a public repo is public, and the
// match may be the very internal term, private link or path the rule keeps out.

const { validate, assertSupported } = require('./prep-schema');

const GROUPS = ['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Internal'];
const REPORT_MAX_WORDS = 300;

class LintError extends Error {}

// The facts fields lint-prep reads (S3's facts.json holds more; the rest is ignored).
const REPO_NAME = { type: 'string', pattern: '^[^/\\s]+/[^/\\s]+$' };
const TEXT = { type: 'string', pattern: '\\S' };
const FACTS_SCHEMA = {
  type: 'object',
  required: ['repo', 'prs', 'flags', 'internalTerms'],
  properties: {
    repo: {
      type: 'object',
      required: ['name', 'private'],
      properties: { name: REPO_NAME, private: { type: 'boolean' } },
    },
    prs: {
      type: 'array',
      items: { type: 'object', required: ['number'], properties: { number: { type: 'integer', minimum: 1 } } },
    },
    flags: {
      type: 'array',
      items: { type: 'object', required: ['id'], properties: { id: TEXT } },
    },
    internalTerms: { type: 'array', items: TEXT },
    publicRepos: { type: 'array', items: REPO_NAME },
    privateHosts: { type: 'array', items: TEXT },
  },
};
assertSupported(FACTS_SCHEMA);

// Throws a LintError naming every problem when the facts lack what the lint reads.
function checkFacts(facts) {
  const problems = validate(facts, FACTS_SCHEMA);
  if (problems.length) {
    throw new LintError(`the facts cannot be used: ${problems.map((p) => `${p.at} ${p.message}`).join('; ')}`);
  }
  return facts;
}

// ---------------------------------------------------------------------------
// Release-notes text

// github.com/<first segment> that is a public page, not an owner.
const GITHUB_PAGES = new Set([
  'about', 'advisories', 'apps', 'collections', 'community', 'contact', 'customer-stories',
  'enterprise', 'events', 'explore', 'features', 'git-guides', 'marketplace', 'pricing',
  'readme', 'resources', 'security', 'site', 'solutions', 'sponsors', 'topics', 'trending',
]);

// Hosts whose pages are behind a login or inside a network, never for the public.
const PRIVATE_HOST_SUFFIXES = [
  'localhost', 'local', 'internal', 'intranet', 'corp', 'lan', 'home.arpa',
  'slack.com', 'claude.ai', 'docs.google.com', 'drive.google.com', 'notion.so',
  'linear.app', 'atlassian.net', 'figma.com', 'gist.github.com',
];

// A link with any scheme (https://, ftp://, file://), or one that starts www. or github.com/.
const URL_TAIL = '[^\\s<>()[\\]"\'`\\u2018\\u2019\\u201c\\u201d]';
const URL_RE = new RegExp(
  `\\b[a-z][a-z0-9+.-]*:\\/\\/\\[[0-9a-f:.]+\\]${URL_TAIL}*|(?:\\b[a-z][a-z0-9+.-]*:\\/\\/|\\bwww\\.|(?<![\\w.-])github\\.com\\/)${URL_TAIL}+`,
  'gi',
);

// Prose splits into words at anything a path or a host does not hold: spaces, brackets,
// quotes (straight or curly), dashes, ellipses, commas.
const WORD_SPLIT = /[^A-Za-z0-9_.\/\\:~@%+=?#&*${}-]+/;

const FILE_EXTENSIONS = new Set([
  'js', 'cjs', 'mjs', 'ts', 'tsx', 'jsx', 'json', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf',
  'env', 'md', 'go', 'py', 'rb', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'php',
  'sh', 'bash', 'zsh', 'ps1', 'sql', 'tf', 'hcl', 'lock', 'xml', 'html', 'css', 'scss', 'vue',
  'svelte', 'proto', 'txt', 'log', 'csv', 'spc', 'ipynb', 'pp', 'fp', 'sp', 'mod', 'sum',
]);

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

const hostIs = (host, domain) => host === domain || host.endsWith(`.${domain}`);

function repoKey(owner, name) {
  return `${owner}/${String(name).replace(/\.git$/i, '')}`.toLowerCase();
}

// True when the link leads somewhere the public cannot or must not go.
function isPrivateLink(raw, ctx) {
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return true; // a link nobody can read safely is not published
  }
  if (url.username || url.password) return true;
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const segments = url.pathname.split('/').filter(Boolean).map((s) => decodeURIComponentSafe(s));

  if (host === 'github.com' || host === 'www.github.com') {
    if (segments.length < 2) return false; // github.com, or a person's or org's page
    const owner = segments[0].toLowerCase();
    if (GITHUB_PAGES.has(owner)) return false;
    return !ctx.publicRepos.has(repoKey(owner, segments[1]));
  }
  if (host === 'raw.githubusercontent.com') {
    return segments.length < 2 || !ctx.publicRepos.has(repoKey(segments[0], segments[1]));
  }
  if (host === 'api.github.com') {
    return segments[0] === 'repos' && (segments.length < 3 || !ctx.publicRepos.has(repoKey(segments[1], segments[2])));
  }
  if (hostIs(host, 'githubusercontent.com')) return true; // attachments, private images
  if (IPV4.test(host)) return true; // an IP address; an IPv6 one (`[::1]`) has no dot, below
  if (!host.includes('.')) return true; // http://buildbox/, a name only a private network resolves, or [::1]
  return [...PRIVATE_HOST_SUFFIXES, ...ctx.privateHosts].some((d) => hostIs(host, d));
}

// True when a word of prose with no scheme names a private host: `team.slack.com/archives`,
// `10.0.0.5:8080`, `localhost:3000`. A bare IP-like number or `localhost` with no port or
// path is prose (a version, a word), and so is a name with no dot.
function isPrivateBareHost(word, ctx) {
  // owner/repo#12 or owner/repo@0123abc: GitHub links a cross-repo reference in a release body
  const ref = /^([\w.-]+)\/([\w.-]+)(?:#\d+|@[0-9a-f]{7,40})$/i.exec(word);
  if (ref) return !ctx.publicRepos.has(repoKey(ref[1], ref[2]));
  // git@github.com:owner/repo.git, a remote written the scp way
  const scp = /^[\w.-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+):([\w.-]+)\/([\w.-]+)$/i.exec(word);
  if (scp) return isPrivateLink(`https://${scp[1]}/${scp[2]}/${scp[3]}`, ctx);
  const m = /^([a-z0-9-]+(?:\.[a-z0-9-]+)*)(:\d+)?(\/\S*)?$/i.exec(word);
  if (!m) return false;
  const host = m[1].toLowerCase();
  const tail = Boolean(m[2] || m[3]);
  if (host === 'localhost' || IPV4.test(host)) return tail;
  if (!host.includes('.') || !/^[a-z]{2,}$/.test(host.split('.').pop())) return false;
  return isPrivateLink(`https://${word}`, ctx);
}

function decodeURIComponentSafe(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// The first folder of a source tree. None is a word a note would use in "build/deploy" or
// "test/prod"; the few that are ("internal/external", "src/dst") count only with three parts
// or a trailing slash (`internal/auth/`).
const SOURCE_ROOTS = new Set(['pkg', 'internal', 'cmd', 'src', 'lib', 'vendor', 'node_modules', 'dist', 'usr']);

// Markdown emphasis (`*`, `_`, `~~`) and closing punctuation around a word. A single `~` is
// kept: it starts a home path.
const stripMarks = (word) => word.replace(/^(?:[*_]|~~)+|(?:[*_.,:!?]|~~)+$/g, '');

// True when a word of prose is a file path or a file's name.
function isFilePath(token) {
  // `src/main.rs:42`, `server.go:42-50`, `main.rs#L42-L50`, `lib/prep.js?raw`: still a path
  const t = stripMarks(token).replace(/\?.*$/, '').replace(/(?:#L\d+(?:-L?\d+)?|(?::\d+(?:-\d+)?){1,2})$/, '');
  if (!t) return false;
  // .gitignore, .npmrc; not ".md" or ".json", which name a kind of file
  if (/^\.[a-z][\w.-]*$/.test(t)) return !FILE_EXTENSIONS.has(t.slice(1));
  if (/^(?:\.{1,2}|~|\$\{?[A-Za-z_]\w*\}?|%[A-Za-z_]\w*%)[\\/]./.test(t)) return true; // ./x, ../x, ~/x, $HOME/x, %APPDATA%\x
  if (/^\/[\w.@-]+\/[\w.@-]/.test(t)) return true; // /etc/hosts
  if (/^[A-Za-z]:[\\/]./.test(t)) return true; // C:\x, C:/x
  if (/^[\w.@-]+(?:\\[\w.@-]+)+$/.test(t)) return true; // dir\file
  const ext = (name) => {
    const m = /\.([A-Za-z0-9]+)$/.exec(name);
    return m ? m[1].toLowerCase() : null;
  };
  if (/^[\w.@-]+(?:\/[\w.@-]+)+\/?$/.test(t)) {
    const parts = t.split('/').filter(Boolean);
    if (parts.some((p) => /^\.[a-z]/.test(p))) return true; // .github/workflows, home/.config
    if (/^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}$/i.test(parts[0])) return false; // a link with no scheme: example.com/a.html
    if (FILE_EXTENSIONS.has(ext(parts[parts.length - 1]))) return true; // lib/prep.js
    // pkg/query/execute or internal/auth/: three parts, or a trailing slash, so "internal/external",
    // "src/dst", "build/deploy", "Linux/macOS/Windows" and 11/13/2026 stay prose
    return SOURCE_ROOTS.has(parts[0]) && parts.every((p) => /^[a-z0-9_.-]+$/.test(p)) && (parts.length >= 3 || t.endsWith('/'));
  }
  if (/^[\w-]+(?:\.[\w-]+)*\.[A-Za-z0-9]+$/.test(t) && FILE_EXTENSIONS.has(ext(t))) {
    // "Node.js", "Vue.js": a product's name, not a file
    return !/^[A-Z][a-z]+\.js$/.test(t);
  }
  return false;
}

function termPattern(term) {
  const escaped = term.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`, 'iu');
}

// Every string of the release notes, with where it is.
function notesTexts(notes) {
  const out = [];
  if (!notes || typeof notes !== 'object') return out;
  for (const key of ['title', 'summary']) {
    if (typeof notes[key] === 'string') out.push({ at: `notes.${key}`, text: notes[key] });
  }
  (Array.isArray(notes.sections) ? notes.sections : []).forEach((section, i) => {
    if (!section || typeof section !== 'object') return;
    if (typeof section.heading === 'string') out.push({ at: `notes.sections[${i}].heading`, text: section.heading });
    (Array.isArray(section.items) ? section.items : []).forEach((item, j) => {
      if (item && typeof item.text === 'string') out.push({ at: `notes.sections[${i}].items[${j}].text`, text: item.text });
    });
  });
  return out;
}

// Every string of the report: together, the top block of the release PR.
function reportTexts(report) {
  if (!report || typeof report !== 'object') return [];
  const out = [];
  if (typeof report.summary === 'string') out.push(report.summary);
  for (const c of Array.isArray(report.changes) ? report.changes : []) out.push(c && c.change, c && c.proof);
  for (const r of Array.isArray(report.risks) ? report.risks : []) out.push(r && r.risk, r && r.undo);
  for (const u of Array.isArray(report.untested) ? report.untested : []) out.push(u);
  return out.filter((s) => typeof s === 'string');
}

const countWords = (text) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// ---------------------------------------------------------------------------
// The lint

// Every problem with `prep` against `facts`, as `{ rule, at, message }`. `facts` must have
// passed checkFacts. An empty list is a pass.
function lintPrep(prep, facts) {
  const problems = validate(prep).map((p) => ({ rule: 'schema', ...p }));
  const add = (rule, at, message) => problems.push({ rule, at, message });
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(prep)) return problems;

  const inRange = new Set(facts.prs.map((p) => p.number));

  // Each PR in exactly one group, and only PRs in the range.
  const groupsOf = new Map();
  const groups = isObject(prep.groups) ? prep.groups : {};
  for (const group of GROUPS) {
    if (!Array.isArray(groups[group])) continue;
    groups[group].forEach((n, i) => {
      if (!Number.isInteger(n)) return; // the schema says so
      if (!inRange.has(n)) add('group-not-in-range', `groups.${group}[${i}]`, `#${n} is not a PR in the range`);
      if (!groupsOf.has(n)) groupsOf.set(n, new Set());
      groupsOf.get(n).add(group);
    });
  }
  for (const n of inRange) {
    const found = groupsOf.get(n);
    if (!found) add('pr-in-no-group', 'groups', `#${n} is in no group`);
    else if (found.size > 1) add('pr-in-two-groups', 'groups', `#${n} is in more than one group: ${[...found].join(', ')}`);
  }

  // An answer for each read-first flag, and only for those.
  const flagIds = new Set(facts.flags.map((f) => f.id));
  const answers = new Map();
  const level = isObject(prep.level) ? prep.level : {};
  (Array.isArray(level.flags) ? level.flags : []).forEach((a, i) => {
    if (!isObject(a) || typeof a.flag !== 'string') return;
    // The flag is named only once it is known to be one of the facts' own ids.
    if (!flagIds.has(a.flag)) add('flag-not-in-facts', `level.flags[${i}].flag`, 'is not a read-first flag in the facts');
    else if (answers.has(a.flag)) add('flag-answered-twice', `level.flags[${i}].flag`, `"${a.flag}" is answered more than once`);
    if (typeof a.answer === 'string' && a.answer.trim()) answers.set(a.flag, true);
  });
  for (const id of flagIds) {
    if (!answers.has(id)) add('flag-unanswered', 'level.flags', `the read-first flag "${id}" has no answer`);
  }

  // Each `covers` entry of the notes a PR in the range.
  const notes = isObject(prep.notes) ? prep.notes : {};
  (Array.isArray(notes.sections) ? notes.sections : []).forEach((section, i) => {
    (isObject(section) && Array.isArray(section.items) ? section.items : []).forEach((item, j) => {
      (isObject(item) && Array.isArray(item.covers) ? item.covers : []).forEach((n, k) => {
        if (Number.isInteger(n) && !inRange.has(n)) {
          add('covers-not-in-range', `notes.sections[${i}].items[${j}].covers[${k}]`, `#${n} is not a PR in the range`);
        }
      });
    });
  });

  // Each change of the report names PRs in the range too.
  const report = isObject(prep.report) ? prep.report : {};
  (Array.isArray(report.changes) ? report.changes : []).forEach((change, i) => {
    (isObject(change) && Array.isArray(change.covers) ? change.covers : []).forEach((n, k) => {
      if (Number.isInteger(n) && !inRange.has(n)) {
        add('covers-not-in-range', `report.changes[${i}].covers[${k}]`, `#${n} is not a PR in the range`);
      }
    });
  });

  // Release notes are public: no internal term, private link or file path.
  const ctx = {
    publicRepos: new Set([
      ...(facts.repo.private ? [] : [facts.repo.name.toLowerCase()]),
      ...(facts.publicRepos || []).map((r) => r.toLowerCase()),
    ]),
    privateHosts: (facts.privateHosts || []).map((h) => h.trim().toLowerCase()),
  };
  const terms = facts.internalTerms.map(termPattern);
  for (const { at, text } of notesTexts(notes)) {
    if (terms.some((re) => re.test(text))) add('internal-term', at, 'holds an internal term from the facts\' internalTerms');
    const links = text.match(URL_RE) || [];
    const words = text.replace(URL_RE, ' ').split(WORD_SPLIT).map(stripMarks);
    if (links.some((raw) => isPrivateLink(raw.replace(/[.,;:!?\u2014\u2013\u2026]+$/, ''), ctx)) || words.some((w) => isPrivateBareHost(w, ctx))) {
      add('private-link', at, 'holds a link to a private repo or an internal page');
    }
    if (words.some(isFilePath)) add('file-path', at, 'holds a file path or file name');
  }

  // The report's top block: 300 words or fewer.
  const words = reportTexts(prep.report).reduce((sum, t) => sum + countWords(t), 0);
  if (words > REPORT_MAX_WORDS) {
    add('report-too-long', 'report', `is ${words} words; the top block is ${REPORT_MAX_WORDS} words or fewer`);
  }

  return problems;
}

module.exports = {
  GROUPS, REPORT_MAX_WORDS, FACTS_SCHEMA, LintError,
  checkFacts, lintPrep, isPrivateLink, isPrivateBareHost, isFilePath, countWords, reportTexts,
};

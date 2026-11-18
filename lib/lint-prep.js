'use strict';

// The rules for a prep file, checked against the facts of its range. Pure: no network and
// no files. The command (lint-prep-command.js) reads both files.
//
// A problem never repeats the text it matched: the log of a public repo is public, and the
// match may be the very internal term, private link or path the rule keeps out.

const { validate, assertSupported } = require('./prep-schema');
const { describeRaise } = require('./contract');

const GROUPS = ['Added', 'Changed', 'Fixed', 'Removed', 'Security', 'Internal'];
const REPORT_MAX_WORDS = 300;

// The page a person approves reads in plain words: nothing above its folds holds a word of how Shipyard runs a
// release, in any case, as a whole word. The banned list is the issue's (#147); the public release notes are exempt,
// as their readers are the product's users. `ABOVE_FOLD_TERMS` is also checked against the tool's own fixed text.
const ABOVE_FOLD_TERMS = [
  'ship', 'hold', 'level', 'major', 'minor', 'patch', 'drove', 'independent', 'second approver', 'record', 'prep', 'facts',
  'cut', 'ship job', 'ship jobs', 'tag', 'merge back', 'digest', 'digests', 'job', 'jobs', 'run', 'workflow', 'workflows', 'step',
  'artifact', 'artifacts', 'input', 'pin', 'evidence', 'not judged', 'made or asked for', 'today',
];
// The words the safety answer may start with: the answer first.
const ANSWER_WORDS = ['no', 'not', 'unlikely', 'yes', 'likely', 'possibly', 'maybe', 'only', 'rarely', 'hardly'];
const HEADLINE_MAX_WORDS = 8;
// The safety answer, its line of why, each internal change and each change's label, in words.
const SAFETY_ANSWER_MAX_WORDS = 4;
const SAFETY_WHY_MAX_WORDS = 25;
const INTERNAL_MAX_WORDS = 12;
const LABEL_WORDS = [2, 4];
const ITEM_NAME_WORDS = [2, 4];
const ITEM_TEXT_MAX = 120;
// The notes section whose items are steps for the reader, not highlights, so they have no names. The post says
// "Before you update"; the handbook's heading for the same section, "Before you upgrade", is the same section.
const BEFORE_YOU_UPDATE = 'Before you update';
const isBeforeYouUpdate = (heading) => typeof heading === 'string' && /^before you (?:update|upgrade)$/i.test(heading.trim());
// The top of the release PR's page as it renders: lines (a table's alignment row and a blank line are not lines a
// reader sees), the words of a paragraph or a bullet, and the words of a table cell.
const TOP_MAX_LINES = 25;
const PARAGRAPH_MAX_WORDS = 25;
const CELL_MAX_WORDS = 15;

// What else is not plain words above the folds: a PR or issue number, a commit, an HTML code such as `&#35;`, a
// config key (`report.prodPlan`, `tagPrefix`, `fleet_logins`) or code in backticks. A file path is `isFilePath`.
const NOT_PLAIN = [
  ['pr-number', /(?:^|[^\w&])#\d+\b/, 'a PR or issue number'],
  ['commit', /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b/, 'a commit'],
  ['html-code', /&#?[A-Za-z0-9]+;/, 'an HTML code'],
  ['config-key', /`[^`]+`|(?<![\w.])(?:[a-z][a-z0-9]*[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]+(?:_[a-z0-9]+)+|[a-z][a-z0-9]+(?:\.[a-z][A-Za-z0-9]+)+)(?![\w])/, 'a config key or code'],
];

class LintError extends Error {}

const FORMAT_1_MESSAGE = 'is 1, which this Shipyard no longer reads: write format 2. The report now holds headline (8 words or fewer), '
  + 'changes with before, after, label and covers, safety with answer and why, risks with if, then and an optional untested, '
  + 'undo with how and howLong, internal with text and covers for the changes no user sees, and managerNotes. summary and each change\'s change and proof are gone. '
  + 'See docs/prep-file.md';

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
    // What a later release asks of callers that the range's start did not (lib/contract.js). Only a repo that
    // publishes workflows with a contract has it.
    callerNeeds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['workflow', 'kind', 'name'],
        properties: {
          workflow: TEXT,
          kind: { enum: ['permission', 'input', 'secret'] },
          name: TEXT,
          job: TEXT,
          from: { enum: ['none', 'read', 'write'] },
          to: { enum: ['read', 'write'] },
        },
      },
    },
    product: TEXT,
    audience: { enum: ['visitors', 'customers', 'repos'] },
    askSecondApprover: { type: 'boolean' },
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
// The Changelog line of each PR that ships
//
// The CHANGELOG section is built from each PR's own line, as the facts hold it, and a line is
// never written by the prep run or the cut. `lint-prep` and the cut ask this one rule, so a
// prep file the lint passes is never refused for a missing line when the release branch is made.

// True when the PR has the one single-line `Changelog:` text the CHANGELOG section is built from.
const hasChangelogLine = (pr) => typeof pr.changelog === 'string' && pr.changelog.trim() !== '' && !/[\r\n]/.test(pr.changelog);

// The numbers, in the facts' order, of the PRs that ship something and have no valid line,
// whatever group the prep file gives them: Internal included.
const prsWithoutChangelogLine = (prs) => prs.filter((pr) => pr.shipsNothing !== true && !hasChangelogLine(pr)).map((pr) => pr.number);

// The words the lint and the cut give for these PRs. It holds numbers only: never the text of a line.
const missingChangelogLineMessage = (numbers) => `no single valid Changelog line in the facts for ${numbers.map((n) => `#${n}`).join(', ')}: a line is never written here, so the PR needs one and the facts must be made again (answering its no-changelog-line flag does not clear it)`;

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
      if (item && typeof item.name === 'string') out.push({ at: `notes.sections[${i}].items[${j}].name`, text: item.name });
      if (item && typeof item.text === 'string') out.push({ at: `notes.sections[${i}].items[${j}].text`, text: item.text });
    });
  });
  return out;
}

const arrayOf = (v) => (Array.isArray(v) ? v : []);

// The strings of the report shown above the folds of the release PR, with where each is.
function approverTexts(report) {
  if (!report || typeof report !== 'object') return [];
  const out = [];
  const add = (at, text) => { if (typeof text === 'string') out.push({ at, text }); };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  add('report.headline', report.headline);
  arrayOf(report.changes).forEach((c, i) => ['before', 'after', 'label'].forEach((k) => add(`report.changes[${i}].${k}`, c && c[k])));
  if (isObj(report.safety)) ['answer', 'why'].forEach((k) => add(`report.safety.${k}`, report.safety[k]));
  arrayOf(report.risks).forEach((r, i) => ['if', 'then', 'untested'].forEach((k) => add(`report.risks[${i}].${k}`, r && r[k])));
  if (isObj(report.undo)) ['how', 'howLong'].forEach((k) => add(`report.undo.${k}`, report.undo[k]));
  arrayOf(report.internal).forEach((x, i) => add(`report.internal[${i}].text`, x && x.text));
  return out;
}

// Every string of the report: what is above the folds and the notes for the release manager.
function reportTexts(report) {
  if (!report || typeof report !== 'object') return [];
  return [
    ...approverTexts(report).map((t) => t.text),
    ...arrayOf(report.managerNotes),
  ].filter((s) => typeof s === 'string');
}

// The problems of one text shown above the folds, as `[rule, message]`: a banned word, a number, a commit, a path,
// a config key or an HTML code. `terms` are patterns from `termPattern`. Exported for the test over renderTop's output.
function notPlain(text, terms, { codeSpans = false } = {}) {
  const found = [];
  // The production plan's lines are quoted word for word in code spans, and are exempt when `codeSpans` says so.
  if (codeSpans) text = String(text).replace(/`[^`\n]*`/g, ' ');
  if (terms.some((re) => re.test(text))) found.push(['approver-term', 'holds a word of how releases run, or an internal term from the facts: say it in plain words']);
  for (const [rule, re, what] of NOT_PLAIN) if (re.test(text)) found.push([rule, `holds ${what}: the page above its folds names none`]);
  const words = text.replace(URL_RE, ' ').split(WORD_SPLIT).map(stripMarks);
  if (words.some(isFilePath)) found.push(['file-path', 'holds a file path or file name: the page above its folds names none']);
  return found;
}

const countWords = (text) => text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

// The top of the page as a reader sees it: each line that renders (never a blank line, an HTML comment or a table's
// alignment row), as `{ kind: 'heading' | 'row' | 'text', text, cells? }`.
function topLines(top) {
  return String(top).replace(/<!--[\s\S]*?-->/g, '').split('\n').map((l) => l.trim())
    .filter((l) => l && !/^\|(?:\s*:?-+:?\s*\|)+$/.test(l))
    .map((l) => {
      if (/^#{1,6} /.test(l)) return { kind: 'heading', text: l };
      if (l.startsWith('|')) return { kind: 'row', text: l, cells: l.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim()) };
      return { kind: 'text', text: l };
    });
}

// What is too long in a rendered top, as `[rule, message]`: over 25 lines, a paragraph or bullet over 25 words, or a
// table cell over 15. A message names where, never the text.
function topProblems(top) {
  const lines = topLines(top);
  const found = [];
  if (lines.length > TOP_MAX_LINES) found.push(['top-too-long', `renders ${lines.length} lines above the first fold of the release PR; the page has ${TOP_MAX_LINES} at most: say less`]);
  lines.forEach((l, i) => {
    if (l.kind === 'text' && countWords(l.text) > PARAGRAPH_MAX_WORDS) found.push(['paragraph-too-long', `line ${i + 1} of the top renders ${countWords(l.text)} words; a paragraph is ${PARAGRAPH_MAX_WORDS} at most`]);
    if (l.kind === 'row') {
      l.cells.forEach((c, k) => {
        if (countWords(c) > CELL_MAX_WORDS) found.push(['cell-too-long', `line ${i + 1}, cell ${k + 1} of the top renders ${countWords(c)} words; a table cell is ${CELL_MAX_WORDS} at most`]);
      });
    }
  });
  return found;
}

// ---------------------------------------------------------------------------
// The lint

// Every problem with `prep` against `facts`, as `{ rule, at, message }`. `facts` must have
// passed checkFacts. An empty list is a pass. `names: false` leaves out the rules of an item's name and text length: a prep
// file cut by an earlier Shipyard, which the record and a re-ship read again, never had names.
function lintPrep(prep, facts, { names = true } = {}) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  // Format 1 is refused alone, with what to write: there is no reading of it into format 2.
  if (isObject(prep) && prep.format === 1) {
    return [{ rule: 'format-1', at: 'format', message: FORMAT_1_MESSAGE }];
  }
  // A change that still has `who` is refused with its own rule, naming the change, rather than as a field outside the
  // format. The schema's problem for that field is the one that says its place (`field 3`); any other stays. A prep an
  // earlier Shipyard cut (`names: false`) was written when `who` was allowed: the record, the ask and a re-ship read it
  // as it is, so its `who` is dropped from the problems and never shown.
  const whoGone = new Set();
  (isObject(prep) && isObject(prep.report) && Array.isArray(prep.report.changes) ? prep.report.changes : []).forEach((c, i) => {
    if (isObject(c) && Object.hasOwn(c, 'who')) whoGone.add(`report.changes[${i}]|holds a field outside this format (field ${Object.keys(c).indexOf('who') + 1})`);
  });
  const problems = validate(prep).filter((p) => !whoGone.has(`${p.at}|${p.message}`)).map((p) => ({ rule: 'schema', ...p }));
  const add = (rule, at, message) => problems.push({ rule, at, message });
  if (names) whoGone.forEach((k) => add('who-removed', `${k.split('|')[0]}.who`, 'is gone: the Now cell holds after alone; take who out'));
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

  // A line for each PR that ships, in any group, Internal too: the cut writes no line of its own.
  const unlined = prsWithoutChangelogLine(facts.prs);
  if (unlined.length) add('pr-no-changelog-line', 'facts.prs', missingChangelogLineMessage(unlined));

  // A release that raises what callers must give is a new major: once every repo calls the floating major tag, a
  // minor or a patch that needs more would break each caller's runs at the moment the tag moves. Below 1.0 that is
  // a new line, 0.x to 1.0.0, so the skill's "a major is a minor below 1.0" does not apply here.
  const bumpIs = isObject(prep.level) ? prep.level.bump : undefined;
  if (bumpIs === 'minor' || bumpIs === 'patch') {
    for (const raise of Array.isArray(facts.callerNeeds) ? facts.callerNeeds : []) {
      add('caller-needs-raised', 'level.bump', `${describeRaise(raise)}: callers must give more, which needs a major version, and the level is ${bumpIs}`);
    }
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
  // Every item outside "Before you update" has a name of 2 to 4 words and text of 120 characters or fewer:
  // the #releases post shows them as a bulleted list.
  (Array.isArray(notes.sections) ? notes.sections : []).forEach((section, i) => {
    if (!names || !isObject(section) || !Array.isArray(section.items) || isBeforeYouUpdate(section.heading)) return;
    section.items.forEach((item, j) => {
      if (!isObject(item)) return;
      const where = `notes.sections[${i}].items[${j}]`;
      if (typeof item.name !== 'string' || !item.name.trim()) add('item-name-missing', `${where}.name`, 'is missing: name the item in 2 to 4 words, as the #releases post shows it');
      else {
        const n = countWords(item.name);
        if (n < ITEM_NAME_WORDS[0] || n > ITEM_NAME_WORDS[1]) add('item-name-length', `${where}.name`, `is ${n} word${n === 1 ? '' : 's'}; an item's name is ${ITEM_NAME_WORDS[0]} to ${ITEM_NAME_WORDS[1]}`);
      }
      if (typeof item.text === 'string' && [...item.text.trim()].length > ITEM_TEXT_MAX) {
        add('item-text-too-long', `${where}.text`, `is ${[...item.text.trim()].length} characters; an item's text is ${ITEM_TEXT_MAX} or fewer`);
      }
    });
  });
  (Array.isArray(notes.sections) ? notes.sections : []).forEach((section, i) => {
    (isObject(section) && Array.isArray(section.items) ? section.items : []).forEach((item, j) => {
      (isObject(item) && Array.isArray(item.covers) ? item.covers : []).forEach((n, k) => {
        if (Number.isInteger(n) && !inRange.has(n)) {
          add('covers-not-in-range', `notes.sections[${i}].items[${j}].covers[${k}]`, `#${n} is not a PR in the range`);
        }
      });
    });
  });

  // Each change of the report names PRs in the range too, and every PR a user can see is in some change.
  const report = isObject(prep.report) ? prep.report : {};
  const covered = new Set();
  arrayOf(report.changes).forEach((entry, i) => {
    (isObject(entry) && Array.isArray(entry.covers) ? entry.covers : []).forEach((n, k) => {
      covered.add(n);
      if (Number.isInteger(n) && !inRange.has(n)) add('covers-not-in-range', `report.changes[${i}].covers[${k}]`, `#${n} is not a PR in the range`);
    });
  });
  // A security fix no user sees may be said as an internal change instead: the page leads with it.
  const internalCovered = new Set();
  arrayOf(report.internal).forEach((entry, i) => {
    (isObject(entry) && Array.isArray(entry.covers) ? entry.covers : []).forEach((n, k) => {
      internalCovered.add(n);
      if (Number.isInteger(n) && !inRange.has(n)) add('covers-not-in-range', `report.internal[${i}].covers[${k}]`, `#${n} is not a PR in the range`);
    });
  });
  // A full list (5 rows) may leave PRs out: the page counts them as "Also N more changes".
  if (Array.isArray(report.changes) && report.changes.length < 5) {
    for (const group of GROUPS.filter((g) => g !== 'Internal')) {
      for (const n of arrayOf(groups[group])) {
        if (!Number.isInteger(n) || !inRange.has(n) || covered.has(n)) continue;
        if (group === 'Security' && internalCovered.has(n)) continue;
        add('pr-no-change', 'report.changes', `#${n} is grouped ${group} and no change covers it: say what it changes for a user`);
      }
    }
  }
  arrayOf(report.changes).forEach((c, i) => {
    if (!isObject(c) || typeof c.label !== 'string') return;
    const n = countWords(c.label);
    if (n < LABEL_WORDS[0] || n > LABEL_WORDS[1]) add('label-length', `report.changes[${i}].label`, `is ${n} word${n === 1 ? '' : 's'}; a label is ${LABEL_WORDS[0]} to ${LABEL_WORDS[1]}`);
  });

  // The changes no user sees, each in 12 words or fewer: every release with an Internal PR has them, and no other.
  const internal = arrayOf(groups.Internal).filter((n) => Number.isInteger(n) && inRange.has(n));
  if (Array.isArray(report.internal)) {
    if (!internal.length && !report.internal.some((x) => isObject(x) && arrayOf(x.covers).some((n) => arrayOf(groups.Security).includes(n)))) {
      add('internal-unneeded', 'report.internal', 'no PR is grouped Internal: leave internal out');
    }
    report.internal.forEach((x, i) => {
      if (isObject(x) && typeof x.text === 'string' && countWords(x.text) > INTERNAL_MAX_WORDS) add('internal-too-long', `report.internal[${i}].text`, `is ${countWords(x.text)} words; an internal change is ${INTERNAL_MAX_WORDS} or fewer`);
    });
  } else if (internal.length && isObject(prep.report)) {
    add('internal-missing', 'report.internal', `${internal.length} PR${internal.length === 1 ? ' is' : 's are'} grouped Internal: say each change no user sees, in ${INTERNAL_MAX_WORDS} words or fewer`);
  }

  // The headline is 8 words or fewer, and the safety answer starts with its answer word.
  if (typeof report.headline === 'string' && countWords(report.headline) > HEADLINE_MAX_WORDS) {
    add('headline-too-long', 'report.headline', `is ${countWords(report.headline)} words; the headline is ${HEADLINE_MAX_WORDS} or fewer`);
  }
  const safety = isObject(report.safety) ? report.safety : {};
  if (typeof safety.answer === 'string') {
    const first = (safety.answer.trim().split(/[\s,.:;!?]+/)[0] || '').toLowerCase();
    if (!ANSWER_WORDS.includes(first)) add('safety-no-answer', 'report.safety.answer', `does not start with its answer: start with one of ${ANSWER_WORDS.map((w) => w.replace(/^./, (c) => c.toUpperCase())).join(', ')}`);
    if (countWords(safety.answer) > SAFETY_ANSWER_MAX_WORDS) add('safety-answer-too-long', 'report.safety.answer', `is ${countWords(safety.answer)} words; the answer is ${SAFETY_ANSWER_MAX_WORDS} or fewer`);
  }
  if (typeof safety.why === 'string' && countWords(safety.why) > SAFETY_WHY_MAX_WORDS) {
    add('safety-why-too-long', 'report.safety.why', `is ${countWords(safety.why)} words; why is one line of ${SAFETY_WHY_MAX_WORDS} or fewer`);
  }

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

  // Above the folds: no word of how Shipyard runs a release, no internal term of the repo, and no number, commit,
  // path, config key or HTML code.
  const aboveTerms = [...ABOVE_FOLD_TERMS, ...facts.internalTerms].map(termPattern);
  for (const { at, text } of approverTexts(prep.report)) {
    for (const [rule, message] of notPlain(text, aboveTerms)) add(rule, at, message);
  }

  // The top of the page, rendered as the cut writes it with every row the record can add: its lines, paragraphs and cells.
  if (!problems.length) {
    const { renderTop } = require('./changelog'); // required here: changelog.js requires this file
    const tag = `${facts.tagPrefix || ''}0.0.0`;
    const top = renderTop({ facts: { ...facts, range: facts.range || { from: tag } }, prep, tag, status: null, lint: true });
    for (const [rule, message] of topProblems(top)) add(rule, 'report', message);
  }

  // The report: 300 words or fewer.
  const words = reportTexts(prep.report).reduce((sum, t) => sum + countWords(t), 0);
  if (words > REPORT_MAX_WORDS) {
    add('report-too-long', 'report', `is ${words} words; the report is ${REPORT_MAX_WORDS} words or fewer`);
  }

  return problems;
}

module.exports = {
  GROUPS, BEFORE_YOU_UPDATE, ITEM_NAME_WORDS, ITEM_TEXT_MAX, isBeforeYouUpdate, REPORT_MAX_WORDS, ABOVE_FOLD_TERMS, ANSWER_WORDS, HEADLINE_MAX_WORDS, TOP_MAX_LINES, PARAGRAPH_MAX_WORDS, CELL_MAX_WORDS, FACTS_SCHEMA, LintError, FORMAT_1_MESSAGE,
  INTERNAL_MAX_WORDS, SAFETY_ANSWER_MAX_WORDS, SAFETY_WHY_MAX_WORDS, topLines, topProblems,
  checkFacts, lintPrep, isPrivateLink, isPrivateBareHost, isFilePath, countWords, reportTexts, approverTexts, termPattern, notPlain,
};

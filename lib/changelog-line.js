'use strict';

// The rules for a PR body's `Changelog:` and `Update-Needs:` lines. Pure: no network and
// no files. The command (changelog-line-command.js) supplies the body, the repo's
// visibility, its internal terms and a way to ask whether a linked repo is private.
//
// A finding never repeats the text it matched: the log of a public repo is public, and
// the match may be the very secret, repo name or term the rule keeps out.

const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

// github.com/<first segment> that is a page, not an owner.
const RESERVED_OWNERS = new Set([
  'about', 'advisories', 'apps', 'codespaces', 'collections', 'community', 'contact', 'copilot',
  'customer-stories', 'enterprise', 'events', 'explore', 'features', 'git-guides', 'issues', 'join',
  'login', 'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'readme', 'resources',
  'search', 'security', 'sessions', 'settings', 'site', 'solutions', 'sponsors', 'stars', 'team',
  'topics', 'trending', 'users',
]);

const SECRET_PATTERNS = [
  ['an AWS access key', /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA|ANVA|AIPA)[A-Z0-9]{16}\b/],
  ['a GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/],
  ['a Slack token', /\bxox[abeprs]-[A-Za-z0-9-]{10,}/],
  ['a Stripe key', /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/],
  ['a Google API key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['an npm token', /\bnpm_[A-Za-z0-9]{36}\b/],
  ['a private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['a JSON web token', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/],
  ['a bearer token', /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/i],
  ['a password in a URL', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i],
  // `token: <value>`, `API_KEY=<value>`: a secret word, a separator, a value holding a digit.
  ['a key, token or password assignment', /\b(?:api[_-]?key|secret|token|passw(?:or)?d|credentials?)s?\b["']?\s*[:=]\s*["']?(?=[A-Za-z0-9/+_.=-]*\d)[A-Za-z0-9/+_.=-]{8,}/i],
];

const ACCOUNT_ID_PATTERNS = [
  /(?<!\d)\d{12}(?!\d)/,
  /(?<![\d-])\d{4}-\d{4}-\d{4}(?![\d-])/,
];

class CheckError extends Error {}

// ---------------------------------------------------------------------------
// Reading the body

// Text a reader of the rendered PR cannot see (HTML comments) or that is an example
// (fenced code) never counts: a PR template may hold `Changelog:` in either.
function visibleText(body) {
  const text = String(body || '').replace(/\r\n?/g, '\n').replace(/<!--[\s\S]*?(?:-->|$)/g, '');
  const kept = [];
  let fence = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && /^ {0,3}[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (m) {
      fence = m[1];
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n');
}

function extractLines(body) {
  const changelog = [];
  const updateNeeds = [];
  for (const line of visibleText(body).split('\n')) {
    const m = /^ {0,3}(changelog|update-needs):[ \t]*(.*?)\s*$/i.exec(line);
    if (!m) continue;
    (m[1].toLowerCase() === 'changelog' ? changelog : updateNeeds).push(m[2]);
  }
  return { changelog, updateNeeds };
}

// ---------------------------------------------------------------------------
// The rules

function countSentences(text) {
  const protectedText = text.replace(/\b(e\.g|i\.e|vs)\./gi, (m) => m.replace(/\./g, '\u0000'));
  return protectedText
    .split(/(?<=[.!?])["')\]`]*\s+(?=["'(\[`]?[A-Z0-9])/)
    .filter((s) => s.trim()).length;
}

// A line is a runbook when it reads as steps: a heading, `Step 2`, or two numbered items.
function looksLikeRunbook(text) {
  if (/(?:^|\s)#{1,6}\s/.test(text)) return true;
  if (/\bstep\s+\d+\b/i.test(text)) return true;
  const markers = text.match(/(?:^|[\s(;:])\d{1,2}[.)]\s+\S/g) || [];
  return markers.length >= 2 || /^\d{1,2}[.)]\s+\S/.test(text);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegExp(term) {
  const start = /^\w/.test(term) ? '(?<!\\w)' : '';
  const end = /\w$/.test(term) ? '(?!\\w)' : '';
  return new RegExp(`${start}${escapeRegExp(term)}${end}`, 'i');
}

function linkedRepos(text) {
  const found = new Map();
  const add = (owner, repo) => {
    repo = repo.replace(/\.+$/, '').replace(/\.git$/i, '');
    if (!owner || !repo || RESERVED_OWNERS.has(owner.toLowerCase())) return;
    found.set(`${owner}/${repo}`.toLowerCase(), { owner, repo });
  };
  // Only github.com itself: docs.github.com and gist.github.com are not repo links.
  for (const m of text.matchAll(/(?<![\w.-])(?:www\.)?github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/gi)) add(m[1], m[2]);
  for (const m of text.matchAll(/(?<![\w/.:@-])([A-Za-z0-9_-][A-Za-z0-9_.-]*)\/([A-Za-z0-9_.-]+)#\d+/g)) add(m[1], m[2]);
  return [...found.values()];
}

/**
 * Check one body against every rule.
 *
 * @param {string} body
 * @param {object} opts
 * @param {boolean} opts.isPublic        a public repo also keeps out private links and internal terms
 * @param {string[]} [opts.internalTerms] `notes.internalTerms` of `.github/release.json`
 * @param {(owner: string, repo: string) => Promise<'public'|'private'|'not-found'>} [opts.repoVisibility]
 * @returns {Promise<{problems: {rule: string, message: string}[], changelog: string|null, updateNeeds: string|null}>}
 */
async function checkBody(body, { isPublic = true, internalTerms = [], repoVisibility } = {}) {
  const { changelog, updateNeeds } = extractLines(body);
  const problems = [];
  const problem = (rule, message) => problems.push({ rule, message });

  if (changelog.length === 0) {
    problem('missing', 'The PR body has no `Changelog:` line. Add one line that starts with `Changelog:`, in one or two sentences.');
  } else if (changelog.length > 1) {
    problem('multiple', `The PR body has ${changelog.length} \`Changelog:\` lines. Keep exactly one.`);
  }
  if (updateNeeds.length > 1) {
    problem('multiple-update-needs', `The PR body has ${updateNeeds.length} \`Update-Needs:\` lines. Keep at most one.`);
  }

  const lines = [];
  if (changelog.length === 1) lines.push(['Changelog', changelog[0], true]);
  if (updateNeeds.length === 1) lines.push(['Update-Needs', updateNeeds[0], false]);

  for (const [name, text, isChangelog] of lines) {
    if (!text) {
      problem('empty', `The \`${name}:\` line is empty.`);
      continue;
    }
    const sentences = countSentences(text);
    if (sentences > 2) {
      problem('length', `The \`${name}:\` line has ${sentences} sentences. Use one or two.`);
    }
    if (isChangelog && looksLikeRunbook(text)) {
      problem('runbook', 'The `Changelog:` line reads like a runbook (numbered steps, "step N" or a heading). Say what changed, not how to do it; put what people must do in `Update-Needs:`.');
    }
    for (const [label, re] of SECRET_PATTERNS) {
      if (re.test(text)) problem('secret', `The \`${name}:\` line holds ${label}. Remove it, and rotate it if it was real.`);
    }
    if (ACCOUNT_ID_PATTERNS.some((re) => re.test(text))) {
      problem('account-id', `The \`${name}:\` line holds what looks like an account ID (a 12-digit number). Remove it.`);
    }
    if (isPublic) {
      const hits = internalTerms.filter((term) => termRegExp(term).test(text));
      if (hits.length) {
        problem('internal-term', `The \`${name}:\` line uses ${hits.length} term${hits.length === 1 ? '' : 's'} from \`notes.internalTerms\` in the repo's release config. Reword it for a public reader.`);
      }
      for (const { owner, repo } of linkedRepos(text)) {
        if (!repoVisibility) throw new CheckError('Cannot check links to repos: no way to look them up.');
        const visibility = await repoVisibility(owner, repo);
        if (visibility !== 'public') {
          problem('private-link', `The \`${name}:\` line links to a repo that is private, or that this check cannot see. A public repo's notes may link only to public repos.`);
        }
      }
    }
  }

  return {
    problems,
    changelog: changelog.length === 1 ? changelog[0] : null,
    updateNeeds: updateNeeds.length === 1 ? updateNeeds[0] : null,
  };
}

// ---------------------------------------------------------------------------
// Who opened the PR

// A branch in the base repo can only be pushed by someone who can write to it, so its PR is
// never from an outside contributor. The job's token cannot see private org membership and
// reads such an author as CONTRIBUTOR, so the association alone is not trusted there.
function fromBaseRepo(pr) {
  const head = pr.head && pr.head.repo && pr.head.repo.full_name;
  const base = pr.base && pr.base.repo && pr.base.repo.full_name;
  return Boolean(head && base) && String(head).toLowerCase() === String(base).toLowerCase();
}

function classifyAuthor(pr) {
  const login = String((pr.user && pr.user.login) || '').toLowerCase();
  if (login === 'dependabot[bot]') return 'dependabot';
  if (fromBaseRepo(pr)) return 'team';
  return TRUSTED_ASSOCIATIONS.has(String(pr.author_association || '').toUpperCase()) ? 'team' : 'outside';
}

// "Bump grpc from 1.79.3 to 1.82.1" -> "Bump grpc from 1.79.3 to 1.82.1."
// Also takes Dependabot's prefixed titles ("build(deps): bump x from 1 to 2").
function changelogFromTitle(title) {
  let text = String(title || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '');
  if (!text) return null;
  text = text[0].toUpperCase() + text.slice(1);
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

// A PR's `Changelog:` and `Update-Needs:` lines as Shipyard reads them everywhere: the body's, except that a
// Dependabot PR whose body has no `Changelog:` line at all takes the line made from its title. Nothing is written
// to the PR: the body stays as its author left it, and every reader asks this function for the line.
// `fromTitle` is true when the line is the title's. A line in the body, even an empty or a second one, is the body's.
function changelogOf(pr) {
  const { changelog, updateNeeds } = extractLines(pr && pr.body);
  if (changelog.length > 0 || classifyAuthor(pr || {}) !== 'dependabot') return { changelog, updateNeeds, fromTitle: false };
  const line = changelogFromTitle(pr.title);
  return { changelog: line ? [line] : [], updateNeeds, fromTitle: Boolean(line) };
}

// The body as it would read with the title's line at its top, for checking the line against the rules. Never sent to GitHub.
function withChangelogLine(body, line) {
  const rest = String(body || '').replace(/\r\n?/g, '\n').trim();
  return rest ? `Changelog: ${line}\n\n${rest}\n` : `Changelog: ${line}\n`;
}

module.exports = {
  CheckError,
  SECRET_PATTERNS,
  TRUSTED_ASSOCIATIONS,
  checkBody,
  extractLines,
  visibleText,
  classifyAuthor,
  changelogFromTitle,
  changelogOf,
  withChangelogLine,
  countSentences,
  linkedRepos,
  SECRET_PATTERNS,
  termRegExp,
};

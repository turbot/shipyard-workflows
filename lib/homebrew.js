'use strict';

// The Homebrew formula of a CLI whose release carries its own archives (docs/release-cli.md). Pure: no network and no files.
// The formula is written from the published GitHub Release: each archive's address and the SHA-256 GitHub holds for it, so a
// formula never names a file that is not on the Release, and the same Release always gives the same text.

class HomebrewError extends Error {}

// The platforms a formula covers: Homebrew's block, the archive's os and arch (goreleaser's names).
const PLATFORMS = [
  { os: 'macos', goos: 'darwin', cpu: 'arm', goarch: 'arm64' },
  { os: 'macos', goos: 'darwin', cpu: 'intel', goarch: 'amd64' },
  { os: 'linux', goos: 'linux', cpu: 'arm', goarch: 'arm64' },
  { os: 'linux', goos: 'linux', cpu: 'intel', goarch: 'amd64' },
];

const FORMULA = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const BINARY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const TAG = /^([A-Za-z0-9._-]*?)(\d+\.\d+\.\d+)$/;
const DIGEST = /^sha256:([0-9a-f]{64})$/;
const ARCHIVE_NAME = /^[A-Za-z0-9._@+=~-]+$/;
// A Ruby string between double quotes, written as it is: no quote, backslash, interpolation or line break to escape.
const PLAIN_TEXT = /^[^"\\#\r\n\0]{1,200}$/;
const DEFAULT_ARCHIVE = '{name}_{os}_{arch}.tar.gz';

// `v0.7.5` is the version `0.7.5` when the prefix is `v`. No pre-release: a Homebrew formula is of a release.
function versionOfTag(tag, prefix) {
  const m = TAG.exec(String(tag));
  if (!m || m[1] !== prefix) throw new HomebrewError(`--tag ${JSON.stringify(String(tag).slice(0, 40))} is not a release tag of the prefix ${JSON.stringify(prefix)}: X.Y.Z with nothing after it`);
  return m[2];
}

const camel = (name) => name.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');

// Checks what the caller named; returns it with the defaults filled in.
function checkNames(n) {
  if (!FORMULA.test(String(n.formula))) throw new HomebrewError('--formula is the formula\'s name: lower-case words joined by hyphens');
  const binary = n.binary || n.formula;
  if (!BINARY.test(binary)) throw new HomebrewError('--binary is the name of the program in the archive');
  for (const [flag, key] of [['--desc', 'desc'], ['--homepage', 'homepage']]) {
    if (!PLAIN_TEXT.test(String(n[key] ?? ''))) throw new HomebrewError(`${flag} is required: one line with no double quote, backslash or #`);
  }
  if (n.license && !/^[A-Za-z0-9.+() -]{1,80}$/.test(n.license)) throw new HomebrewError('--license is an SPDX name, such as AGPL-3.0');
  if (!/^https:\/\/[^\s"]+$/.test(n.homepage)) throw new HomebrewError('--homepage must be an https address');
  // With no arguments the formula has no test block, as the one goreleaser wrote had none.
  const testArgs = n.testArgs || '';
  if (testArgs && !/^[A-Za-z0-9 ._=-]{1,80}$/.test(testArgs)) throw new HomebrewError('--test-args holds letters, digits, spaces and . _ = - only');
  const archive = n.archive || DEFAULT_ARCHIVE;
  if (!/^[A-Za-z0-9._{}@+=~-]+$/.test(archive) || !archive.includes('{os}') || !archive.includes('{arch}')) {
    throw new HomebrewError('--archive is the archive\'s file name with {os} and {arch} where they go ({name} and {version} are the others)');
  }
  return {
    formula: n.formula, binary, desc: n.desc, homepage: n.homepage, license: n.license || '', testArgs, archive, versioned: n.versioned === true,
  };
}

// The four archives a Release must hold, by platform.
function archiveNames(names, version) {
  return PLATFORMS.map((p) => {
    const file = names.archive.replace(/\{name\}/g, names.binary).replace(/\{os\}/g, p.goos).replace(/\{arch\}/g, p.goarch).replace(/\{version\}/g, version);
    if (!ARCHIVE_NAME.test(file)) throw new HomebrewError(`--archive makes ${JSON.stringify(file.slice(0, 60))}, which is not a file name`);
    return { ...p, file };
  });
}

/**
 * The files the formula points at, each with the SHA-256 the Release holds for it. `assets` is the Release's files as
 * `{ name, digest }`. Throws when one of the four is missing or has no digest: a formula is never written on part of its files.
 */
function checksumsOf(archives, assets) {
  const byName = new Map(assets.map((a) => [a.name, a]));
  const missing = archives.filter((a) => !byName.has(a.file)).map((a) => a.file);
  if (missing.length) throw new HomebrewError(`the Release has no ${missing.join(', ')}: the formula points at its files, so nothing is written`);
  return archives.map((a) => {
    const m = DIGEST.exec(String(byName.get(a.file).digest || ''));
    if (!m) throw new HomebrewError(`GitHub gave no SHA-256 for ${a.file} on the Release: nothing is written`);
    return { ...a, sha256: m[1] };
  });
}

// The formula's text for one release. `className` is the Ruby class Homebrew expects for the file's name.
function renderFormula({
  names, version, tag, repo, files, className,
}) {
  const block = (os) => {
    const rows = files.filter((f) => f.os === os).map((f) => [
      `    on_${f.cpu} do`,
      `      url "https://github.com/${repo}/releases/download/${tag}/${f.file}"`,
      `      sha256 "${f.sha256}"`,
      '    end',
    ].join('\n'));
    return `  on_${os} do\n${rows.join('\n')}\n  end`;
  };
  return [
    '# typed: false',
    '# frozen_string_literal: true',
    '',
    '# Written by Shipyard from the GitHub Release (docs/release-cli.md). The next release writes it again: do not edit it by hand.',
    `class ${className || camel(names.formula)} < Formula`,
    `  desc "${names.desc}"`,
    `  homepage "${names.homepage}"`,
    `  version "${version}"`,
    ...(names.license ? [`  license "${names.license}"`] : []),
    '',
    block('macos'),
    '',
    block('linux'),
    '',
    '  def install',
    `    bin.install "${names.binary}"`,
    '  end',
    ...(names.testArgs ? ['', '  test do', `    assert_match version.to_s, shell_output("#{bin}/${names.binary} ${names.testArgs}")`, '  end'] : []),
    'end',
    '',
  ].join('\n');
}

/**
 * The files a release writes into the tap: `Formula/<formula>.rb`, the newest, and with `versioned` also
 * `Formula/<formula>@<version>.rb`, the copy a person pins to (its class is `<Formula>AT<version without dots>`, as Homebrew names it).
 * `dir` is the tap's folder for formulas.
 */
function formulaFiles({
  names, version, tag, repo, files, dir = 'Formula',
}) {
  const out = [{ path: `${dir}/${names.formula}.rb`, text: renderFormula({ names, version, tag, repo, files }) }];
  if (names.versioned) {
    out.push({
      path: `${dir}/${names.formula}@${version}.rb`,
      text: renderFormula({ names, version, tag, repo, files, className: `${camel(names.formula)}AT${version.replace(/\./g, '')}` }),
    });
  }
  return out;
}

// The version an existing formula says, or null.
const versionOfFormula = (text) => {
  const m = /^\s*version "(\d+\.\d+\.\d+)"\s*$/m.exec(String(text || ''));
  return m ? m[1] : null;
};

const partsOf = (v) => v.split('.').map(Number);
function newer(a, b) {
  const [x, y] = [partsOf(a), partsOf(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

/**
 * What to do with the tap's formulas: `current` (each is this text already), `refuse` (the newest formula names a newer version,
 * which an older release run again must never replace) or `write`. `existing` is the text of each file by path, or null.
 */
function planFormula({ existing, files, version }) {
  if (files.every((f) => existing[f.path] === f.text)) return { action: 'current' };
  const has = versionOfFormula(existing[files[0].path]);
  if (has && newer(has, version)) return { action: 'refuse', reason: `the tap holds ${has}, which is newer than ${version}: an older release is never written over a newer one` };
  return { action: 'write' };
}

module.exports = {
  HomebrewError, PLATFORMS, REPO, DEFAULT_ARCHIVE, versionOfTag, checkNames, archiveNames, checksumsOf, renderFormula, formulaFiles, versionOfFormula, planFormula,
};

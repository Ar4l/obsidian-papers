#!/usr/bin/env node
// One-off migration: backfill `alphaxiv:` frontmatter into existing paper notes.
//
// For each .md file in <notes-dir>:
//   - Skip files with no leading YAML frontmatter block.
//   - Skip files that already have an `alphaxiv:` key (idempotent).
//   - Find the `url:` (or `URL:`) line inside the frontmatter.
//       * If the URL matches the plugin's arXiv regex, insert
//         `alphaxiv: https://www.alphaxiv.org/abs/<id>` immediately after it.
//       * Otherwise insert a bare `alphaxiv:` (empty value) so the schema is uniform.
//   - If there is no url line, skip with `no-url`.
//
// Mirrors the regex used by extractArxivId in main.ts:
//   /arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/
//
// Usage:  node tools/migrate-alphaxiv.mjs <notes-dir> [--apply]
// Default is dry-run; nothing is written unless --apply is passed.

import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ARXIV_RE = /arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/;

// CLI ---------------------------------------------------------------------

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const notesDir = args.find(a => !a.startsWith('--'));

if (!notesDir) {
    console.error('Usage: node tools/migrate-alphaxiv.mjs <notes-dir> [--apply]');
    process.exit(2);
}

// Helpers ----------------------------------------------------------------

/**
 * Locate the leading YAML frontmatter block.
 * Returns { startIdx, endIdx } indexes into the `lines` array such that
 *   lines[startIdx] === '---'  (opening fence)
 *   lines[endIdx]   === '---'  (closing fence)
 * or null if no frontmatter block.
 *
 * The opening fence MUST be the very first non-empty line of the file (this is
 * what Obsidian recognises).
 */
function findFrontmatter(lines) {
    // Find first non-empty line.
    let i = 0;
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) return null;
    if (lines[i].trim() !== '---') return null;
    const startIdx = i;
    for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '---') {
            return { startIdx, endIdx: j };
        }
    }
    return null; // no closing fence
}

/**
 * Within the given frontmatter slice, return the index of the `url:`/`URL:` line
 * (top-level — i.e. no leading whitespace), or -1 if absent.
 */
function findUrlLine(lines, startIdx, endIdx) {
    for (let k = startIdx + 1; k < endIdx; k++) {
        // Top-level mapping key: no leading whitespace, key followed by `:`.
        // Case-insensitive to handle `URL:` (some hand-written notes use that).
        if (/^url\s*:/i.test(lines[k])) return k;
    }
    return -1;
}

/**
 * Check whether the frontmatter already declares an `alphaxiv:` key
 * (case-insensitive, top-level).
 */
function hasAlphaxivKey(lines, startIdx, endIdx) {
    for (let k = startIdx + 1; k < endIdx; k++) {
        if (/^alphaxiv\s*:/i.test(lines[k])) return true;
    }
    return false;
}

/**
 * Extract the URL string from a `url:` line. Handles:
 *   url: https://...
 *   url: "https://..."
 *   url: 'https://...'
 *   url:
 * Returns the trimmed value (may be empty string).
 */
function extractUrlValue(line) {
    const m = line.match(/^[Uu][Rr][Ll]\s*:\s*(.*)$/);
    if (!m) return '';
    let v = m[1].trim();
    // Strip surrounding quotes if present.
    if ((v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
    }
    return v;
}

function extractArxivId(url) {
    const m = url.match(ARXIV_RE);
    return m ? m[2] : null;
}

/**
 * Detect the dominant line ending of the file content so we can preserve it.
 * Defaults to '\n' (LF) — matches macOS notes.
 */
function detectEol(raw) {
    return raw.includes('\r\n') ? '\r\n' : '\n';
}

/**
 * Split a file into lines without losing the trailing newline distinction.
 * We use the EOL we detected; split removes the separator from each line.
 */
function splitLines(raw, eol) {
    return raw.split(eol);
}

/**
 * Atomic write: write to a temp file in the same dir, then rename.
 */
async function atomicWrite(filePath, content) {
    const tmpPath = `${filePath}.alphaxiv-migrate-${process.pid}-${Date.now()}.tmp`;
    await writeFile(tmpPath, content, 'utf8');
    await rename(tmpPath, filePath);
}

// Main -------------------------------------------------------------------

const stats = {
    total: 0,
    updated: 0,
    skipped_already_has_alphaxiv: 0,
    skipped_non_arxiv: 0,
    skipped_no_frontmatter: 0,
    skipped_no_url: 0,
    errors: 0,
};

const errorFiles = [];
const noFrontmatterFiles = [];
const noUrlFiles = [];
const sampleDiffs = []; // up to 5 "would-modify" previews for dry-run

let entries;
try {
    entries = await readdir(notesDir, { withFileTypes: true });
} catch (err) {
    console.error(`Failed to read notes directory: ${notesDir}`);
    console.error(err.message);
    process.exit(1);
}

const mdFiles = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.md'))
    .map(e => e.name)
    .sort();

for (const name of mdFiles) {
    stats.total++;
    const fullPath = join(notesDir, name);
    try {
        const raw = await readFile(fullPath, 'utf8');
        const eol = detectEol(raw);
        const lines = splitLines(raw, eol);

        const fm = findFrontmatter(lines);
        if (!fm) {
            stats.skipped_no_frontmatter++;
            noFrontmatterFiles.push(name);
            continue;
        }

        if (hasAlphaxivKey(lines, fm.startIdx, fm.endIdx)) {
            stats.skipped_already_has_alphaxiv++;
            continue;
        }

        const urlIdx = findUrlLine(lines, fm.startIdx, fm.endIdx);
        if (urlIdx === -1) {
            stats.skipped_no_url++;
            noUrlFiles.push(name);
            continue;
        }

        const urlValue = extractUrlValue(lines[urlIdx]);
        const arxivId = urlValue ? extractArxivId(urlValue) : null;
        const newLine = arxivId
            ? `alphaxiv: https://www.alphaxiv.org/abs/${arxivId}`
            : `alphaxiv:`;

        // Insert immediately after the url line.
        const newLines = [
            ...lines.slice(0, urlIdx + 1),
            newLine,
            ...lines.slice(urlIdx + 1),
        ];
        const newContent = newLines.join(eol);

        if (arxivId) {
            stats.updated++;
        } else {
            // No arXiv match: still inserted (for schema uniformity) but bucket
            // it separately so the summary makes the situation visible.
            stats.skipped_non_arxiv++;
        }

        if (sampleDiffs.length < 5) {
            sampleDiffs.push({
                file: name,
                contextAbove: lines[urlIdx],
                inserted: newLine,
                arxivMatch: !!arxivId,
                urlValue,
            });
        }

        if (apply) {
            await atomicWrite(fullPath, newContent);
        }
    } catch (err) {
        stats.errors++;
        errorFiles.push({ name, message: err.message });
        console.error(`[error] ${name}: ${err.message}`);
    }
}

// Summary ----------------------------------------------------------------

const sep = '-'.repeat(60);
console.log('');
console.log(sep);
console.log(`Mode: ${apply ? 'APPLY (writing changes)' : 'DRY-RUN (no files modified)'}`);
console.log(`Notes dir: ${notesDir}`);
console.log(sep);
console.log(`Total .md files seen:            ${stats.total}`);
console.log(`  Updated (arxiv -> alphaxiv):   ${stats.updated}`);
console.log(`  Inserted empty (non-arxiv URL):${stats.skipped_non_arxiv}`);
console.log(`  Already had alphaxiv:          ${stats.skipped_already_has_alphaxiv}`);
console.log(`  Skipped, no frontmatter:       ${stats.skipped_no_frontmatter}`);
console.log(`  Skipped, no url field:         ${stats.skipped_no_url}`);
console.log(`  Errors:                        ${stats.errors}`);

const bucketSum =
    stats.updated +
    stats.skipped_non_arxiv +
    stats.skipped_already_has_alphaxiv +
    stats.skipped_no_frontmatter +
    stats.skipped_no_url +
    stats.errors;
console.log(`  (Buckets sum to ${bucketSum}; total ${stats.total} ${bucketSum === stats.total ? 'OK' : 'MISMATCH'})`);

if (noFrontmatterFiles.length) {
    console.log('');
    console.log(`Files with no frontmatter (${noFrontmatterFiles.length}):`);
    for (const f of noFrontmatterFiles.slice(0, 20)) console.log(`  - ${f}`);
    if (noFrontmatterFiles.length > 20) console.log(`  ... and ${noFrontmatterFiles.length - 20} more`);
}

if (noUrlFiles.length) {
    console.log('');
    console.log(`Files with frontmatter but no url field (${noUrlFiles.length}):`);
    for (const f of noUrlFiles.slice(0, 20)) console.log(`  - ${f}`);
    if (noUrlFiles.length > 20) console.log(`  ... and ${noUrlFiles.length - 20} more`);
}

if (errorFiles.length) {
    console.log('');
    console.log(`Files that errored (${errorFiles.length}):`);
    for (const e of errorFiles.slice(0, 20)) console.log(`  - ${e.name}: ${e.message}`);
}

if (!apply && sampleDiffs.length) {
    console.log('');
    console.log('Sample diffs (first few files that WOULD be modified):');
    for (const d of sampleDiffs) {
        console.log('');
        console.log(`  ${d.file}  [${d.arxivMatch ? 'arxiv match' : 'non-arxiv URL'}]`);
        console.log(`    url value: ${JSON.stringify(d.urlValue)}`);
        console.log(`      ${d.contextAbove}`);
        console.log(`    + ${d.inserted}`);
    }
}

console.log('');
console.log(apply
    ? 'Done. Files updated in place (atomic write).'
    : 'Dry-run complete. Re-run with --apply to write changes.');

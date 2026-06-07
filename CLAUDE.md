# Agent instructions for obsidian-papers

This repo ships an Obsidian plugin (`arxiv-papers`). The author/maintainer runs it on macOS with a vault at `~/Library/Mobile Documents/iCloud~md~obsidian/Documents/Brain 2.0/`.

## Release workflow — version bump checklist

When making a change that ships to users, bump the version in **four** places (they must match):

- `manifest.json` → `"version"`
- `package.json` → `"version"`
- `versions.json` → add a new `"<new-version>": "0.15.0"` entry (keep prior ones)
- `main.ts` → `POLITE_UA` string (and the same constant in `tools/test-arxiv.mjs`)

`minAppVersion` stays `0.15.0` unless the user explicitly raises it.

## Build + install (this machine)

```bash
npm run build                       # produces main.js
node tools/test-arxiv.mjs           # all tests should pass; hits live arxiv + OpenAlex
cp main.js manifest.json styles.css \
   "/Users/Aral.De.Moor/Library/Mobile Documents/iCloud~md~obsidian/Documents/Brain 2.0/.obsidian/plugins/arxiv-papers/"
```

**Never touch `data.json` in the install dir.** It holds user settings (notesFolder, pdfFolder, customised noteTemplate). If a change requires a settings migration, edit `data.json` in place with a targeted patch — don't overwrite it.

## Note template + frontmatter

The `noteTemplate` setting is stored in `data.json` and persists across upgrades. Default template lives in `main.ts` (`DEFAULT_SETTINGS.noteTemplate`); placeholders are rendered in `formatNoteContent`. Placeholders currently supported:

- `{{TITLE}}`, `{{AUTHORS}}`, `{{YEAR}}`, `{{URL}}`, `{{PDF}}`
- `{{ALPHAXIV}}` — added in 1.0.4. Renders to `https://www.alphaxiv.org/abs/<id>` when the URL is arXiv, empty string otherwise.

**When you add a placeholder:**

1. Add it to `DEFAULT_SETTINGS.noteTemplate` (so new installs get it).
2. Wire the substitution into `formatNoteContent`.
3. Add a test in `tools/test-arxiv.mjs` covering arXiv URL → expected, non-arXiv → empty.
4. **Add an "Upgrading from <prev>" note in the README** — existing users keep their saved template and won't see the new line until they edit Settings → Note template.
5. If the user asks you to patch their local install, edit `data.json` in the install dir directly — insert the new placeholder line into the saved `noteTemplate` string while preserving every other byte (other keys, escapes, ordering).

## Rate limiting + arXiv quirks

- arXiv throttles per-IP via Fastly/Varnish. 429 responses are **tarpitted 15–46 s** and carry no `Retry-After` header. Use the existing `arxivRequest` helper — it handles ≥ 3 s spacing, 10 s timeout, and exponential backoff (`RATE_LIMIT_BACKOFFS_MS`, `NETWORK_BACKOFFS_MS`).
- On exhausted retries or repeated timeouts, `arxivRequest` throws `ArxivRateLimitedError`, and callers should fall back to OpenAlex via `openAlexLookup`.
- OpenAlex covers post-2022 arXiv papers (via DOI `10.48550/arXiv.<id>`). Pre-2022 returns 404 — surface a clear error.
- Don't add UA spoofing or TLS-fingerprint tricks; the throttle is IP-keyed, not fingerprint-keyed.

## Testing

`tools/test-arxiv.mjs` is a no-framework Node ESM script. It mocks the **Obsidian** runtime (Notice, requestUrl shape) but hits the **real** arXiv + OpenAlex APIs — this is intentional, do not re-mock the upstream APIs. Run with `node tools/test-arxiv.mjs`; exits non-zero on any failure.

## Publishing

- Tags trigger `.github/workflows/release.yml` which uploads `main.js`, `manifest.json`, `styles.css` with artifact attestations.
- Marketplace submissions go through `community.obsidian.md` (browser-auth, manual) — the legacy `obsidianmd/obsidian-releases` PR flow is restricted for new submissions.
- Never push tags or publish releases without explicit user instruction.

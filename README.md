# Papers for Obsidian

Papers is a simple plugin that retrieves and imports research papers into [Obsidian](https://obsidian.md). It queries the arXiv API to download PDFs and save metadata directly into your vault.

https://github.com/user-attachments/assets/12d1b2d4-46f9-416d-b1c7-95e07fae14b3

## Usage

Papers has one key function: search for a paper, then create a new note with its metadata. The search query can either be
1. arXiv URL: A direct link to the paper (e.g., https://arxiv.org/abs/1706.03762).
2. Title: The paper title, which is used to fuzzy search arXiv and prompt the user to choose among results.

The resulting note metadata includes paper title, authors, publication year, and URL. We can download the PDF and embed it in the note as well.

## Install / Build

The plugin isn't in the Obsidian Community catalog yet, so install it manually from source:

```bash
git clone https://github.com/willjhliang/obsidian-papers.git
cd obsidian-papers
npm install
npm run build
```

That produces `main.js`. Copy three files into your vault's plugin folder:

```bash
cp main.js manifest.json styles.css \
   /path/to/your/vault/.obsidian/plugins/papers/
```

Then in Obsidian: **Settings → Community plugins**, toggle "Papers" off and on (or reload Obsidian). Your existing `data.json` (settings) is untouched.

### Optional: contact email for the OpenAlex fallback

When arXiv rate-limits your IP (common on VPNs — arXiv throttles per-IP via Fastly, so a shared egress IP can put you in penalty), the plugin falls back to OpenAlex for paper metadata. Setting your email in **Settings → Papers → Contact email** routes you through OpenAlex's polite pool with a higher quota.

### Run the mock tests

```bash
node tools/test-arxiv.mjs
```

Verifies the rate limiter, timeout, 429 retry, OpenAlex fallback, and polite User-Agent — no network access required.

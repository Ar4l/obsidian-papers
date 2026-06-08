#!/usr/bin/env node
// End-to-end tests of the arXiv fetch helpers against the LIVE arxiv API.
//
// Only the Obsidian bindings are mocked — `requestUrl` is replaced by a
// Node `fetch` adapter that returns the same shape Obsidian's requestUrl
// returns ({ status, text, json, headers, arrayBuffer }). The helpers'
// logic is identical to main.ts; we re-declare it here because main.ts
// imports from "obsidian" which isn't available outside the plugin host.
//
// Run with: node tools/test-arxiv.mjs
// Expects network access to export.arxiv.org / arxiv.org / api.openalex.org.

// === Helpers (same logic as main.ts) ===

const ARXIV_MIN_GAP_MS = 3000;
const POLITE_UA = "obsidian-arxiv-papers/1.0.6 (+https://github.com/Ar4l/obsidian-papers)";
const RATE_LIMIT_BACKOFFS_MS = [10000, 30000, 60000];
const NETWORK_BACKOFFS_MS = [4000, 8000, 16000];

let lastArxivCallAt = 0;
function resetRateLimiter() { lastArxivCallAt = 0; }
async function arxivRateLimit() {
    const gap = Date.now() - lastArxivCallAt;
    if (gap < ARXIV_MIN_GAP_MS) await new Promise(r => setTimeout(r, ARXIV_MIN_GAP_MS - gap));
    lastArxivCallAt = Date.now();
}

function requestWithTimeout(opts, timeoutMs, requestFn) {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error("TIMEOUT"));
        }, timeoutMs);
        requestFn(opts).then(
            res => { if (!settled) { settled = true; clearTimeout(timer); resolve(res); } },
            err => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } },
        );
    });
}

class ArxivRateLimitedError extends Error {
    constructor(msg) { super(msg ?? "rate-limited"); this.name = "ArxivRateLimitedError"; }
}

// Node fetch adapter that mimics Obsidian's requestUrl response shape.
// This is the ONE mock — Obsidian's framework code is unavailable outside
// the plugin host, but the real arxiv API is what we're actually testing.
async function obsidianRequestUrlMock(opts) {
    const ctrl = new AbortController();
    // Honor opts.signal-style cancellation if requestWithTimeout aborts us.
    const res = await fetch(opts.url, { headers: opts.headers, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return {
        status: res.status,
        text,
        json,
        headers: Object.fromEntries(res.headers.entries()),
        arrayBuffer: new ArrayBuffer(0),
    };
}

async function arxivRequest(url, { maxRetries = 2, timeoutMs = 10000, onRetry = () => {}, requestFn = obsidianRequestUrlMock } = {}) {
    let consecutiveTimeouts = 0;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await arxivRateLimit();
        try {
            const res = await requestWithTimeout({
                url, throw: false, headers: { "User-Agent": POLITE_UA },
            }, timeoutMs, requestFn);
            if (res.status === 200) return res;
            if (res.status === 429 || res.status === 503) {
                if (attempt === maxRetries) throw new ArxivRateLimitedError();
                const backoff = RATE_LIMIT_BACKOFFS_MS[Math.min(attempt, RATE_LIMIT_BACKOFFS_MS.length - 1)];
                onRetry(attempt + 1, backoff, `rate-limited (HTTP ${res.status})`);
                await new Promise(r => setTimeout(r, backoff));
                continue;
            }
            throw new Error(`arXiv HTTP ${res.status}`);
        } catch (e) {
            if (e instanceof ArxivRateLimitedError) throw e;
            const isTimeout = e.message === "TIMEOUT";
            const isNetwork = isTimeout || /ECONN|ENET|network|request|fetch/i.test(e.message);
            if (isTimeout) consecutiveTimeouts++; else consecutiveTimeouts = 0;
            if (consecutiveTimeouts >= 2) {
                throw new ArxivRateLimitedError("arXiv tarpitting (repeated timeouts)");
            }
            if (!isNetwork || attempt === maxRetries) {
                if (isTimeout) throw new ArxivRateLimitedError("arXiv timed out repeatedly");
                throw e;
            }
            const backoffTable = isTimeout ? RATE_LIMIT_BACKOFFS_MS : NETWORK_BACKOFFS_MS;
            const backoff = backoffTable[Math.min(attempt, backoffTable.length - 1)];
            onRetry(attempt + 1, backoff, isTimeout ? "timeout" : `network: ${e.message}`);
            await new Promise(r => setTimeout(r, backoff));
        }
    }
    throw new Error("exhausted");
}

async function openAlexLookup(arxivId, userEmail, requestFn = obsidianRequestUrlMock) {
    const mailto = (userEmail && userEmail.trim()) || "obsidian-papers@example.com";
    const url = `https://api.openalex.org/works/doi:10.48550/arXiv.${arxivId}?mailto=${encodeURIComponent(mailto)}`;
    const res = await requestWithTimeout({
        url, throw: false, headers: { "User-Agent": POLITE_UA },
    }, 10000, requestFn);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`OpenAlex HTTP ${res.status}`);
    const j = res.json;
    const title = (j.title || "").trim().replace(/\s+/g, " ");
    if (!title) return null;
    const authors = (j.authorships || []).map(a => a.author?.display_name || "").filter(Boolean);
    return { title, authors, year: j.publication_year ?? 0, url: `https://arxiv.org/abs/${arxivId}` };
}

// Mirrors fetchArxivMetadata logic from main.ts
async function fetchPaperEndToEnd(arxivId, userEmail = "") {
    try {
        const res = await arxivRequest(`https://export.arxiv.org/api/query?id_list=${arxivId}`);
        const entryMatch = res.text.match(/<entry>([\s\S]*?)<\/entry>/);
        if (!entryMatch) return { source: "arxiv", metadata: null };
        const title = entryMatch[1].match(/<title>([\s\S]*?)<\/title>/)?.[1].trim().replace(/\s+/g, " ") || "";
        return { source: "arxiv", metadata: { title, arxivId } };
    } catch (e) {
        if (e instanceof ArxivRateLimitedError) {
            const fallback = await openAlexLookup(arxivId, userEmail);
            if (fallback) return { source: "openalex", metadata: fallback };
            return { source: "openalex", metadata: null, error: "OpenAlex 404" };
        }
        throw e;
    }
}

// === Note title helpers (mirror main.ts) ===
const lastName = (fullName) => {
    const parts = fullName.trim().split(/\s+/);
    return parts[parts.length - 1] || fullName;
};

const formatAuthorsForTitle = (authors) => {
    if (authors.length === 0) return "Unknown";
    const first = lastName(authors[0]);
    if (authors.length === 1) return first;
    if (authors.length === 2) return `${first} & ${lastName(authors[1])}`;
    return `${first} et al.`;
};

const generateNoteTitle = (template, metadata) => template
    .replace(/\{authors\}/g, formatAuthorsForTitle(metadata.authors))
    .replace(/\{year\}/g, String(metadata.year))
    .replace(/\{title\}/g, metadata.title);

function* letterSuffixes() {
    const chars = "abcdefghijklmnopqrstuvwxyz";
    for (const c of chars) yield c;
    for (const a of chars) for (const b of chars) yield a + b;
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// In-memory analog of resolveNoteTitleConflict — takes a set of existing names
// instead of hitting the vault adapter, so we can unit-test the logic deterministically.
function resolveNoteTitleConflictSync(existingNames, baseTitle) {
    const set = new Set(existingNames);
    const bareExists = set.has(baseTitle);
    const suffixPattern = new RegExp(`^${escapeRegex(baseTitle)}([a-z]+)$`);
    const usedLetters = new Set();
    for (const name of set) {
        const m = name.match(suffixPattern);
        if (m) usedLetters.add(m[1]);
    }
    if (!bareExists && usedLetters.size === 0) return { newTitle: baseTitle };
    const nextFreeLetter = (used) => {
        for (const l of letterSuffixes()) if (!used.has(l)) return l;
        throw new Error("ran out of suffixes");
    };
    if (bareExists) {
        const bareLetter = nextFreeLetter(usedLetters);
        usedLetters.add(bareLetter);
        return {
            newTitle: baseTitle + nextFreeLetter(usedLetters),
            renameExistingFrom: baseTitle,
            renameExistingTo: baseTitle + bareLetter,
        };
    }
    return { newTitle: baseTitle + nextFreeLetter(usedLetters) };
}

// === Test harness ===
const results = [];
async function test(name, fn) {
    const t0 = Date.now();
    try {
        await fn();
        const ms = Date.now() - t0;
        results.push({ name, ok: true, ms });
        console.log(`  PASS  ${name} (${ms}ms)`);
    } catch (e) {
        const ms = Date.now() - t0;
        results.push({ name, ok: false, err: e, ms });
        console.log(`  FAIL  ${name} (${ms}ms): ${e.message}`);
    }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// === Tests against live arxiv ===

await test("REAL arxiv: single metadata fetch for 1706.03762", async () => {
    resetRateLimiter();
    const res = await arxivRequest("https://export.arxiv.org/api/query?id_list=1706.03762");
    assert(res.status === 200, `status=${res.status}`);
    assert(res.text.includes("<entry>"), "expected <entry> in response");
    assert(/Attention.*Need/i.test(res.text), "expected 'Attention Is All You Need' in response");
});

await test("REAL arxiv: rate limiter spaces 3 sequential fetches ~3s apart", async () => {
    resetRateLimiter();
    // Capture the timestamp of each ACTUAL request firing (after the rate
    // limiter wait), not the loop iteration start.
    const fireTimes = [];
    const captureFn = async (opts) => { fireTimes.push(Date.now()); return obsidianRequestUrlMock(opts); };
    const ids = ["1706.03762", "2103.00020", "1810.04805"];
    for (const id of ids) {
        await arxivRequest(`https://export.arxiv.org/api/query?id_list=${id}`, { requestFn: captureFn });
    }
    const gaps = fireTimes.slice(1).map((t, i) => t - fireTimes[i]);
    assert(gaps.every(g => g >= 2900), `gaps=${gaps.join(",")}ms (expected >=2900)`);
});

await test("REAL flow: metadata + PDF burst spaced by rate limiter", async () => {
    resetRateLimiter();
    const t0 = Date.now();
    const meta = await arxivRequest("https://export.arxiv.org/api/query?id_list=1706.03762");
    assert(meta.status === 200, `metadata status=${meta.status}`);
    const tMeta = Date.now() - t0;
    const pdf = await arxivRequest("https://arxiv.org/pdf/1706.03762.pdf", { timeoutMs: 60000 });
    assert(pdf.status === 200, `pdf status=${pdf.status}`);
    const tPdf = Date.now() - t0;
    assert(tPdf - tMeta >= 2900, `gap was ${tPdf - tMeta}ms (expected >=2900)`);
    assert(pdf.text.length > 100000, `pdf body was only ${pdf.text.length} bytes`);
});

await test("REAL OpenAlex: fetches metadata for a post-2022 paper (2604.12002)", async () => {
    const meta = await openAlexLookup("2604.12002", "");
    assert(meta !== null, "OpenAlex returned null for 2604.12002");
    assert(meta.title && meta.title.length > 5, `title=${meta.title}`);
    assert(meta.year >= 2022, `year=${meta.year}`);
    assert(meta.authors.length > 0, "expected at least 1 author");
});

await test("REAL fallback: tarpitted arxiv ID falls back to OpenAlex", async () => {
    // 2604.12002 has been in arxiv penalty for our IP at times during testing.
    // If arxiv currently serves it, fine — the fallback path is exercised
    // deterministically by the next test using a mock requestFn.
    resetRateLimiter();
    const result = await fetchPaperEndToEnd("2604.12002");
    assert(result.metadata !== null, `fetchPaperEndToEnd returned no metadata: ${result.error}`);
    console.log(`     source=${result.source} title="${result.metadata.title?.slice(0, 60) ?? "n/a"}"`);
});

await test("DETERMINISTIC: arxiv timeout -> OpenAlex fallback fires", async () => {
    // Simulate the exact production failure mode: arxiv hangs (tarpit),
    // OpenAlex is reachable. The end-to-end logic must surface OpenAlex's
    // metadata to the user. This is the regression test for the bug where
    // repeated timeouts threw a generic Error instead of ArxivRateLimitedError.
    resetRateLimiter();
    // Shorten backoffs so the test doesn't take 70+ seconds.
    const origBackoffs = RATE_LIMIT_BACKOFFS_MS.slice();
    RATE_LIMIT_BACKOFFS_MS.fill(50);

    try {
        // requestFn that hangs for arxiv.org, real fetch for openalex.org
        const fakeRequest = (opts) => {
            if (opts.url.includes("arxiv.org")) return new Promise(() => { /* hang */ });
            return obsidianRequestUrlMock(opts);
        };
        // Inline a version of fetchPaperEndToEnd using the injected requestFn
        const arxivId = "2604.12002"; // post-2022, exists in OpenAlex
        let result;
        try {
            await arxivRequest(`https://export.arxiv.org/api/query?id_list=${arxivId}`, {
                timeoutMs: 200, requestFn: fakeRequest,
            });
            result = { source: "arxiv-unexpected" };
        } catch (e) {
            assert(e instanceof ArxivRateLimitedError,
                `expected ArxivRateLimitedError on timeout, got ${e.constructor.name}: ${e.message}`);
            const fallback = await openAlexLookup(arxivId, "", obsidianRequestUrlMock);
            assert(fallback !== null, "OpenAlex returned null");
            result = { source: "openalex", metadata: fallback };
        }
        assert(result.source === "openalex", `expected openalex, got ${result.source}`);
        assert(result.metadata.title.length > 5, `title=${result.metadata.title}`);
        console.log(`     timeout -> OpenAlex worked: "${result.metadata.title.slice(0, 60)}"`);
    } finally {
        for (let i = 0; i < origBackoffs.length; i++) RATE_LIMIT_BACKOFFS_MS[i] = origBackoffs[i];
    }
});

// === Note title tests ===

await test("title: single author -> 'Lastname Year'", async () => {
    const t = generateNoteTitle("{authors} {year}", {
        title: "Foo", authors: ["Ashish Vaswani"], year: 2017, url: "",
    });
    assert(t === "Vaswani 2017", `got: ${t}`);
});

await test("title: two authors -> 'A & B Year'", async () => {
    const t = generateNoteTitle("{authors} {year}", {
        title: "Foo", authors: ["Ashish Vaswani", "Noam Shazeer"], year: 2017, url: "",
    });
    assert(t === "Vaswani & Shazeer 2017", `got: ${t}`);
});

await test("title: 3+ authors -> 'A et al. Year'", async () => {
    const t = generateNoteTitle("{authors} {year}", {
        title: "Foo", authors: ["A One", "B Two", "C Three", "D Four"], year: 2023, url: "",
    });
    assert(t === "One et al. 2023", `got: ${t}`);
});

await test("title: multi-word surname collapses to final token (known limitation)", async () => {
    const t = generateNoteTitle("{authors} {year}", {
        title: "t", authors: ["Laurens van der Maaten"], year: 2008, url: "",
    });
    assert(t === "Maaten 2008", `got: ${t}`);
});

await test("title: zero authors -> 'Unknown'", async () => {
    const t = generateNoteTitle("{authors} {year}", {
        title: "t", authors: [], year: 2020, url: "",
    });
    assert(t === "Unknown 2020", `got: ${t}`);
});

await test("title: custom template with {title} placeholder", async () => {
    const t = generateNoteTitle("{title} ({authors}, {year})", {
        title: "Foo", authors: ["A B", "C D"], year: 2021, url: "",
    });
    assert(t === "Foo (B & D, 2021)", `got: ${t}`);
});

await test("conflict: no existing notes -> bare title, no rename", async () => {
    const r = resolveNoteTitleConflictSync([], "Smith 2023");
    assert(r.newTitle === "Smith 2023", `newTitle=${r.newTitle}`);
    assert(!r.renameExistingFrom, "should not rename");
});

await test("conflict: bare exists -> rename bare to 'a', new becomes 'b'", async () => {
    const r = resolveNoteTitleConflictSync(["Smith 2023"], "Smith 2023");
    assert(r.renameExistingFrom === "Smith 2023", `renameFrom=${r.renameExistingFrom}`);
    assert(r.renameExistingTo === "Smith 2023a", `renameTo=${r.renameExistingTo}`);
    assert(r.newTitle === "Smith 2023b", `newTitle=${r.newTitle}`);
});

await test("conflict: a+b exist (no bare) -> new becomes 'c', no rename", async () => {
    const r = resolveNoteTitleConflictSync(["Smith 2023a", "Smith 2023b"], "Smith 2023");
    assert(r.newTitle === "Smith 2023c", `newTitle=${r.newTitle}`);
    assert(!r.renameExistingFrom, "should not rename");
});

await test("conflict: bare + a + b exist (rare manual case) -> rename bare to 'c', new becomes 'd'", async () => {
    const r = resolveNoteTitleConflictSync(["Smith 2023", "Smith 2023a", "Smith 2023b"], "Smith 2023");
    assert(r.renameExistingFrom === "Smith 2023", `renameFrom=${r.renameExistingFrom}`);
    assert(r.renameExistingTo === "Smith 2023c", `renameTo=${r.renameExistingTo}`);
    assert(r.newTitle === "Smith 2023d", `newTitle=${r.newTitle}`);
});

await test("conflict: unrelated notes in folder don't trigger suffix", async () => {
    const r = resolveNoteTitleConflictSync(["Jones 2024", "Smith 2022", "Smith and others 2023"], "Smith 2023");
    assert(r.newTitle === "Smith 2023", `newTitle=${r.newTitle}`);
});

await test("conflict: a..z used -> next is 'aa'", async () => {
    const all26 = "abcdefghijklmnopqrstuvwxyz".split("").map(c => "Smith 2023" + c);
    const r = resolveNoteTitleConflictSync(all26, "Smith 2023");
    assert(r.newTitle === "Smith 2023aa", `newTitle=${r.newTitle}`);
});

// === ALPHAXIV placeholder tests (mirror formatNoteContent logic) ===

const extractArxivId = (url) => {
    const m = url.match(/(?:arxiv\.org\/(?:abs|pdf|html)|alphaxiv\.org\/abs)\/(\d{4}\.\d{4,5})(v\d+)?/);
    return m ? m[1] : null;
};
const renderAlphaxiv = (url) => {
    const id = extractArxivId(url);
    return id ? `https://www.alphaxiv.org/abs/${id}` : "";
};

await test("alphaxiv: arxiv /abs/ URL -> alphaxiv.org/abs/<id>", async () => {
    const got = renderAlphaxiv("https://arxiv.org/abs/1706.03762");
    assert(got === "https://www.alphaxiv.org/abs/1706.03762", `got: ${got}`);
});

await test("alphaxiv: arxiv /pdf/ URL -> alphaxiv.org/abs/<id>", async () => {
    const got = renderAlphaxiv("https://arxiv.org/pdf/2604.12002");
    assert(got === "https://www.alphaxiv.org/abs/2604.12002", `got: ${got}`);
});

await test("alphaxiv: versioned arxiv URL strips version", async () => {
    const got = renderAlphaxiv("https://arxiv.org/abs/1706.03762v5");
    assert(got === "https://www.alphaxiv.org/abs/1706.03762", `got: ${got}`);
});

await test("alphaxiv: non-arxiv URL -> empty string", async () => {
    const got = renderAlphaxiv("https://example.com/paper.pdf");
    assert(got === "", `got: "${got}"`);
});

await test("input: alphaxiv URL -> extracts arxiv id", async () => {
    const id = extractArxivId("https://www.alphaxiv.org/abs/2606.06021");
    assert(id === "2606.06021", `got: ${id}`);
});

await test("input: alphaxiv URL with chatId query string -> extracts arxiv id", async () => {
    const id = extractArxivId("https://www.alphaxiv.org/abs/2606.06021?chatId=019ea43a-0b76-7b44-a583-3e92569693c0");
    assert(id === "2606.06021", `got: ${id}`);
});

await test("input: alphaxiv URL without www -> extracts arxiv id", async () => {
    const id = extractArxivId("https://alphaxiv.org/abs/1706.03762");
    assert(id === "1706.03762", `got: ${id}`);
});

await test("input: alphaxiv URL round-trips to alphaxiv URL via renderAlphaxiv", async () => {
    const got = renderAlphaxiv("https://www.alphaxiv.org/abs/2606.06021?chatId=foo");
    assert(got === "https://www.alphaxiv.org/abs/2606.06021", `got: ${got}`);
});

// === Summary ===
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} tests passed`);
process.exit(passed === total ? 0 : 1);

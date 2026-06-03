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
const POLITE_UA = "obsidian-papers/1.0.2 (+https://github.com/willjhliang/obsidian-papers)";
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

// === Summary ===
const passed = results.filter(r => r.ok).length;
const total = results.length;
console.log(`\n${passed}/${total} tests passed`);
process.exit(passed === total ? 0 : 1);

import {
    App,
    Modal,
    Notice,
    Plugin,
    PluginSettingTab,
    RequestUrlParam,
    RequestUrlResponse,
    Setting,
    SuggestModal,
    TFile,
    requestUrl,
} from "obsidian";

import compareTwoStrings from 'string-similarity-js';

interface Settings {
    notesFolder: string;
    pdfFolder: string;
    noteTemplate: string;
    userEmail: string;
}

const DEFAULT_SETTINGS: Settings = {
    notesFolder: "",
    pdfFolder: "",
    noteTemplate: `---
title: "{{TITLE}}"
authors:
{{AUTHORS}}
year: {{YEAR}}
url: {{URL}}
---
![[{{PDF}}]]`,
    userEmail: "",
};

interface PaperMetadata {
    title: string;
    authors: string[];
    year: number;
    url: string;
}

const sanitizeTitle = (title: string): string =>
    title.toLowerCase().replace(/[-:,.]/g, ' ').replace(/\s+/g, ' ').trim();

const extractArxivId = (url: string): string | null => {
    const match = url.match(/arxiv\.org\/(abs|pdf|html)\/(\d{4}\.\d{4,5})(v\d+)?/);
    return match ? match[2] : null;
};

// arXiv asks for ≥3s between requests; their throttle is per-IP via Fastly.
// VPN users share an egress IP, so they get throttled by the whole pool.
const ARXIV_MIN_GAP_MS = 3000;
const POLITE_UA = "obsidian-papers/1.0.2 (+https://github.com/willjhliang/obsidian-papers)";
const RATE_LIMIT_BACKOFFS_MS = [10000, 30000, 60000];
const NETWORK_BACKOFFS_MS = [4000, 8000, 16000];

let lastArxivCallAt = 0;
async function arxivRateLimit(): Promise<void> {
    const gap = Date.now() - lastArxivCallAt;
    if (gap < ARXIV_MIN_GAP_MS) {
        await new Promise(r => setTimeout(r, ARXIV_MIN_GAP_MS - gap));
    }
    lastArxivCallAt = Date.now();
}

// Wrap requestUrl with a wall-clock timeout. Obsidian's requestUrl has no
// timeout option, and arXiv "tarpits" 429 responses for 15-46s — we abort
// fast and retry instead of waiting.
function requestWithTimeout(
    opts: RequestUrlParam,
    timeoutMs: number,
    requestFn: (opts: RequestUrlParam) => Promise<RequestUrlResponse> = requestUrl,
): Promise<RequestUrlResponse> {
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

interface ArxivRequestOpts {
    maxRetries?: number;
    timeoutMs?: number;
    onRetry?: (attempt: number, backoffMs: number, reason: string) => void;
    requestFn?: (opts: RequestUrlParam) => Promise<RequestUrlResponse>;
}

class ArxivRateLimitedError extends Error {
    constructor(msg = "arXiv is rate-limiting your IP. Please wait ~1 minute and retry.") {
        super(msg);
        this.name = "ArxivRateLimitedError";
    }
}

async function arxivRequest(url: string, opts: ArxivRequestOpts = {}): Promise<RequestUrlResponse> {
    const maxRetries = opts.maxRetries ?? 2;
    const timeoutMs = opts.timeoutMs ?? 10000;
    const onRetry = opts.onRetry ?? (() => { });
    const requestFn = opts.requestFn ?? requestUrl;

    // Track timeouts separately — arxiv "tarpits" rate-limited requests by
    // holding the connection open until our client timeout fires, so repeated
    // timeouts on the same URL are equivalent to a 429 in disguise.
    let consecutiveTimeouts = 0;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        await arxivRateLimit();
        try {
            const res = await requestWithTimeout({
                url,
                throw: false,
                headers: { "User-Agent": POLITE_UA },
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
            const err = e as Error;
            if (err instanceof ArxivRateLimitedError) throw err;
            const isTimeout = err.message === "TIMEOUT";
            const isNetwork = isTimeout || /ECONN|ENET|network|request|fetch/i.test(err.message);

            if (isTimeout) consecutiveTimeouts++; else consecutiveTimeouts = 0;

            // Two timeouts in a row almost certainly means we're tarpitted —
            // surface as rate-limit so the caller's OpenAlex fallback fires
            // instead of bouncing through more useless retries.
            if (consecutiveTimeouts >= 2) {
                throw new ArxivRateLimitedError(
                    "arXiv is tarpitting your IP (repeated timeouts). Falling back to OpenAlex.",
                );
            }

            if (!isNetwork || attempt === maxRetries) {
                if (isTimeout) throw new ArxivRateLimitedError("arXiv timed out repeatedly. Falling back to OpenAlex.");
                throw err;
            }

            // Use longer rate-limit backoffs on timeouts (likely tarpit),
            // short network backoffs only for genuine network errors.
            const backoffTable = isTimeout ? RATE_LIMIT_BACKOFFS_MS : NETWORK_BACKOFFS_MS;
            const backoff = backoffTable[Math.min(attempt, backoffTable.length - 1)];
            onRetry(attempt + 1, backoff, isTimeout ? "timeout (likely throttled)" : `network error: ${err.message}`);
            await new Promise(r => setTimeout(r, backoff));
        }
    }
    throw new Error("arxivRequest: exhausted retries");
}

// Fallback: OpenAlex doesn't share arXiv's IP throttle. Covers arXiv papers
// that have the 10.48550/arXiv.<id> DOI (assigned for papers ≥ 2022).
// Older papers will 404 here; the caller should surface a clear error.
async function openAlexLookup(
    arxivId: string,
    userEmail: string,
    requestFn: (opts: RequestUrlParam) => Promise<RequestUrlResponse> = requestUrl,
): Promise<PaperMetadata | null> {
    const mailto = (userEmail && userEmail.trim()) || "obsidian-papers@example.com";
    const url = `https://api.openalex.org/works/doi:10.48550/arXiv.${arxivId}?mailto=${encodeURIComponent(mailto)}`;
    const res = await requestWithTimeout({
        url,
        throw: false,
        headers: { "User-Agent": POLITE_UA },
    }, 10000, requestFn);
    if (res.status === 404) return null;
    if (res.status !== 200) throw new Error(`OpenAlex HTTP ${res.status}`);

    const j = res.json as {
        title?: string;
        publication_year?: number;
        authorships?: Array<{ author?: { display_name?: string } }>;
    };
    const title = (j.title || "").trim().replace(/\s+/g, " ");
    if (!title) return null;
    const authors = (j.authorships || [])
        .map(a => a.author?.display_name || "")
        .filter(Boolean);
    const year = j.publication_year ?? new Date().getFullYear();
    return { title, authors, year, url: `https://arxiv.org/abs/${arxivId}` };
}

export default class PapersPlugin extends Plugin {
    settings: Settings;

    async onload() {
        await this.loadSettings();

        this.addCommand({
            id: "import",
            name: "Import",
            callback: () => this.showImportModal(),
        });

        this.addCommand({
            id: "import-from-clipboard",
            name: "Import from clipboard",
            callback: () => this.createNoteFromClipboard(),
        });

        this.addSettingTab(new PapersSettingTab(this.app, this));
    }

    showImportModal() {
        new ImportSelectModal(this.app, async (choice) => {
            if (!choice) return;

            if (choice.isArxivUrl) {
                await this.processArxivUrl(choice.input);
            } else {
                await this.createNoteFromMetadata(choice);
            }
        }).open();
    }

    async processArxivUrl(input: string) {
        const arxivId = extractArxivId(input);
        if (!arxivId) {
            new Notice("Invalid arXiv URL.");
            return;
        }

        const metadataNotice = new Notice("Fetching paper metadata from arXiv...", 0);

        try {
            const metadata = await this.fetchArxivMetadata(arxivId, msg => {
                metadataNotice.setMessage(msg);
            });
            metadataNotice.hide();

            if (!metadata) {
                new Notice("No metadata found for this arXiv paper (does it exist?).");
                return;
            }

            await this.createNoteFromMetadata(metadata);
        } catch (error) {
            metadataNotice.hide();
            if (error instanceof ArxivRateLimitedError) {
                new Notice(error.message, 8000);
            } else {
                new Notice(`Failed to fetch paper metadata: ${(error as Error).message}`, 8000);
            }
            console.error("Metadata fetch error:", error);
        }
    }

    async createNoteFromClipboard() {
        const clipboardText = await navigator.clipboard.readText();
        if (!clipboardText?.trim()) {
            new Notice("Clipboard is empty.");
            return;
        }

        if (extractArxivId(clipboardText)) {
            await this.processArxivUrl(clipboardText.trim());
            return;
        }

        const modal = new ImportSelectModal(this.app, async (choice) => {
            if (!choice) return;

            if (choice.isArxivUrl) {
                await this.processArxivUrl(choice.input);
            } else {
                await this.createNoteFromMetadata(choice);
            }
        });

        // Pre-fill and auto-search for clipboard content
        modal.currentInput = clipboardText.trim();
        modal.onOpen = function () {
            SuggestModal.prototype.onOpen.call(this);
            setTimeout(() => {
                if (this.inputEl) {
                    this.inputEl.value = clipboardText.trim();
                    this.inputEl.focus();
                    this.performSearch();
                }
            }, 10);
        };

        modal.open();
    }

    async createNoteFromMetadata(metadata: PaperMetadata) {
        const filename = this.sanitizeFileName(metadata.title) + ".md";
        const folderPath = this.settings.notesFolder?.trim()
            ? this.settings.notesFolder.trim().replace(/\/$/, "") + "/"
            : "";
        const filePath = folderPath + filename;

        const fileExists = await this.app.vault.adapter.exists(filePath);
        if (fileExists && !(await this.confirmOverwrite())) return;

        let pdfFilename = "";
        if (this.settings.noteTemplate.includes("{{PDF}}") && metadata.url.includes('arxiv.org')) {
            try {
                pdfFilename = await this.downloadPdf(metadata);
            } catch (error) {
                new Notice(`PDF download failed: ${error.message}`);
                console.error("PDF download error:", error);
            }
        }

        const content = this.formatNoteContent(metadata, pdfFilename);

        try {
            if (fileExists) {
                const file = await this.app.vault.getAbstractFileByPath(filePath);
                if (file instanceof TFile) {
                    await this.app.vault.modify(file, content);
                }
            } else {
                await this.app.vault.create(filePath, content);
            }

            new Notice("Created paper note: " + filename);

            const file = await this.app.vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf(true).openFile(file);
            }
        } catch (err) {
            new Notice("Error creating note: " + err);
        }
    }

    async downloadPdf(metadata: PaperMetadata): Promise<string> {
        const arxivId = extractArxivId(metadata.url);
        if (!arxivId) throw new Error("Could not extract arXiv ID from URL");

        const pdfFilename = this.sanitizeFileName(metadata.title) + ".pdf";
        const pdfFolderPath = this.settings.pdfFolder?.trim()
            ? this.settings.pdfFolder.trim().replace(/\/$/, "") + "/"
            : "";

        if (pdfFolderPath && !(await this.app.vault.adapter.exists(pdfFolderPath.slice(0, -1)))) {
            throw new Error(`PDF folder "${this.settings.pdfFolder}" doesn't exist. Please create it first.`);
        }

        const pdfPath = pdfFolderPath + pdfFilename;

        if (await this.app.vault.adapter.exists(pdfPath)) {
            return pdfFilename;
        }

        const progressNotice = new Notice("", 0);

        try {
            const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
            progressNotice.setMessage(`Downloading PDF for "${metadata.title}"...`);

            const response = await arxivRequest(pdfUrl, {
                timeoutMs: 60000,
                onRetry: (attempt, backoffMs, reason) => {
                    progressNotice.setMessage(
                        `PDF ${reason}, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt})...`,
                    );
                },
            });

            if (!response.arrayBuffer) {
                throw new Error("Failed to download PDF content");
            }

            const uint8Array = new Uint8Array(response.arrayBuffer);
            await this.app.vault.adapter.writeBinary(pdfPath, uint8Array);

            progressNotice.hide();
            return pdfFilename;
        } catch (error) {
            progressNotice.setMessage(`Failed to download PDF for "${metadata.title}"`);
            setTimeout(() => progressNotice.hide(), 5000);
            throw new Error(`Failed to download PDF: ${error.message}`);
        }
    }

    async fetchArxivMetadata(
        arxivId: string,
        onStatus: (msg: string) => void = () => { },
    ): Promise<PaperMetadata | null> {
        const url = `https://export.arxiv.org/api/query?id_list=${arxivId}`;
        try {
            const response = await arxivRequest(url, {
                onRetry: (attempt, backoffMs, reason) => {
                    onStatus(`arXiv ${reason}, retrying in ${Math.round(backoffMs / 1000)}s (attempt ${attempt})...`);
                },
            });

            const parser = new DOMParser();
            const xml = parser.parseFromString(response.text, "application/xml");
            const entry = xml.querySelector("entry");
            if (!entry) return null;

            const title = entry.querySelector("title")?.textContent?.trim().replace(/\s+/g, " ") || "";
            const authors = Array.from(entry.querySelectorAll("author > name")).map(e => e.textContent || "");
            const published = entry.querySelector("published")?.textContent || "";
            const year = new Date(published).getFullYear();

            return { title, authors, year, url: `https://arxiv.org/abs/${arxivId}` };
        } catch (error) {
            if (error instanceof ArxivRateLimitedError) {
                onStatus("arXiv exhausted — trying OpenAlex...");
                try {
                    const fallback = await openAlexLookup(arxivId, this.settings.userEmail);
                    if (fallback) return fallback;
                    throw new ArxivRateLimitedError(
                        "arXiv rate-limited and OpenAlex has no record for this ID. Please wait ~1 minute and retry.",
                    );
                } catch (oaErr) {
                    console.error("OpenAlex fallback failed:", oaErr);
                    if (oaErr instanceof ArxivRateLimitedError) throw oaErr;
                    throw error;
                }
            }
            throw error;
        }
    }

    sanitizeFileName(title: string): string {
        return title
            .replace(/:/g, " - ")
            .replace(/[\\/:*?"<>|]/g, "")
            .replace(/\s{2,}/g, " ") // Collapse 2+ spaces into 1
            .trim();
    }

    formatNoteContent(metadata: PaperMetadata, pdfFilename = ""): string {
        let content = this.settings.noteTemplate;
        const authorsYaml = metadata.authors.map(author => `  - ${author}`).join('\n');

        return content
            .replace(/\{\{TITLE\}\}/g, this.sanitizeFileName(metadata.title))
            .replace(/\{\{URL\}\}/g, metadata.url)
            .replace(/\{\{YEAR\}\}/g, metadata.year.toString())
            .replace(/\{\{AUTHORS\}\}/g, authorsYaml)
            .replace(/\{\{PDF\}\}/g, pdfFilename);
    }

    confirmOverwrite(): Promise<boolean> {
        return new Promise(resolve => {
            new ConfirmOverwriteModal(this.app, resolve).open();
        });
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

class ImportSelectModal extends SuggestModal<PaperMetadata> {
    choices: PaperMetadata[] = [];
    onChoice: (choice: any | null) => void;
    loading = false;
    hasSearched = false;
    currentInput = "";

    constructor(app: App, onChoice: (choice: any | null) => void) {
        super(app);
        this.onChoice = onChoice;
        this.setPlaceholder("Search paper title or arXiv URL...");
    }

    onOpen() {
        super.onOpen();

        // if (this.resultContainerEl) {
        //     this.resultContainerEl.style.display = 'none';
        // }
        if (this.resultContainerEl) this.resultContainerEl.hide();

        setTimeout(() => {
            if (this.inputEl) {
                this.inputEl.focus();
                this.inputEl.addEventListener('keyup', (e) => {
                    if (e.key === 'Enter' && !this.hasSearched && !this.loading) {
                        e.preventDefault();
                        e.stopPropagation();
                        e.stopImmediatePropagation();
                        this.performSearch();
                    }
                });
            }
        }, 10);
    }

    getSuggestions(query: string): PaperMetadata[] {
        this.currentInput = query;

        if (this.loading || !this.hasSearched || !this.choices.length) {
            return [];
        }

        const sanitized = sanitizeTitle(query);
        return this.choices
            .filter(choice => {
                const sim = compareTwoStrings(sanitizeTitle(choice.title), sanitized);
                return sim > 0.3;
            })
            .sort((a, b) => {
                const simA = compareTwoStrings(sanitizeTitle(a.title), sanitized);
                const simB = compareTwoStrings(sanitizeTitle(b.title), sanitized);
                return simB - simA;
            });
    }

    renderSuggestion(choice: PaperMetadata, el: HTMLElement) {
        el.createEl("div", { text: choice.title });
        if (choice.authors?.length) {
            el.createEl("small", { text: choice.authors.join(", ") });
        }
    }

    onChooseSuggestion(item: PaperMetadata) {
        this.onChoice(item);
    }

    manualRefresh() {
        setTimeout(() => {
            if (this.inputEl) {
                this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, 0);
    }

    async performSearch() {
        const input = this.inputEl?.value?.trim() || this.currentInput.trim();
        if (!input) return;

        if (extractArxivId(input)) {
            this.close();
            this.onChoice({ isArxivUrl: true, input });
            return;
        }

        this.setLoading(true);

        try {
            const results = await this.searchArxivByTitle(input);
            this.setSearchResults(results);
        } catch (error) {
            console.error("Search failed:", error);
            this.setSearchResults([]);
            this.emptyStateText = "Search failed. Please try again.";
            this.loading = false;
            this.hasSearched = true;
            if (this.inputEl) this.inputEl.disabled = false;
            this.manualRefresh();
        }
    }

    setLoading(isLoading: boolean) {
        this.loading = isLoading;

        if (this.inputEl) this.inputEl.disabled = isLoading;

        if (isLoading) {
            this.emptyStateText = "Searching arXiv...";
            this.hasSearched = true;
            // if (this.resultContainerEl) this.resultContainerEl.style.display = '';
            if (this.resultContainerEl) this.resultContainerEl.show();
        }

        this.manualRefresh();
    }

    setSearchResults(results: PaperMetadata[]) {
        this.loading = false;
        this.hasSearched = true;
        this.choices = results;

        // if (this.resultContainerEl) this.resultContainerEl.style.display = '';
        if (this.resultContainerEl) this.resultContainerEl.show();

        this.emptyStateText = results.length === 0 ? "No results found" : "No matching results";

        if (this.inputEl) this.inputEl.disabled = false;
        this.manualRefresh();
    }

    async searchArxivByTitle(title: string): Promise<PaperMetadata[]> {
        const sanitized = sanitizeTitle(title);
        const query = sanitized.split(' ').map(word => encodeURIComponent(word)).join('+');
        const url = `https://export.arxiv.org/api/query?search_query=ti:"${query}"&start=0&max_results=10`;

        const response = await arxivRequest(url, {
            onRetry: (attempt, backoffMs, reason) => {
                this.emptyStateText = `Searching arXiv (${reason}, retrying in ${Math.round(backoffMs / 1000)}s, attempt ${attempt})...`;
                this.manualRefresh();
            },
        });

        const parser = new DOMParser();
        const xml = parser.parseFromString(response.text, "application/xml");
        const entries = Array.from(xml.querySelectorAll("entry"));

        return entries.map(entry => {
            const title = entry.querySelector("title")?.textContent?.trim().replace(/\s+/g, " ") || "";
            const authors = Array.from(entry.querySelectorAll("author > name")).map(e => e.textContent || "");
            const published = entry.querySelector("published")?.textContent || "";
            const year = new Date(published).getFullYear();
            const id = entry.querySelector("id")?.textContent?.match(/\d{4}\.\d{4,5}/)?.[0] || "";

            return { title, authors, year, url: `https://arxiv.org/abs/${id}` };
        });
    }

    onCancel() {
        this.onChoice(null);
    }
}

class ConfirmOverwriteModal extends Modal {
    onDecision: (overwrite: boolean) => void;

    constructor(app: App, onDecision: (overwrite: boolean) => void) {
        super(app);
        this.onDecision = onDecision;
    }

    onOpen() {
        const { contentEl, titleEl } = this;

        titleEl.setText("File exists");
        contentEl.empty();
        contentEl.createEl("p", { text: "A note with this title already exists. Do you want to overwrite?" });

        const buttonContainer = contentEl.createDiv({ cls: "modal-button-container" });
        Object.assign(buttonContainer.style, {
            display: "flex",
            justifyContent: "flex-end",
            gap: "10px",
            marginTop: "30px"
        });

        const overwriteButton = buttonContainer.createEl("button", { text: "Overwrite", cls: "mod-warning" });
        overwriteButton.onclick = () => {
            this.close();
            this.onDecision(true);
        };

        const cancelButton = buttonContainer.createEl("button", { text: "Cancel" });
        cancelButton.onclick = () => {
            this.close();
            this.onDecision(false);
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}

class PapersSettingTab extends PluginSettingTab {
    plugin: PapersPlugin;

    constructor(app: App, plugin: PapersPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        new Setting(containerEl)
            .setName("Notes folder")
            .setDesc("Folder to save paper notes.")
            .addText(text =>
                text
                    .setPlaceholder("Example: Research/Papers")
                    .setValue(this.plugin.settings.notesFolder)
                    .onChange(async value => {
                        this.plugin.settings.notesFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("PDF folder")
            .setDesc("Folder to save PDFs. These are only downloaded if notes contain the {{PDF}} placeholder.")
            .addText(text =>
                text
                    .setPlaceholder("Example: Research/PDF")
                    .setValue(this.plugin.settings.pdfFolder)
                    .onChange(async value => {
                        this.plugin.settings.pdfFolder = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName("Contact email (optional)")
            .setDesc("Used as the OpenAlex \"mailto\" parameter for the polite-pool fallback when arXiv rate-limits you (common on VPNs). Leave blank to use a generic mailbox.")
            .addText(text =>
                text
                    .setPlaceholder("you@example.com")
                    .setValue(this.plugin.settings.userEmail)
                    .onChange(async value => {
                        this.plugin.settings.userEmail = value;
                        await this.plugin.saveSettings();
                    })
            );

        const templateSetting = new Setting(containerEl)
            .setName("Note template")
            .setDesc("Template for creating paper notes. Use {{TITLE}}, {{AUTHORS}}, {{YEAR}}, {{URL}}, and {{PDF}} to insert metadata.")
            .addTextArea(text => {
                text
                    .setPlaceholder(DEFAULT_SETTINGS.noteTemplate)
                    .setValue(this.plugin.settings.noteTemplate || DEFAULT_SETTINGS.noteTemplate)
                    .onChange(async value => {
                        this.plugin.settings.noteTemplate = value || DEFAULT_SETTINGS.noteTemplate;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 10;
                Object.assign(text.inputEl.style, {
                    width: "100%",
                    minWidth: "100%"
                });
            });

        Object.assign(templateSetting.settingEl.style, {
            display: "block"
        });

        const controlEl = templateSetting.settingEl.querySelector('.setting-item-control') as HTMLElement;
        if (controlEl) {
            Object.assign(controlEl.style, {
                marginTop: "10px"
            });
        }
    }
}
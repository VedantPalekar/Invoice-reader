# Invoice Reader

A Chrome (Manifest V3) browser extension that collects invoices from web
pages or PDF files, parses out the key fields, consolidates everything into
one table inside the popup, and exports the result to an Excel `.xlsx` file.

The extension is **fully client-side**. With AI extraction off, no network
calls are made. With AI extraction on, invoice text is sent only to the LLM
provider you choose (OpenAI or Anthropic), using your own API key.

## Features

- **Add the current tab as an invoice** — works on any HTML invoice rendered
  in a normal tab.
- **Upload one or many text-based PDFs** — text is extracted with PDF.js.
  PDF text is reconstructed from x/y coordinates so tabular layouts (which
  are common on invoices) preserve their column structure.
- **Hybrid extraction pipeline**, layered for accuracy:
  1. **schema.org structured data** (JSON-LD `Invoice` / `Order` / `Receipt`
     blocks) when the page exposes them — essentially ground truth.
  2. **LLM extraction** with strict JSON-schema output (OpenAI Chat
     Completions or Anthropic Messages) when an API key is configured.
  3. **Heuristic regex/label parser** as a always-on baseline and fallback.
- **Cross-field validation** — every row is checked for
  `subtotal + tax ≈ total`. Mismatches are highlighted with a warning so
  you can fix them in-place.
- **Inline-editable cells** — click any extracted value to correct it. The
  edit is saved immediately and the row is revalidated.
- **Per-field provenance** — hovering a cell shows where the value came from
  (`heuristic`, `schema.org`, `AI`, or `edited by you`).
- **Consolidated table** with persistent storage in `chrome.storage.local`.
- **One-click Excel export** with formatted money columns and source/notes
  metadata.

## File layout

```
invoicereader/
├── manifest.json           Manifest V3 declaration
├── background.js           Service worker (capture orchestration)
├── content.js              Visible-text scraper + JSON-LD detector
├── parser.js               Heuristic parser + validation + merge
├── llm.js                  OpenAI / Anthropic structured extraction
├── popup.html              Popup UI markup
├── popup.css               Popup styling (light + dark)
├── popup.js                Popup controller + hybrid pipeline
├── icons/                  Toolbar icons (16/32/48/128)
└── lib/
    ├── pdf.min.js
    ├── pdf.worker.min.js
    └── xlsx.full.min.js
```

## Loading the extension

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Enable **Developer mode** in the top-right.
3. Click **Load unpacked** and select this folder.
4. Pin the extension's icon to the toolbar (puzzle-piece menu → pin).

## Using it

### Heuristic mode (default, no setup)

1. Open an invoice in a normal tab and click the toolbar icon.
2. **Add current page as invoice**, or **Upload PDFs** for one or more PDF
   files. Each invoice becomes a row.
3. Review and **click any cell to correct** mistakes.
4. **Export to Excel** when done.

Heuristic mode is fast and free, but accuracy on the long tail of invoice
formats is moderate. Turn on AI extraction below for a meaningful jump in
accuracy.

### AI mode (recommended for accuracy)

1. Click the **gear icon** in the popup header.
2. Pick a provider (**OpenAI** or **Anthropic**).
3. Paste your API key. The "Get an API key →" link in the panel takes you
   to the right place to create one.
4. Optionally set a specific model. Defaults are:
   - OpenAI: `gpt-4o-mini` (fast, cheap, very accurate on invoices)
   - Anthropic: `claude-haiku-4-5`
5. Click **Test connection** to verify, then **Save**.

Once configured:

- The header shows an **AI · Provider · Model** chip so you know it's on.
- Every new invoice you add is run through the LLM with a strict JSON
  schema, so results are deterministic and clean.
- If the API call fails (network, key invalid, rate limit), the heuristic
  result is kept and you'll see a status message — your data is never lost.

#### Cost expectations

A typical invoice is 1–4 KB of text and the schema is ~10 fields. Per-invoice
cost with `gpt-4o-mini` or `claude-haiku-4-5` is well under $0.001
(usually a fraction of a cent).

#### Privacy

- API keys are stored in `chrome.storage.local` and never sent anywhere
  except to the provider you choose.
- Invoice text is sent to the configured provider only when you add an
  invoice. With AI off, **nothing leaves your machine**.

### Editing & validation

- **Click any cell** in the table — vendor, invoice number, date, money
  fields — to edit. **Enter** saves; **Esc** cancels.
- A small dot appears on cells you've corrected.
- A subtle ⚠ on the money columns means
  `subtotal + tax ≠ total` — fix one of the fields and the warning clears.
- Hover any cell to see where the value came from
  (`heuristic`, `schema.org`, `AI extracted`, or `edited by you`).

## How extraction works (high level)

```
HTML page  ──┐                                     ┌── editable cells
             │   content.js                        │
             ├── visible-text walk    ──┐          │
             │   + JSON-LD detect       │          │
             │                          ▼          │
PDF file   ──┴── pdf.js + spatial   ──► hybrid ──► table ──► xlsx
                  reconstruction       pipeline
                                          │
                                          ├── 1. heuristic parser (regex)
                                          ├── 2. JSON-LD merge (if any)
                                          └── 3. LLM merge (if configured)
                                                  │
                                                  ▼
                                            validation (Σ check)
```

The hybrid pipeline applies each successive layer's results on top of the
previous one, so any field the LLM (or schema.org) cannot determine still
falls back to the regex result rather than going blank.

## Permissions explained

| Permission                  | Why                                              |
| --------------------------- | ------------------------------------------------ |
| `storage`                   | Save invoices and settings on this device        |
| `activeTab` + `scripting`   | Read the focused tab when you click *Add current page* |
| `<all_urls>` host           | Required by `scripting.executeScript`            |
| `api.openai.com` host       | Send invoice text to OpenAI when AI mode is on   |
| `api.anthropic.com` host    | Send invoice text to Anthropic when AI mode is on |

## Limitations

- **Text-based PDFs only.** Scanned/image PDFs need OCR (out of scope here).
- **Single-frame.** Cross-origin iframes (e.g. embedded payment receipts)
  must be opened in their own tab first.
- **Browser-internal pages** (`chrome://`, `chrome-extension://`, web store)
  are blocked by Chrome from content scripts.
- **AI mode requires an API key.** The extension does not ship with one.

## Possible next steps

- OCR (Tesseract.js) for scanned PDFs.
- Per-vendor template learning (when the user repeatedly corrects the same
  field for invoices from a given vendor, remember and apply automatically).
- Local-only AI via Chrome's built-in Prompt API / Gemini Nano (currently in
  origin trial) so the extension can be 100% offline *and* AI-powered.
- Multi-currency aware rendering with a number formatter per row.

## Third-party libraries

- [PDF.js](https://mozilla.github.io/pdf.js/) — Apache-2.0
- [SheetJS Community Edition (xlsx)](https://github.com/SheetJS/sheetjs) — Apache-2.0

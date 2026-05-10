/*
 * popup.js
 * --------
 * UI controller for the extension popup. Owns:
 *
 *   - Persisted invoice list + settings in chrome.storage.local
 *   - Capturing the current tab via the background service worker
 *   - PDF text extraction (with x/y-coordinate aware reconstruction)
 *   - Hybrid extraction pipeline:
 *         schema.org JSON-LD  >  LLM (OpenAI / Anthropic)  >  heuristic
 *   - Cross-field validation (subtotal + tax ≈ total) with warning markers
 *   - Inline-editable cells with persisted user corrections
 *   - Settings overlay (provider / API key / model)
 *   - Excel export with SheetJS
 *
 * Loaded as a classic script after pdf.js, xlsx, parser.js, and llm.js
 * (see popup.html).
 */
(function () {
  "use strict";

  const STORAGE_KEY = "invoices";
  const SETTINGS_KEY = "settings";

  const DEFAULT_SETTINGS = {
    llm: {
      provider: "", // "" | "openai" | "anthropic"
      apiKey: "",
      model: "",
      /** "off" | "fallback" | "always" — when to rasterize PDF pages for AI vision */
      visionPdfMode: "fallback",
    },
  };

  // Rasterizing too many or too-large pages blows the request size budget
  // without adding accuracy. These caps are a sensible default for invoices.
  const VISION_MAX_PAGES = 4;
  const VISION_MAX_DIMENSION = 1800; // longest side, in pixels
  const VISION_JPEG_QUALITY = 0.85;

  /**
   * True when the PDF text layer is missing or too thin (likely scanned).
   * Used to decide vision/OCR-style extraction and low-confidence badges.
   */
  function isWeakPdfText(text) {
    const t = (text || "").trim();
    if (t.length < 48) return true;
    const letters = (t.match(/[a-zA-Z]/g) || []).length;
    if (letters < 20) return true;
    const digits = (t.match(/\d/g) || []).length;
    if (digits < 4 && letters < 40) return true;
    return false;
  }

  function lowConfidenceHint(reason) {
    const map = {
      "vision-ocr":
        "Low confidence: little text in PDF — fields used AI vision on page images. Verify all values.",
      "no-ai":
        "Low confidence: little text in PDF and AI is off — heuristics only. Turn on AI in Settings for vision.",
      "vision-disabled":
        "Low confidence: little text in PDF; PDF vision is off (text layer only). Enable vision in Settings.",
      "no-images":
        "Low confidence: little text in PDF and page images were not used (error or setting).",
      "no-text-layer":
        "Low confidence: little selectable text (likely scanned). This build has no OCR — try Invoice Reader v2 with AI vision.",
    };
    return map[reason] || "Low confidence — verify extracted fields.";
  }

  const FIELD_LABELS = {
    vendor: "Vendor",
    invoiceNumber: "Invoice Number",
    invoiceDate: "Invoice Date",
    subtotal: "Subtotal",
    tax: "Tax",
    total: "Total",
  };

  // ---------------------------------------------------------------------------
  // PDF.js worker setup
  // ---------------------------------------------------------------------------

  if (typeof pdfjsLib !== "undefined" && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
      "lib/pdf.worker.min.js"
    );
  }

  // ---------------------------------------------------------------------------
  // DOM references
  // ---------------------------------------------------------------------------

  const els = {
    btnAddCurrent: document.getElementById("btn-add-current"),
    btnExport: document.getElementById("btn-export"),
    btnClear: document.getElementById("btn-clear"),
    btnSettings: document.getElementById("btn-settings"),
    pdfInput: document.getElementById("pdf-input"),
    tbody: document.getElementById("invoice-tbody"),
    tfoot: document.getElementById("invoice-tfoot"),
    totalExpense: document.getElementById("total-expense"),
    table: document.getElementById("invoice-table"),
    emptyState: document.getElementById("empty-state"),
    status: document.getElementById("status"),
    count: document.getElementById("invoice-count"),
    aiChip: document.getElementById("ai-chip"),
    aiChipLabel: document.getElementById("ai-chip-label"),
    emptyOpenSettings: document.getElementById("empty-open-settings"),
    settingsOverlay: document.getElementById("settings-overlay"),
    settingProvider: document.getElementById("setting-provider"),
    settingApiKey: document.getElementById("setting-api-key"),
    settingModel: document.getElementById("setting-model"),
    settingVisionMode: document.getElementById("setting-vision-mode"),
    btnToggleKey: document.getElementById("btn-toggle-key"),
    btnTestLlm: document.getElementById("btn-test-llm"),
    settingsTestStatus: document.getElementById("settings-test-status"),
    btnSaveSettings: document.getElementById("btn-save-settings"),
    apiKeyLink: document.getElementById("api-key-link"),
    modelHint: document.getElementById("model-hint"),
  };

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  async function loadInvoices() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    return Array.isArray(data[STORAGE_KEY]) ? data[STORAGE_KEY] : [];
  }

  async function saveInvoices(list) {
    await chrome.storage.local.set({ [STORAGE_KEY]: list });
  }

  async function addInvoice(record) {
    const list = await loadInvoices();
    list.push(record);
    await saveInvoices(list);
    return list;
  }

  async function removeInvoice(id) {
    const list = await loadInvoices();
    const next = list.filter((r) => r.id !== id);
    await saveInvoices(next);
    return next;
  }

  async function updateInvoice(id, patch) {
    const list = await loadInvoices();
    const idx = list.findIndex((r) => r.id === id);
    if (idx === -1) return list;
    list[idx] = Object.assign({}, list[idx], patch);
    list[idx].validation = InvoiceParser.validateTotals(list[idx]);
    await saveInvoices(list);
    return list;
  }

  function normalizeLlmSettings(llm) {
    const out = Object.assign({}, DEFAULT_SETTINGS.llm, llm || {});
    if (!out.visionPdfMode) {
      if (llm && llm.visionForPdfs === false) out.visionPdfMode = "off";
      else if (llm && llm.visionForPdfs === true) out.visionPdfMode = "always";
      else out.visionPdfMode = "fallback";
    }
    if (out.visionPdfMode !== "off" && out.visionPdfMode !== "fallback" && out.visionPdfMode !== "always") {
      out.visionPdfMode = "fallback";
    }
    return out;
  }

  async function loadSettings() {
    const data = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = data[SETTINGS_KEY] || {};
    return Object.assign({}, DEFAULT_SETTINGS, raw, {
      llm: normalizeLlmSettings(raw.llm),
    });
  }

  async function saveSettings(settings) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  }

  // ---------------------------------------------------------------------------
  // Status / busy helpers
  // ---------------------------------------------------------------------------

  let statusTimer = null;
  function setStatus(message, kind) {
    els.status.textContent = message || "";
    els.status.classList.remove("error", "success");
    if (kind === "error") els.status.classList.add("error");
    if (kind === "success") els.status.classList.add("success");
    if (statusTimer) clearTimeout(statusTimer);
    if (message && kind !== "error") {
      statusTimer = setTimeout(() => {
        if (els.status.textContent === message) {
          els.status.textContent = "";
          els.status.classList.remove("error", "success");
        }
      }, 4000);
    }
  }

  function setBusy(busy) {
    [els.btnAddCurrent, els.btnExport, els.btnClear, els.pdfInput].forEach(
      (b) => {
        if (!b) return;
        if (busy) b.setAttribute("aria-disabled", "true");
        else b.removeAttribute("aria-disabled");
      }
    );
    document.querySelectorAll('label[for="pdf-input"]').forEach((label) => {
      if (busy) label.setAttribute("aria-disabled", "true");
      else label.removeAttribute("aria-disabled");
    });
  }

  // ---------------------------------------------------------------------------
  // AI chip
  // ---------------------------------------------------------------------------

  function refreshAiChip(settings) {
    const cfg = settings && settings.llm;
    if (cfg && cfg.provider && cfg.apiKey) {
      const label = (InvoiceLLM.DEFAULTS[cfg.provider] || {}).label || cfg.provider;
      const model = cfg.model || (InvoiceLLM.DEFAULTS[cfg.provider] || {}).defaultModel || "";
      els.aiChip.hidden = false;
      els.aiChipLabel.textContent = `AI · ${label}${model ? ` · ${model}` : ""}`;
      els.aiChip.title = `AI extraction enabled — ${label}${model ? ` (${model})` : ""}`;
    } else {
      els.aiChip.hidden = true;
    }
  }

  // ---------------------------------------------------------------------------
  // Hybrid extraction pipeline
  // ---------------------------------------------------------------------------

  /**
   * @param {string} text       Normalized invoice text.
   * @param {object|null} ld    Structured data extracted from JSON-LD (or null).
   * @param {{source: string, sourceType: string}} meta
   * @param {{images?: string[]}} [extra]  Optional rendered page images
   *   (data URLs) for vision-capable LLM extraction.
   * @returns {Promise<object>} A complete invoice record.
   */
  async function extractRecord(text, ld, meta, extra) {
    // 1) Heuristic baseline (always run — cheap and provides a fallback).
    let record = InvoiceParser.parseInvoiceText(text, meta);
    record.fieldSources = {};
    for (const f of Object.keys(FIELD_LABELS)) {
      if (record[f]) record.fieldSources[f] = "heuristic";
    }
    record.extractedBy = "heuristic";

    // 2) Layer JSON-LD on top — schema.org structured data is essentially
    //    ground truth when present.
    if (ld && hasAnyValue(ld)) {
      record = InvoiceParser.mergeRecords(record, ld, "schema.org");
      record.extractedBy = "schema.org";
    }

    // 3) Layer LLM on top when configured. The LLM gets the full text plus
    //    the heuristic guesses as a hint, and is asked to produce a strict
    //    JSON document conforming to the shared schema.
    const settings = await loadSettings();
    const cfg = settings.llm;
    if (cfg && cfg.provider && cfg.apiKey) {
      const images = (extra && extra.images) || [];
      try {
        const visionLabel = images.length
          ? ` (${images.length} page image${images.length === 1 ? "" : "s"})`
          : "";
        setStatus(`Extracting with ${labelFor(cfg.provider)}${visionLabel}…`);
        const { record: llmRecord } = await InvoiceLLM.extract(text, cfg, {
          timeoutMs: 90000,
          images,
        });
        record = InvoiceParser.mergeRecords(record, llmRecord, "llm");
        if (llmRecord.notes) record.notes = llmRecord.notes;
        if (llmRecord.currency) record.currency = llmRecord.currency;
        record.extractedBy = images.length ? "llm-vision" : "llm";
      } catch (err) {
        console.warn("LLM extraction failed:", err);
        record.llmError = err.message || String(err);
        setStatus(
          `AI extraction failed (${trimErr(err.message)}); used heuristic results.`,
          "error"
        );
      }
    }

    // 4) Cross-field validation (subtotal + tax ≈ total).
    record.validation = InvoiceParser.validateTotals(record);
    return record;
  }

  function hasAnyValue(obj) {
    return Object.values(obj || {}).some(
      (v) => v != null && String(v).trim() !== ""
    );
  }

  function labelFor(provider) {
    return (InvoiceLLM.DEFAULTS[provider] || {}).label || provider;
  }

  function trimErr(msg) {
    return String(msg || "")
      .replace(/\s+/g, " ")
      .slice(0, 80);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  function render(invoices) {
    els.count.textContent = String(invoices.length);
    els.tbody.innerHTML = "";

    if (invoices.length === 0) {
      els.emptyState.classList.remove("hidden");
      els.table.classList.add("hidden");
      renderTotals([]);
      return;
    }

    els.emptyState.classList.add("hidden");
    els.table.classList.remove("hidden");
    renderTotals(invoices);

    for (const inv of invoices) {
      const tr = document.createElement("tr");
      const totalsBalance = inv.validation && inv.validation.ok !== false;
      const totalImbalanced =
        inv.validation && inv.validation.ok === false ? true : false;

      tr.appendChild(sourceCell(inv));
      tr.appendChild(editableCell(inv, "vendor", "vendor"));
      tr.appendChild(editableCell(inv, "invoiceNumber", "invoice-num"));
      tr.appendChild(editableCell(inv, "invoiceDate", "date"));
      tr.appendChild(
        editableCell(inv, "subtotal", "numeric", { warn: totalImbalanced })
      );
      tr.appendChild(
        editableCell(inv, "tax", "numeric", { warn: totalImbalanced })
      );
      tr.appendChild(
        editableCell(inv, "total", "numeric", { warn: totalImbalanced })
      );

      const actions = document.createElement("td");
      actions.className = "row-action";
      const removeBtn = document.createElement("button");
      removeBtn.className = "remove-btn";
      removeBtn.title = "Remove invoice";
      removeBtn.setAttribute("aria-label", "Remove invoice");
      removeBtn.innerHTML =
        '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      removeBtn.addEventListener("click", async () => {
        const next = await removeInvoice(inv.id);
        render(next);
      });
      actions.appendChild(removeBtn);
      tr.appendChild(actions);

      els.tbody.appendChild(tr);
    }
  }

  /**
   * Build a contenteditable cell for one extracted field. Saving on
   * blur / Enter persists the edit and re-validates the row.
   */
  function editableCell(inv, field, className, opts) {
    const cell = document.createElement("td");
    cell.classList.add("editable");
    if (className) cell.classList.add(className);
    cell.contentEditable = "true";
    cell.spellcheck = false;
    cell.setAttribute("data-field", field);

    const value = inv[field];
    if (value == null || value === "") {
      cell.textContent = "—";
      if (className === "numeric") cell.classList.add("empty");
    } else {
      cell.textContent = value;
    }

    if (opts && opts.warn) {
      cell.setAttribute("data-warn", "true");
      cell.title =
        inv.validation && inv.validation.diff
          ? `Math doesn't balance — subtotal + tax differs from total by ${inv.validation.diff.toFixed(2)}.`
          : "Cross-field validation failed.";
    }

    const provenance = inv.fieldSources && inv.fieldSources[field];
    if (provenance && provenance !== "heuristic") {
      const src =
        provenance === "user"
          ? "edited by you"
          : provenance === "llm"
          ? "AI extracted"
          : provenance === "schema.org"
          ? "from schema.org structured data"
          : provenance;
      const existing = cell.title ? `${cell.title}\n` : "";
      cell.title = existing + `Source: ${src}`;
    }

    if (provenance === "user") {
      cell.setAttribute("data-edited", "true");
    }

    cell.addEventListener("focus", () => {
      if (cell.textContent.trim() === "—") cell.textContent = "";
    });

    cell.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        cell.blur();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cell.textContent = inv[field] || "—";
        cell.blur();
      }
    });

    cell.addEventListener("blur", async () => {
      let next = cell.textContent.trim();
      if (field === "invoiceDate" && InvoiceParser.normalizeInvoiceDate) {
        const norm = InvoiceParser.normalizeInvoiceDate(next);
        if (norm) next = norm;
      }
      const original = inv[field] || "";
      if (next === original || (next === "" && !original)) {
        if (!next) cell.textContent = "—";
        return;
      }
      const fieldSources = Object.assign({}, inv.fieldSources || {});
      fieldSources[field] = "user";
      const updated = await updateInvoice(inv.id, {
        [field]: next,
        fieldSources,
      });
      render(updated);
      setStatus(`Updated ${FIELD_LABELS[field]}.`, "success");
    });

    return cell;
  }

  function sourceCell(inv) {
    const cell = document.createElement("td");
    cell.className = "source";
    const pill = document.createElement("span");
    pill.className = `source-pill ${inv.sourceType === "pdf" ? "pdf" : "html"}`;
    pill.title = buildSourceTitle(inv);

    const dot = document.createElement("span");
    dot.className = "dot";
    pill.appendChild(dot);

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = inv.source || (inv.sourceType === "pdf" ? "PDF" : "Page");
    pill.appendChild(label);

    cell.appendChild(pill);
    if (inv.lowConfidence) {
      const badge = document.createElement("span");
      badge.className = "low-confidence-badge";
      badge.textContent = "Low";
      badge.title = lowConfidenceHint(inv.lowConfidenceReason);
      cell.appendChild(badge);
    }
    return cell;
  }

  function buildSourceTitle(inv) {
    const lines = [inv.source || ""];
    if (inv.extractedBy) lines.push(`Extracted by: ${inv.extractedBy}`);
    if (inv.lowConfidence) lines.push(lowConfidenceHint(inv.lowConfidenceReason));
    if (inv.notes) lines.push(`Note: ${inv.notes}`);
    if (inv.validation && !inv.validation.ok) {
      lines.push(`⚠ Math mismatch: diff ${inv.validation.diff.toFixed(2)}`);
    }
    return lines.filter(Boolean).join("\n");
  }

  // ---------------------------------------------------------------------------
  // Running total (multi-currency)
  // ---------------------------------------------------------------------------

  /**
   * Render the "Total expense" footer row by summing the parseable totals of
   * every invoice. Sums are grouped per currency (₹, $, €, …) so we never
   * conflate amounts in different currencies.
   */
  function renderTotals(invoices) {
    if (!els.tfoot || !els.totalExpense) return;
    const groups = computeTotalsByCurrency(invoices);
    const cell = els.totalExpense;
    cell.innerHTML = "";
    cell.classList.remove("multi-currency");

    if (groups.size === 0) {
      els.tfoot.classList.add("hidden");
      return;
    }
    els.tfoot.classList.remove("hidden");

    if (groups.size === 1) {
      const [currency, sum] = groups.entries().next().value;
      cell.textContent = formatMoney(currency, sum);
      cell.title = `Sum of ${invoices.length} invoice${
        invoices.length === 1 ? "" : "s"
      }`;
      return;
    }

    cell.classList.add("multi-currency");
    cell.title = "Mixed currencies — summed per currency";
    for (const [currency, sum] of groups) {
      const span = document.createElement("span");
      span.textContent = formatMoney(currency, sum);
      cell.appendChild(span);
    }
  }

  function computeTotalsByCurrency(invoices) {
    const groups = new Map();
    for (const inv of invoices) {
      const num = InvoiceParser.parseMoneyToNumber(inv.total);
      if (!Number.isFinite(num)) continue;
      const currency = currencyFor(inv);
      groups.set(currency, (groups.get(currency) || 0) + num);
    }
    return groups;
  }

  function currencyFor(inv) {
    if (inv.currency) return inv.currency;
    const fromTotal = detectCurrencyInString(inv.total);
    if (fromTotal) return fromTotal;
    if (inv.rawTextPreview && InvoiceParser.extractCurrency) {
      const fromPreview = InvoiceParser.extractCurrency(inv.rawTextPreview);
      if (fromPreview) return fromPreview;
    }
    return "";
  }

  function detectCurrencyInString(str) {
    if (!str) return "";
    if (/₹/.test(str)) return "INR";
    if (/€/.test(str)) return "EUR";
    if (/£/.test(str)) return "GBP";
    if (/¥/.test(str)) return "JPY";
    if (/\$/.test(str)) return "USD";
    const m = String(str).match(
      /\b(USD|EUR|GBP|INR|CAD|AUD|JPY|CHF|CNY|AED|SGD|HKD|NZD|SEK|NOK|DKK)\b/i
    );
    return m ? m[1].toUpperCase() : "";
  }

  async function backfillCurrencies(invoices) {
    let mutated = false;
    for (const inv of invoices) {
      if (inv.currency) continue;
      const inferred = currencyFor(inv);
      if (inferred) {
        inv.currency = inferred;
        mutated = true;
      }
    }
    if (mutated) await saveInvoices(invoices);
    return invoices;
  }

  async function backfillInvoiceDates(invoices) {
    if (!InvoiceParser.normalizeInvoiceDate) return invoices;
    let mutated = false;
    for (const inv of invoices) {
      if (inv.invoiceDate == null || inv.invoiceDate === "") continue;
      const n = InvoiceParser.normalizeInvoiceDate(inv.invoiceDate);
      const prev = String(inv.invoiceDate).trim();
      if (n && n !== prev) {
        inv.invoiceDate = n;
        mutated = true;
      }
    }
    if (mutated) await saveInvoices(invoices);
    return invoices;
  }

  function formatMoney(currency, amount) {
    const formatted = amount.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    const symbols = { USD: "$", EUR: "€", GBP: "£", INR: "₹", JPY: "¥" };
    if (currency && symbols[currency]) return `${symbols[currency]}${formatted}`;
    if (currency) return `${currency} ${formatted}`;
    return formatted;
  }

  // ---------------------------------------------------------------------------
  // Capture current tab
  // ---------------------------------------------------------------------------

  async function handleAddCurrent() {
    setBusy(true);
    setStatus("Capturing current tab…");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "captureActiveTab",
      });
      if (!response || !response.ok) {
        throw new Error((response && response.error) || "Capture failed");
      }
      const record = await extractRecord(response.text, response.structured, {
        source: response.title || response.url,
        sourceType: "html",
      });
      const existing = await loadInvoices();
      if (
        typeof InvoiceDuplicateCheck !== "undefined" &&
        !InvoiceDuplicateCheck.shouldAddInvoice(existing, record)
      ) {
        render(existing);
        setStatus("Not added — duplicate skipped.");
        return;
      }
      const list = await addInvoice(record);
      render(list);
      setStatus(
        `Added invoice from ${record.source || "current tab"}.`,
        "success"
      );
    } catch (err) {
      setStatus(`Could not capture page: ${err.message || err}`, "error");
    } finally {
      setBusy(false);
    }
  }

  // ---------------------------------------------------------------------------
  // PDF upload
  // ---------------------------------------------------------------------------

  async function handlePdfUpload(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    setBusy(true);

    const settings = await loadSettings();
    const cfg = settings.llm || {};
    const hasLlm = !!(cfg.provider && cfg.apiKey);
    const visionMode = cfg.visionPdfMode || "fallback";

    let processed = 0;
    let failed = 0;
    let skippedDup = 0;

    for (const file of files) {
      setStatus(
        `Reading PDF ${processed + failed + 1} of ${files.length}: ${file.name}`
      );
      try {
        // Open the PDF once and reuse it for both text and image rendering
        // — avoids parsing the file twice and keeps page references warm.
        const pdf = await openPdfDocument(file);
        const text = await extractTextFromPdfDoc(pdf);
        const weak = isWeakPdfText(text);
        let images = [];
        if (
          hasLlm &&
          visionMode !== "off" &&
          (visionMode === "always" || (visionMode === "fallback" && weak))
        ) {
          images = await renderPdfPagesAsImages(pdf, {
            maxPages: VISION_MAX_PAGES,
            maxDim: VISION_MAX_DIMENSION,
            quality: VISION_JPEG_QUALITY,
          }).catch((err) => {
            console.warn("PDF rasterization failed:", err);
            return [];
          });
        }
        await pdf.cleanup();
        await pdf.destroy();

        const record = await extractRecord(
          text,
          null,
          { source: file.name, sourceType: "pdf" },
          { images }
        );
        if (weak) {
          record.lowConfidence = true;
          if (images.length > 0) {
            record.lowConfidenceReason = "vision-ocr";
            if (!record.notes) {
              record.notes =
                "Scanned / weak PDF text — used AI vision on page images; verify fields.";
            }
          } else if (!hasLlm) {
            record.lowConfidenceReason = "no-ai";
          } else if (visionMode === "off") {
            record.lowConfidenceReason = "vision-disabled";
          } else {
            record.lowConfidenceReason = "no-images";
          }
        }
        const listSoFar = await loadInvoices();
        if (
          typeof InvoiceDuplicateCheck !== "undefined" &&
          !InvoiceDuplicateCheck.shouldAddInvoice(listSoFar, record)
        ) {
          skippedDup += 1;
          continue;
        }
        await addInvoice(record);
        processed += 1;
      } catch (err) {
        console.error("PDF parse failed", file.name, err);
        failed += 1;
      }
    }

    const list = await loadInvoices();
    render(list);
    setBusy(false);
    event.target.value = "";

    if (failed === 0) {
      const dupHint =
        skippedDup > 0
          ? ` (${skippedDup} duplicate${skippedDup === 1 ? "" : "s"} skipped)`
          : "";
      setStatus(
        `Added ${processed} PDF invoice${processed === 1 ? "" : "s"}${dupHint}.`,
        "success"
      );
    } else {
      const dupHint =
        skippedDup > 0
          ? ` ${skippedDup} duplicate${skippedDup === 1 ? "" : "s"} skipped.`
          : "";
      setStatus(
        `Added ${processed} invoice${processed === 1 ? "" : "s"}, ${failed} failed.${dupHint} Scanned/image PDFs are not supported.`,
        failed === files.length ? "error" : ""
      );
    }
  }

  async function openPdfDocument(file) {
    const arrayBuffer = await file.arrayBuffer();
    return await pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      isEvalSupported: false,
      disableFontFace: true,
    }).promise;
  }

  /**
   * Spatial-aware PDF text extraction: groups text items by Y-coordinate
   * (rows) and inserts column breaks where there are large X gaps. This
   * preserves table structure that PDF.js's flat item stream loses, which
   * helps both the heuristic parser and the LLM produce correct results.
   */
  async function extractTextFromPdfDoc(pdf) {
    const pageTexts = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

      // Collect items with their (x, y) positions.
      const items = [];
      for (const item of content.items) {
        if (!item || typeof item.str !== "string") continue;
        if (!item.str.trim() && !item.hasEOL) continue;
        const t = item.transform;
        if (!t) continue;
        items.push({
          str: item.str,
          x: t[4],
          y: t[5],
          height: item.height || 10,
          eol: !!item.hasEOL,
        });
      }

      // Group items into rows by Y-coordinate. Items within a row are
      // sorted by X. The row tolerance is half the typical font height,
      // which works well across most invoice templates.
      const tolerance = items.length
        ? Math.max(2, (items[0].height || 10) * 0.5)
        : 3;
      items.sort((a, b) => b.y - a.y || a.x - b.x);

      const rows = [];
      let current = null;
      for (const it of items) {
        if (!current || Math.abs(current.y - it.y) > tolerance) {
          current = { y: it.y, items: [it] };
          rows.push(current);
        } else {
          current.items.push(it);
        }
      }

      // Render rows. Insert multiple spaces (≈ a tab) where there's a big
      // X-gap between adjacent items so columns stay distinguishable.
      const lines = rows.map((row) => {
        row.items.sort((a, b) => a.x - b.x);
        let out = "";
        for (let i = 0; i < row.items.length; i++) {
          const it = row.items[i];
          if (i > 0) {
            const prev = row.items[i - 1];
            const gap = it.x - (prev.x + estimateWidth(prev));
            if (gap > 12) out += "    ";
            else if (gap > 4 || !/\s$/.test(out)) out += " ";
          }
          out += it.str;
        }
        return out.replace(/\s+/g, (m) =>
          m.length >= 4 ? "    " : m === " " ? " " : "  "
        );
      });

      pageTexts.push(lines.join("\n"));
      page.cleanup();
    }

    return pageTexts.join("\n\n");
  }

  // Rough character-width estimate. PDF.js gives `width` on items but not
  // always; this is good enough for column-gap heuristics.
  function estimateWidth(item) {
    const len = (item.str || "").length;
    return len * (item.height || 10) * 0.5;
  }

  /**
   * Render the first N pages of a PDF document as JPEG data URLs. Used to
   * give a vision-capable LLM the actual rendered layout, which is far
   * more reliable than flattened text for tabular invoices.
   *
   * @param {object} pdf  PDF.js document
   * @param {{maxPages?: number, maxDim?: number, quality?: number}} opts
   * @returns {Promise<string[]>}
   */
  async function renderPdfPagesAsImages(pdf, opts) {
    const maxPages = (opts && opts.maxPages) || VISION_MAX_PAGES;
    const maxDim = (opts && opts.maxDim) || VISION_MAX_DIMENSION;
    const quality = (opts && opts.quality) || VISION_JPEG_QUALITY;

    const dataUrls = [];
    const limit = Math.min(pdf.numPages, maxPages);
    for (let pageNum = 1; pageNum <= limit; pageNum++) {
      const page = await pdf.getPage(pageNum);
      // Pick a render scale that caps the longest side at maxDim. This
      // keeps token cost predictable while preserving table legibility.
      const baseViewport = page.getViewport({ scale: 1 });
      const longest = Math.max(baseViewport.width, baseViewport.height);
      const scale = Math.min(2.5, Math.max(1.2, maxDim / longest));
      const viewport = page.getViewport({ scale });

      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d", { alpha: false });
      // White background — invoices typically print on white, and JPEG
      // does not support transparency anyway.
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport }).promise;
      dataUrls.push(canvas.toDataURL("image/jpeg", quality));

      page.cleanup();
    }
    return dataUrls;
  }

  // ---------------------------------------------------------------------------
  // Excel export
  // ---------------------------------------------------------------------------

  async function handleExport() {
    setBusy(true);
    try {
      const list = await loadInvoices();
      if (!list.length) {
        setStatus("Nothing to export — add at least one invoice first.", "error");
        return;
      }

      const headers = [
        "Source",
        "Source Type",
        "Captured At",
        "Vendor",
        "Invoice Number",
        "Invoice Date",
        "Currency",
        "Subtotal",
        "Tax",
        "Total",
        "Low confidence",
        "Extracted By",
        "Notes",
      ];

      const rows = list.map((r) => [
        r.source || "",
        r.sourceType || "",
        r.capturedAt || "",
        r.vendor || "",
        r.invoiceNumber || "",
        r.invoiceDate || "",
        r.currency || "",
        moneyCell(r.subtotal),
        moneyCell(r.tax),
        moneyCell(r.total),
        r.lowConfidence ? "Yes" : "",
        r.extractedBy || "heuristic",
        r.notes || "",
      ]);

      const groups = computeTotalsByCurrency(list);
      const summaryRows = [];
      if (groups.size > 0) {
        summaryRows.push(new Array(headers.length).fill(""));
        const sorted = [...groups.entries()].sort((a, b) =>
          String(a[0] || "").localeCompare(String(b[0] || ""))
        );
        for (let i = 0; i < sorted.length; i++) {
          const [currency, sum] = sorted[i];
          const row = new Array(headers.length).fill("");
          row[0] = i === 0 ? "Total expense" : "";
          row[6] = currency || "";
          row[9] = sum;
          summaryRows.push(row);
        }
      }

      const aoa = [headers, ...rows, ...summaryRows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [
        { wch: 28 }, { wch: 12 }, { wch: 22 }, { wch: 28 }, { wch: 18 },
        { wch: 14 }, { wch: 8 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
        { wch: 12 }, { wch: 14 }, { wch: 32 },
      ];
      // Money columns: H, I, J. Format as numbers when parseable.
      for (let i = 0; i < rows.length; i++) {
        for (const col of ["H", "I", "J"]) {
          const ref = `${col}${i + 2}`;
          const cell = ws[ref];
          if (cell && typeof cell.v === "number") {
            cell.t = "n";
            cell.z = "#,##0.00";
          }
        }
      }
      const summaryStart = 2 + rows.length + 1;
      const totalColLetter = "J";

      for (let j = 0; j < groups.size; j++) {
        const ref = `${totalColLetter}${summaryStart + j}`;
        const cell = ws[ref];
        if (cell && typeof cell.v === "number") {
          cell.t = "n";
          cell.z = "#,##0.00";
        }
      }

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Invoices");

      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      XLSX.writeFile(wb, `invoices-${stamp}.xlsx`);
      setStatus(
        `Exported ${list.length} invoice${list.length === 1 ? "" : "s"} to Excel.`,
        "success"
      );
    } catch (err) {
      setStatus(`Export failed: ${err.message || err}`, "error");
    } finally {
      setBusy(false);
    }
  }

  function moneyCell(value) {
    if (value == null || value === "") return "";
    const n = InvoiceParser.parseMoneyToNumber(value);
    return Number.isFinite(n) ? n : String(value);
  }

  // ---------------------------------------------------------------------------
  // Clear-all
  // ---------------------------------------------------------------------------

  async function handleClear() {
    const list = await loadInvoices();
    if (!list.length) return;
    const confirmed = confirm(
      `Remove all ${list.length} invoice${list.length === 1 ? "" : "s"} from this extension?`
    );
    if (!confirmed) return;
    await saveInvoices([]);
    render([]);
    setStatus("Cleared all invoices.", "success");
  }

  // ---------------------------------------------------------------------------
  // Settings overlay
  // ---------------------------------------------------------------------------

  async function openSettings() {
    const settings = await loadSettings();
    els.settingProvider.value = settings.llm.provider || "";
    els.settingApiKey.value = settings.llm.apiKey || "";
    els.settingApiKey.type = "password";
    els.settingModel.value = settings.llm.model || "";
    els.settingVisionMode.value = settings.llm.visionPdfMode || "fallback";
    refreshProviderUi();
    els.settingsTestStatus.textContent = "";
    els.settingsTestStatus.className = "form-hint";
    els.settingsOverlay.classList.remove("hidden");
    setTimeout(() => {
      (els.settingProvider.value
        ? els.settingApiKey
        : els.settingProvider
      ).focus();
    }, 60);
  }

  function closeSettings() {
    els.settingsOverlay.classList.add("hidden");
  }

  function refreshProviderUi() {
    const provider = els.settingProvider.value;
    const defaults = InvoiceLLM.DEFAULTS[provider];

    document.querySelectorAll("[data-llm-row]").forEach((row) => {
      row.classList.toggle("disabled", !provider);
    });

    if (defaults) {
      els.settingApiKey.placeholder = defaults.apiKeyHint || "API key";
      els.settingModel.placeholder = defaults.defaultModel || "model name";
      els.modelHint.textContent = `Examples: ${defaults.modelExamples.join(", ")}`;
      if (els.apiKeyLink) {
        els.apiKeyLink.href = defaults.apiKeyUrl;
        els.apiKeyLink.style.display = "";
      }
    } else {
      els.modelHint.textContent = "";
      if (els.apiKeyLink) els.apiKeyLink.style.display = "none";
    }
  }

  async function handleSaveSettings() {
    const provider = els.settingProvider.value || "";
    const apiKey = els.settingApiKey.value.trim();
    const model = els.settingModel.value.trim();

    if (provider && !apiKey) {
      els.settingsTestStatus.textContent = "Enter an API key, or set provider to Off.";
      els.settingsTestStatus.className = "form-hint error";
      return;
    }

    const settings = {
      llm: {
        provider,
        apiKey,
        model,
        visionPdfMode: els.settingVisionMode.value || "fallback",
      },
    };
    await saveSettings(settings);
    refreshAiChip(settings);
    closeSettings();
    setStatus(
      provider
        ? `AI extraction enabled (${labelFor(provider)}).`
        : "AI extraction disabled.",
      "success"
    );
  }

  async function handleTestLlm() {
    const provider = els.settingProvider.value;
    const apiKey = els.settingApiKey.value.trim();
    const model = els.settingModel.value.trim();
    if (!provider || !apiKey) {
      els.settingsTestStatus.textContent = "Choose a provider and enter an API key first.";
      els.settingsTestStatus.className = "form-hint error";
      return;
    }
    els.settingsTestStatus.textContent = "Testing…";
    els.settingsTestStatus.className = "form-hint";
    els.btnTestLlm.setAttribute("aria-disabled", "true");
    try {
      const sample = `Acme Inc.\nInvoice #: TEST-1\nDate: 2024-01-01\nTotal: $100.00`;
      const { record } = await InvoiceLLM.extract(
        sample,
        { provider, apiKey, model },
        { timeoutMs: 20000 }
      );
      if (record && record.total) {
        els.settingsTestStatus.textContent = `OK — got total "${record.total}"`;
        els.settingsTestStatus.className = "form-hint success";
      } else {
        els.settingsTestStatus.textContent =
          "Connected, but no total in response (model may need a different prompt).";
        els.settingsTestStatus.className = "form-hint error";
      }
    } catch (err) {
      els.settingsTestStatus.textContent = `Failed: ${trimErr(err.message)}`;
      els.settingsTestStatus.className = "form-hint error";
    } finally {
      els.btnTestLlm.removeAttribute("aria-disabled");
    }
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  els.btnAddCurrent.addEventListener("click", handleAddCurrent);
  els.btnExport.addEventListener("click", handleExport);
  els.btnClear.addEventListener("click", handleClear);
  els.pdfInput.addEventListener("change", handlePdfUpload);

  els.btnSettings.addEventListener("click", openSettings);
  els.emptyOpenSettings.addEventListener("click", openSettings);
  els.btnSaveSettings.addEventListener("click", handleSaveSettings);
  els.btnTestLlm.addEventListener("click", handleTestLlm);
  els.settingProvider.addEventListener("change", refreshProviderUi);

  document.querySelectorAll("[data-close-settings]").forEach((b) => {
    b.addEventListener("click", closeSettings);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !els.settingsOverlay.classList.contains("hidden")) {
      closeSettings();
    }
  });

  els.btnToggleKey.addEventListener("click", () => {
    els.settingApiKey.type =
      els.settingApiKey.type === "password" ? "text" : "password";
  });

  // External links inside the settings panel: open in a new browser tab,
  // because anchor navigation inside the popup just closes it silently.
  document.addEventListener("click", (e) => {
    const a = e.target.closest("a[target='_blank']");
    if (!a) return;
    e.preventDefault();
    const url = a.href;
    if (url) chrome.tabs.create({ url });
  });

  // Re-render when storage changes.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEY]) render(changes[STORAGE_KEY].newValue || []);
    if (changes[SETTINGS_KEY]) {
      loadSettings().then(refreshAiChip);
    }
  });

  // Initial render + chip refresh.
  Promise.all([loadInvoices(), loadSettings()])
    .then(async ([invoices, settings]) => {
      let migrated = await backfillCurrencies(invoices);
      migrated = await backfillInvoiceDates(migrated);
      render(migrated);
      refreshAiChip(settings);
    })
    .catch((err) => {
      console.error(err);
      setStatus("Failed to load saved invoices.", "error");
    });
})();

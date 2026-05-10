/*
 * popup.js
 * --------
 * UI controller for the extension popup. Coordinates:
 *
 *   - Persisted invoice list in chrome.storage.local
 *   - Capturing the current tab via the background service worker
 *   - PDF text extraction with PDF.js
 *   - Heuristic field parsing via InvoiceParser
 *   - Excel export with SheetJS (xlsx)
 *
 * This file expects pdf.min.js, xlsx.full.min.js and parser.js to have been
 * loaded as classic <script> tags before it executes (see popup.html).
 */
(function () {
  "use strict";

  const STORAGE_KEY = "invoices";

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
      "no-text-layer":
        "Low confidence: little selectable text (likely scanned). No OCR in v1 — use Invoice Reader v2 with AI vision.",
    };
    return map[reason] || "Low confidence — verify extracted fields.";
  }

  if (typeof pdfjsLib !== "undefined" && pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL(
      "lib/pdf.worker.min.js"
    );
  }

  const els = {
    btnAddCurrent: document.getElementById("btn-add-current"),
    btnExport: document.getElementById("btn-export"),
    btnClear: document.getElementById("btn-clear"),
    pdfInput: document.getElementById("pdf-input"),
    tbody: document.getElementById("invoice-tbody"),
    tfoot: document.getElementById("invoice-tfoot"),
    totalExpense: document.getElementById("total-expense"),
    table: document.getElementById("invoice-table"),
    emptyState: document.getElementById("empty-state"),
    status: document.getElementById("status"),
    count: document.getElementById("invoice-count"),
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

  const FIELD_LABELS = {
    vendor: "Vendor",
    invoiceNumber: "Invoice #",
    invoiceDate: "Invoice Date",
    subtotal: "Subtotal",
    tax: "Tax",
    total: "Total",
  };

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
      const validation =
        inv.validation != null
          ? inv.validation
          : InvoiceParser.validateTotals(inv);
      const totalImbalanced = validation && validation.ok === false;

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
   * Editable table cell; blur / Enter saves and re-validates the row.
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
      const validation =
        inv.validation != null
          ? inv.validation
          : InvoiceParser.validateTotals(inv);
      cell.title =
        validation && validation.diff
          ? `Subtotal + tax differs from total by ${validation.diff.toFixed(2)}.`
          : "Subtotal + tax does not match total.";
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
        if (!inv[field] && className === "numeric") cell.classList.add("empty");
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
        if (!next) {
          cell.textContent = "—";
          if (className === "numeric") cell.classList.add("empty");
        }
        return;
      }
      const updated = await updateInvoice(inv.id, { [field]: next });
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
    if (inv.lowConfidence) lines.push(lowConfidenceHint(inv.lowConfidenceReason));
    return lines.filter(Boolean).join("\n");
  }

  // ---------------------------------------------------------------------------
  // Running total (multi-currency)
  // ---------------------------------------------------------------------------

  /**
   * Render the "Total expense" footer row by summing the parseable totals of
   * every invoice. Sums are grouped per currency (₹, $, €, …) so we never
   * conflate amounts in different currencies. If no invoice has a parseable
   * total, the footer is hidden entirely.
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

  /**
   * Resolve the currency for one invoice, in priority order:
   *   1. an explicit currency stored on the record (set at parse time)
   *   2. a currency hint embedded in the displayed total string
   *   3. a currency hint anywhere in the cached raw-text preview
   * "Anywhere in the document" handles cases like the Air India tax invoice
   * where the total prints as "3,261.00" but the document otherwise says
   * "Amount In INR" / "GSTN" / has ₹ symbols on line items.
   */
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

  // Cheap currency detector for short strings (the displayed total). For the
  // full document, use InvoiceParser.extractCurrency which is more thorough.
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

  /**
   * One-time migration: backfill the `currency` field on existing records
   * that were parsed before currency was detected at parse time. Inferred
   * from rawTextPreview + the displayed total string. Idempotent — runs
   * silently every load and only touches records still missing the field.
   */
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

  /**
   * Normalize stored invoice dates to DD-MM-YYYY (idempotent migration).
   */
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
      const record = InvoiceParser.parseInvoiceText(response.text, {
        source: response.title || response.url,
        sourceType: "html",
      });
      record.validation = InvoiceParser.validateTotals(record);
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

    let processed = 0;
    let failed = 0;
    let skippedDup = 0;

    for (const file of files) {
      setStatus(
        `Reading PDF ${processed + failed + 1} of ${files.length}: ${file.name}`
      );
      try {
        const text = await extractTextFromPdf(file);
        const record = InvoiceParser.parseInvoiceText(text, {
          source: file.name,
          sourceType: "pdf",
        });
        if (isWeakPdfText(text)) {
          record.lowConfidence = true;
          record.lowConfidenceReason = "no-text-layer";
        }
        record.validation = InvoiceParser.validateTotals(record);
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

  /**
   * Use PDF.js to extract text content from a single File object. Requires
   * the PDF to contain real text (not just rasterized images).
   *
   * This implementation is "spatial-aware": it groups text items into rows
   * by Y-coordinate proximity (using the font height as the tolerance), then
   * sorts items within a row by X. Where there is a large horizontal gap
   * between two adjacent items, multiple spaces are inserted so column
   * structure survives the flattening. Crucial for tabular invoices like
   * Indian GST tax invoices, where the grand-total row contains many
   * column values and the *rightmost* one is the real grand total.
   */
  async function extractTextFromPdf(file) {
    const arrayBuffer = await file.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
      isEvalSupported: false,
      disableFontFace: true,
    });
    const pdf = await loadingTask.promise;

    const pageTexts = [];
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();

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
        });
      }

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
        return out;
      });

      pageTexts.push(lines.join("\n"));
      page.cleanup();
    }

    await pdf.cleanup();
    await pdf.destroy();
    return pageTexts.join("\n\n");
  }

  // Rough character-width estimate for column-gap heuristics.
  function estimateWidth(item) {
    const len = (item.str || "").length;
    return len * (item.height || 10) * 0.5;
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
        "Subtotal",
        "Tax",
        "Total",
        "Low confidence",
      ];

      const rows = list.map((r) => [
        r.source || "",
        r.sourceType || "",
        r.capturedAt || "",
        r.vendor || "",
        r.invoiceNumber || "",
        r.invoiceDate || "",
        moneyCell(r.subtotal),
        moneyCell(r.tax),
        moneyCell(r.total),
        r.lowConfidence ? "Yes" : "",
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
          row[1] = currency || "";
          row[8] = sum;
          summaryRows.push(row);
        }
      }

      const aoa = [headers, ...rows, ...summaryRows];
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws["!cols"] = [
        { wch: 28 }, { wch: 12 }, { wch: 22 }, { wch: 28 },
        { wch: 18 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 14 },
        { wch: 12 },
      ];
      for (let i = 0; i < rows.length; i++) {
        for (const col of ["G", "H", "I"]) {
          const ref = `${col}${i + 2}`;
          const cell = ws[ref];
          if (cell && typeof cell.v === "number") {
            cell.t = "n";
            cell.z = "#,##0.00";
          }
        }
      }
      const summaryStart = 2 + rows.length + 1;
      for (let j = 0; j < groups.size; j++) {
        const ref = `I${summaryStart + j}`;
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
  // Wiring
  // ---------------------------------------------------------------------------

  els.btnAddCurrent.addEventListener("click", handleAddCurrent);
  els.btnExport.addEventListener("click", handleExport);
  els.btnClear.addEventListener("click", handleClear);
  els.pdfInput.addEventListener("change", handlePdfUpload);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEY]) {
      render(changes[STORAGE_KEY].newValue || []);
    }
  });

  loadInvoices()
    .then(backfillCurrencies)
    .then(backfillInvoiceDates)
    .then(render)
    .catch((err) => {
      console.error(err);
      setStatus("Failed to load saved invoices.", "error");
    });
})();

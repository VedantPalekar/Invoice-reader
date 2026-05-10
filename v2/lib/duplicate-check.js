/**
 * Duplicate invoice detection before add: same normalized rawTextPreview
 * fingerprint, or same vendor + invoice # + total (when all are present).
 */
(function (global) {
  "use strict";

  /** Ignore tiny previews — easy false positives on sparse extractions. */
  const MIN_PREVIEW_LEN = 40;

  function normalizePreview(text) {
    if (text == null) return "";
    return String(text).trim().replace(/\s+/g, " ");
  }

  /** 32-bit FNV-1a hex — stable fingerprint for preview text. */
  function previewFingerprint(normalized) {
    let h = 2166136261;
    for (let i = 0; i < normalized.length; i++) {
      h ^= normalized.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function parseMoney(rec) {
    const fn = global.InvoiceParser && global.InvoiceParser.parseMoneyToNumber;
    if (!fn) return NaN;
    return fn(rec && rec.total);
  }

  /**
   * @returns {string|null} composite key or null if any part too weak to match on
   */
  function fieldTripleKey(inv) {
    const vendor = (inv && inv.vendor) ? String(inv.vendor).trim().toLowerCase() : "";
    const invNum = (inv && inv.invoiceNumber)
      ? String(inv.invoiceNumber).trim().toLowerCase()
      : "";
    const tot = parseMoney(inv);
    if (!vendor || !invNum || !Number.isFinite(tot)) return null;
    return `${vendor}\t${invNum}\t${tot.toFixed(2)}`;
  }

  /**
   * @param {object[]} list  Existing invoices
   * @param {object} candidate  New record (before persist)
   * @returns {{ reason: 'preview' | 'fields', existing: object } | null}
   */
  function findDuplicate(list, candidate) {
    if (!list || !list.length || !candidate) return null;

    const candNorm = normalizePreview(candidate.rawTextPreview);
    const candFp =
      candNorm.length >= MIN_PREVIEW_LEN ? previewFingerprint(candNorm) : null;
    const candKey = fieldTripleKey(candidate);

    for (const ex of list) {
      if (ex === candidate) continue;
      if (candFp) {
        const exNorm = normalizePreview(ex.rawTextPreview);
        if (
          exNorm.length >= MIN_PREVIEW_LEN &&
          previewFingerprint(exNorm) === candFp
        ) {
          return { reason: "preview", existing: ex };
        }
      }
      if (candKey) {
        const exKey = fieldTripleKey(ex);
        if (exKey && exKey === candKey) {
          return { reason: "fields", existing: ex };
        }
      }
    }
    return null;
  }

  function confirmAddDespiteDuplicate(dup) {
    if (!dup || !dup.existing) return true;
    const ex = dup.existing;
    const src = ex.source ? String(ex.source) : "—";
    const msg =
      dup.reason === "preview"
        ? [
            "This capture matches an invoice already in the list (same extracted text snapshot).",
            "",
            `Existing source: ${src}`,
            "",
            "Add another copy anyway?",
          ].join("\n")
        : [
            "This matches an existing row: same vendor, invoice #, and total.",
            "",
            `Existing: ${ex.vendor || "—"} · ${ex.invoiceNumber || "—"} · ${ex.total || "—"}`,
            `Source: ${src}`,
            "",
            "Add anyway?",
          ].join("\n");
    return confirm(msg);
  }

  /**
   * @returns {boolean} true if the caller should proceed to persist the candidate
   */
  function shouldAddInvoice(list, candidate) {
    const dup = findDuplicate(list, candidate);
    if (!dup) return true;
    return confirmAddDespiteDuplicate(dup);
  }

  global.InvoiceDuplicateCheck = {
    findDuplicate,
    shouldAddInvoice,
    confirmAddDespiteDuplicate,
  };
})(typeof self !== "undefined" ? self : this);

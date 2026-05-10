/*
 * parser.js
 * ---------
 * Heuristic invoice text parser shared by popup.js and content.js.
 *
 * The parser does NOT assume any specific vendor template. It instead applies
 * a series of regular expressions / heuristics to a normalized text blob and
 * returns a partial { vendor, invoiceNumber, invoiceDate, subtotal, tax, total }
 * record. Any field that cannot be confidently recovered is left as an empty
 * string so the consolidated table clearly shows what the user may need to
 * correct manually.
 *
 * This file is loaded as a classic script in both the popup and the content
 * script context, so it must avoid ES modules and attach its API to a global
 * `InvoiceParser` namespace.
 */
(function (global) {
  "use strict";

  // ---------------------------------------------------------------------------
  // Text normalization
  // ---------------------------------------------------------------------------

  /**
   * Collapse whitespace, normalize line endings, and strip non-printable
   * characters that frequently appear in PDF text extraction output.
   */
  function normalizeText(raw) {
    if (!raw) return "";
    return String(raw)
      .replace(/\r\n?/g, "\n")
      // PDF.js sometimes emits soft hyphens / non-breaking spaces.
      .replace(/\u00a0/g, " ")
      .replace(/\u00ad/g, "")
      // Trim whitespace on each line, drop empty surrounding spaces but keep
      // line breaks intact (they help label/value heuristics).
      .split("\n")
      .map((line) => line.replace(/[\t ]+/g, " ").trim())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  // ---------------------------------------------------------------------------
  // Field extraction helpers
  // ---------------------------------------------------------------------------

  // A money token: optional currency symbol/code, optional sign, then either
  //   - a thousands-grouped number ("1,234.56" or "1.234,50" or "1 234,50")
  //   - or a plain number with optional decimals ("1234.56", "980", "0,99").
  // Optionally followed by a trailing currency code (e.g. "1.481,40 EUR").
  const CURRENCY = "(?:USD|EUR|GBP|INR|CAD|AUD|JPY|CHF|CNY|\\$|€|£|¥|₹)";
  // Allow 2- or 3-digit thousands groups so the regex also matches the Indian
  // numbering system (e.g. "1,25,000.00" — lakh / crore grouping). NB: we
  // intentionally do NOT allow whitespace as a thousands separator — that
  // would let the regex greedily consume multi-token sequences like
  // "3,147.86 56.57 56.57" as a single bogus number.
  const MONEY_RE = new RegExp(
    `(?:${CURRENCY}\\s*)?-?(?:\\d{1,3}(?:[.,]\\d{2,3})+(?:[.,]\\d{1,2})?|\\d+(?:[.,]\\d{1,2})?)(?:\\s*${CURRENCY})?`,
    "i"
  );

  function extractFirstMoney(text) {
    const m = text.match(MONEY_RE);
    return m ? m[0].trim() : "";
  }

  /**
   * Find the value associated with a label-style field. Looks both on the same
   * line ("Invoice #: 12345") and on the line immediately following the label.
   */
  function findLabelValue(text, labelPatterns, valuePattern) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      for (const labelRe of labelPatterns) {
        const labelMatch = line.match(labelRe);
        if (!labelMatch) continue;

        const afterLabel = line.slice(labelMatch.index + labelMatch[0].length);
        const sameLine = afterLabel.match(valuePattern);
        if (sameLine) return sameLine[0].trim();

        // Fall back to the next non-empty line (common in two-column layouts).
        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const next = lines[j].trim();
          if (!next) continue;
          const nextMatch = next.match(valuePattern);
          if (nextMatch) return nextMatch[0].trim();
          break;
        }
      }
    }
    return "";
  }

  /**
   * Like findLabelValue, but returns the *last* matching value on the label
   * line (or the next non-empty line if none on the label line). This is
   * critical for tabular invoices, where the label sits at column 0 and the
   * row contains many money values across columns: the rightmost is almost
   * always the grand total / total invoice value, not the leftmost.
   *
   * Iteration order is `labels first, then lines` — that way the
   * most-specific label in the list (e.g. "Grand Total") is matched against
   * the whole document before more permissive labels (e.g. "Total Invoice
   * Value", which can also appear as a column header) get a chance.
   */
  function findLabelValueLast(text, labelPatterns, valuePattern) {
    const lines = text.split("\n");
    const globalRe = new RegExp(
      valuePattern.source,
      (valuePattern.flags || "").replace("g", "") + "g"
    );
    for (const labelRe of labelPatterns) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const labelMatch = line.match(labelRe);
        if (!labelMatch) continue;

        const afterLabel = line.slice(labelMatch.index + labelMatch[0].length);
        const allOnLine = afterLabel.match(globalRe);
        if (allOnLine && allOnLine.length) {
          return allOnLine[allOnLine.length - 1].trim();
        }

        // Same-line had no money. Fall through to the next non-empty line
        // — UNLESS this looks like a column header (lots of other text
        // before the label on the same line). On column header rows the
        // "next non-empty line" is the first data row, not the totals row.
        const beforeLabel = line.slice(0, labelMatch.index).trim();
        const looksLikeColumnHeader =
          beforeLabel.length > 20 && /\s.*\s/.test(beforeLabel);
        if (looksLikeColumnHeader) continue;

        for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
          const next = lines[j].trim();
          if (!next) continue;
          const all = next.match(globalRe);
          if (all && all.length) return all[all.length - 1].trim();
          break;
        }
      }
    }
    return "";
  }

  // ---------------------------------------------------------------------------
  // Vendor
  // ---------------------------------------------------------------------------

  // Hints that strongly suggest a line is a company / legal entity name.
  const COMPANY_SUFFIX_RE =
    /\b(LIMITED|LTD|INC|INCORPORATED|LLC|L\.L\.C\.|CORP(ORATION)?|COMPANY|CO\.?|PVT|PRIVATE|GMBH|AG|S\.A\.|SARL|SAS|BV|N\.V\.|PLC|LLP|HOLDINGS|GROUP|INDUSTRIES|ENTERPRISES|TECHNOLOGIES)\b/i;

  function extractVendor(text) {
    // Direct labels first: "Vendor: ACME", "From: ACME Inc."
    const labeled = findLabelValue(
      text,
      [
        /^\s*vendor\s*[:\-]/i,
        /^\s*from\s*[:\-]/i,
        /^\s*supplier\s*[:\-]/i,
        /^\s*bill(ed)?\s*from\s*[:\-]/i,
        /^\s*sold\s*by\s*[:\-]/i,
        /^\s*issued\s*by\s*[:\-]/i,
      ],
      /[A-Za-z][^\n]{1,80}/
    );
    if (labeled) return cleanVendor(labeled);

    // Score the first ~20 non-empty lines and pick the most "company-like"
    // one. Pure heuristics, but they handle a wide range of real invoices —
    // including the case where the document title ("Tax Invoice"), a copy
    // marker ("(Original For Recipient)"), and the actual vendor name are
    // all in the header area in different fonts / positions.
    const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
    let best = "";
    let bestScore = -Infinity;
    for (let i = 0; i < Math.min(20, lines.length); i++) {
      const line = lines[i];
      const score = scoreVendorCandidate(line, i);
      if (score > bestScore) {
        bestScore = score;
        best = line;
      }
    }
    return bestScore > 0 ? cleanVendor(best) : "";
  }

  function scoreVendorCandidate(line, index) {
    // Hard rejects.
    if (line.length < 2 || line.length > 80) return -Infinity;
    if (/^(tax\s+)?invoice\b/i.test(line)) return -Infinity;
    if (/^receipt\b/i.test(line)) return -Infinity;
    if (/^statement\b/i.test(line)) return -Infinity;
    if (/^bill\s+(of|to|from)\b/i.test(line)) return -Infinity;
    if (/^https?:\/\//i.test(line)) return -Infinity;
    if (/^[\d\s\-\/.,#]+$/.test(line)) return -Infinity;
    // Parenthesized notes: "(Original For Recipient)", "(Duplicate)" etc.
    if (/^\s*\(.+\)\s*$/.test(line)) return -Infinity;
    // Lines that look like a label/value pair are header noise, not the vendor.
    if (/^[A-Za-z ]{2,30}\s*:\s*\S/.test(line) && !COMPANY_SUFFIX_RE.test(line)) {
      return -Infinity;
    }
    // Address / contact lines.
    if (/^(address|phone|tel|fax|email|gstin|gstn|pan|cin|website|reg(istration)?\s*no)\b/i.test(line)) {
      return -Infinity;
    }
    if (/\b(street|road|avenue|lane|airport|p\.?o\.?\s*box|suite|floor)\b/i.test(line) && !COMPANY_SUFFIX_RE.test(line)) {
      return -Infinity;
    }

    let score = 0;
    // Earlier lines are slightly preferred (header area).
    score += Math.max(0, 5 - index * 0.25);
    // Strong: legal-entity suffix.
    if (COMPANY_SUFFIX_RE.test(line)) score += 8;
    // Strong: ALL CAPS company-style name.
    const letters = line.replace(/[^A-Za-z]/g, "");
    if (letters.length >= 4) {
      const upperRatio = letters.replace(/[^A-Z]/g, "").length / letters.length;
      if (upperRatio >= 0.85) score += 4;
      else if (upperRatio >= 0.6) score += 1;
    }
    // Slight: reasonable name length.
    if (line.length >= 5 && line.length <= 60) score += 1;
    // Mild penalty if line looks like a sentence (lots of lowercase + spaces).
    if (line.split(/\s+/).length > 8) score -= 1;
    return score;
  }

  function cleanVendor(value) {
    return value.replace(/\s{2,}/g, " ").replace(/[•·|]+$/g, "").trim();
  }

  // ---------------------------------------------------------------------------
  // Invoice number
  // ---------------------------------------------------------------------------

  function extractInvoiceNumber(text) {
    // Traditional invoice / billing labels first.
    const value = findLabelValue(
      text,
      [
        /invoice\s*(?:#|no\.?|number|num)\s*[:\-]?/i,
        /inv\s*(?:#|no\.?|number)\s*[:\-]?/i,
        /bill\s*(?:#|no\.?|number)\s*[:\-]?/i,
        /document\s*(?:#|no\.?|number)\s*[:\-]?/i,
        /reference\s*(?:#|no\.?|number)\s*[:\-]?/i,
        /booking\s*(?:id|ref|reference|number|no\.?)\s*[:\-]?/i,
        /confirmation\s*(?:number|code|no\.?)\s*[:\-]?/i,
        /order\s*(?:id|number|no\.?)\s*[:\-]?/i,
      ],
      /[A-Za-z0-9][A-Za-z0-9\-_\/]{2,40}/
    );
    if (value) return value;

    // Travel-itinerary identifiers (MakeMyTrip, IRCTC, airline e-tickets, …).
    // PNRs and e-ticket numbers are uppercase alphanumeric, typically 5–10
    // characters. Tighter character class avoids matching adjacent words.
    const travel = findLabelValue(
      text,
      [
        /pnr\s*(?:no\.?)?\s*[:\-]?/i,
        /e[-\s]?ticket(?:\s*no\.?|\s*number)?\s*[:\-]?/i,
        /ticket\s*(?:no\.?|number)\s*[:\-]?/i,
      ],
      /[A-Z0-9]{4,15}/
    );
    if (travel) return travel;

    const near = text.match(/invoice[^\n]{0,30}#\s*([A-Za-z0-9\-_\/]{3,40})/i);
    return near ? near[1] : "";
  }

  // ---------------------------------------------------------------------------
  // Invoice date
  // ---------------------------------------------------------------------------

  // Matches a wide variety of date formats commonly seen on invoices.
  const DATE_RE =
    /\b(\d{1,2}[\/\-.\s]\d{1,2}[\/\-.\s]\d{2,4}|\d{4}[\/\-.\s]\d{1,2}[\/\-.\s]\d{1,2}|\d{1,2}[\s\-\/](?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*[\s\-\/]\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\s+\d{1,2},?\s+\d{2,4})\b/i;

  const MONTH_NAME_TO_NUM = {
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    may: 5,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    sept: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };

  function expandTwoDigitYear(yStr) {
    if (!yStr) return NaN;
    if (yStr.length === 4) return parseInt(yStr, 10);
    if (yStr.length === 2) {
      const n = parseInt(yStr, 10);
      return n <= 69 ? 2000 + n : 1900 + n;
    }
    return parseInt(yStr, 10);
  }

  function isValidYMD(year, month, day) {
    if (!Number.isFinite(year) || year < 1900 || year > 2100) return false;
    if (!Number.isFinite(month) || month < 1 || month > 12) return false;
    if (!Number.isFinite(day) || day < 1 || day > 31) return false;
    const dt = new Date(Date.UTC(year, month - 1, day));
    return (
      dt.getUTCFullYear() === year &&
      dt.getUTCMonth() === month - 1 &&
      dt.getUTCDate() === day
    );
  }

  function formatDDMMYYYY(day, month, year) {
    const d = String(day).padStart(2, "0");
    const mo = String(month).padStart(2, "0");
    return `${d}-${mo}-${year}`;
  }

  /**
   * Normalize invoice dates to DD-MM-YYYY. Handles ISO, European/US numeric
   * (ambiguous: try day-first, then month-first), and common month-name forms.
   * Unparseable strings are returned unchanged so data is not discarded.
   */
  function normalizeInvoiceDateToDDMMYYYY(raw) {
    if (raw == null) return "";
    let s = String(raw).trim();
    if (!s) return "";
    s = s.replace(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*,?\s+/i, "");

    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/i);
    if (m) {
      const y = +m[1];
      const mo = +m[2];
      const d = +m[3];
      if (isValidYMD(y, mo, d)) return formatDDMMYYYY(d, mo, y);
    }

    m = s.match(/^(\d{4})[\/\/.](\d{1,2})[\/\/.](\d{1,2})(?:\b|$)/);
    if (m) {
      const y = +m[1];
      const mo = +m[2];
      const d = +m[3];
      if (isValidYMD(y, mo, d)) return formatDDMMYYYY(d, mo, y);
    }

    m = s.match(
      /^(\d{1,2})[\/\/.-](\d{1,2})[\/\/.-](\d{2,4})(?:\b(?!\d)|$)/
    );
    if (m) {
      const a = +m[1];
      const b = +m[2];
      const y =
        m[3].length === 4 ? +m[3] : expandTwoDigitYear(m[3]);
      const candidates = [];
      if (a > 12) candidates.push([a, b]);
      else if (b > 12) candidates.push([b, a]);
      else {
        candidates.push([a, b]);
        candidates.push([b, a]);
      }
      for (const [d, mo] of candidates) {
        if (isValidYMD(y, mo, d)) return formatDDMMYYYY(d, mo, y);
      }
    }

    m = s.match(
      /^(\d{1,2})[\s\-\/]+([A-Za-z]{3,})[a-z]*[\s\-\/]+(\d{2,4})/
    );
    if (m) {
      const d = +m[1];
      const monKey = m[2].slice(0, 3).toLowerCase();
      const mo = MONTH_NAMEToNum(monKey);
      if (mo) {
        const y =
          m[3].length === 4 ? +m[3] : expandTwoDigitYear(m[3]);
        if (isValidYMD(y, mo, d)) return formatDDMMYYYY(d, mo, y);
      }
    }

    m = s.match(/^([A-Za-z]{3,})[a-z]*\s+(\d{1,2}),?\s+(\d{2,4})/);
    if (m) {
      const monKey = m[1].slice(0, 3).toLowerCase();
      const mo = MONTH_NAMEToNum(monKey);
      const d = +m[2];
      const y =
        m[3].length === 4 ? +m[3] : expandTwoDigitYear(m[3]);
      if (mo && isValidYMD(y, mo, d)) return formatDDMMYYYY(d, mo, y);
    }

    const parsed = Date.parse(s);
    if (!Number.isNaN(parsed)) {
      const dt = new Date(parsed);
      const y = dt.getFullYear();
      const mo = dt.getMonth() + 1;
      const d = dt.getDate();
      if (isValidYMD(y, mo, d)) return formatDDMMYYYY(d, mo, y);
    }

    return s;
  }

  function MONTH_NAMEToNum(key) {
    return MONTH_NAME_TO_NUM[key] || 0;
  }

  function extractInvoiceDate(text) {
    const labeled = findLabelValue(
      text,
      [
        /invoice\s*date\s*[:\-]?/i,
        /^\s*date\s*[:\-]/im,
        /issue(?:d)?\s*(?:date|on)\s*[:\-]?/i,
        /bill\s*date\s*[:\-]?/i,
      ],
      DATE_RE
    );
    if (labeled) return labeled;

    // Fallback: the first plausible date in the document.
    const m = text.match(DATE_RE);
    return m ? m[0] : "";
  }

  // ---------------------------------------------------------------------------
  // Subtotal / Tax / Total
  // ---------------------------------------------------------------------------

  function extractSubtotal(text) {
    // First try plain "Subtotal / Net amount" labels.
    const direct = findLabelValueLast(
      text,
      [
        /sub[\s\-]?total\s*[:\-]?/i,
        /net\s*amount\s*[:\-]?/i,
        /amount\s*before\s*tax\s*[:\-]?/i,
        /taxable\s*amount\s*[:\-]?/i,
      ],
      MONEY_RE
    );
    if (direct) return direct;

    // Indian GST invoices frequently have "Taxable Value" + "Non-Taxable
    // Value" columns instead. If we find a line where both are present (or
    // a Grand Total row that contains taxable + non-taxable + their sum),
    // attempt to recover the subtotal from the cross-field repair pass
    // instead of guessing here. Returning empty triggers that path.
    return "";
  }

  function extractTax(text) {
    // Direct single-tax label first.
    const direct = findLabelValueLast(
      text,
      [
        /sales\s*tax\s*[:\-]?/i,
        /\bvat\b\s*(?:\(\d+%\))?\s*[:\-]?/i,
        /\bgst\b\s*(?:\(\d+%\))?\s*[:\-]?/i,
        /\bhst\b\s*[:\-]?/i,
        /total\s*tax\s*[:\-]?/i,
        /tax\s*amount\s*[:\-]?/i,
        /^\s*tax\b/im,
      ],
      MONEY_RE
    );
    if (direct) return direct;

    // Indian GST: tax is split across CGST + SGST + IGST columns. Find each
    // (last-occurring, since the first occurrence is usually a column
    // header that has no money value) and sum them.
    const cgst = findLabelValueLast(text, [/\bcgst\b/i], MONEY_RE);
    const sgst = findLabelValueLast(text, [/\bsgst\b/i], MONEY_RE);
    const igst = findLabelValueLast(text, [/\bigst\b/i], MONEY_RE);
    let sum = 0;
    let found = 0;
    for (const v of [cgst, sgst, igst]) {
      const n = parseMoneyToNumber(v);
      if (Number.isFinite(n) && n > 0) {
        sum += n;
        found += 1;
      }
    }
    if (found > 0) return sum.toFixed(2);
    return "";
  }

  function extractTotal(text) {
    // Sentence-style labels. The value sits immediately after the label, so
    // we want the FIRST money match — using last-match here would wrongly
    // grab "INR 25" from a phrase like "You have paid INR 2264 You saved
    // INR 25". Common on travel itineraries (MakeMyTrip, Cleartrip, Yatra,
    // IRCTC, airline e-tickets, ride receipts).
    const sentence = [
      [/you\s+(?:have\s+)?paid\s*[:\-]?/i],
      [/amount\s+paid\s*[:\-]?/i],
      [/total\s+paid\s*[:\-]?/i],
      [/you\s+pay\s*[:\-]?/i],
    ];
    for (const labels of sentence) {
      const v = findLabelValue(text, labels, MONEY_RE);
      if (v) return v;
    }

    // Tabular-style labels. Label sits at column 0 and the value we want is
    // the rightmost money on the row (e.g. Indian GST grand-total rows).
    const tabular = [
      [/grand\s*total\s*[:\-]?/i, /total\s*invoice\s*value\s*[:\-]?/i],
      [/amount\s*payable\s*[:\-]?/i, /net\s*payable\s*[:\-]?/i],
      [/amount\s*due\s*[:\-]?/i],
      [/balance\s*due\s*[:\-]?/i],
      [/total\s*due\s*[:\-]?/i],
      [/total\s*amount\s*[:\-]?/i],
      [/invoice\s*total\s*[:\-]?/i],
      [/^\s*total\s*[:\-]/im],
    ];
    for (const labels of tabular) {
      const v = findLabelValueLast(text, labels, MONEY_RE);
      if (v) return v;
    }
    return largestMoney(text);
  }

  function largestMoney(text) {
    const matches = text.match(new RegExp(MONEY_RE.source, "gi")) || [];
    let best = "";
    let bestVal = -Infinity;
    for (const m of matches) {
      const v = parseMoneyToNumber(m);
      if (Number.isFinite(v) && v > bestVal) {
        bestVal = v;
        best = m.trim();
      }
    }
    return best;
  }

  function parseMoneyToNumber(value) {
    if (!value) return NaN;
    let s = String(value).replace(/[^\d,.\-]/g, "");
    if (!s) return NaN;
    // If both separators appear, assume the LAST one is the decimal separator.
    const lastDot = s.lastIndexOf(".");
    const lastComma = s.lastIndexOf(",");
    if (lastDot !== -1 && lastComma !== -1) {
      const decSep = lastDot > lastComma ? "." : ",";
      const thouSep = decSep === "." ? "," : ".";
      s = s.split(thouSep).join("");
      if (decSep === ",") s = s.replace(",", ".");
    } else if (lastComma !== -1 && lastDot === -1) {
      // Only commas. Treat as decimal separator if exactly two trailing digits.
      if (/,\d{2}$/.test(s)) s = s.replace(/\./g, "").replace(",", ".");
      else s = s.replace(/,/g, "");
    } else {
      s = s.replace(/,/g, "");
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : NaN;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function parseInvoiceText(rawText, meta) {
    const text = normalizeText(rawText);
    let record = {
      vendor: extractVendor(text),
      invoiceNumber: extractInvoiceNumber(text),
      invoiceDate: extractInvoiceDate(text),
      currency: extractCurrency(text),
      subtotal: extractSubtotal(text),
      tax: extractTax(text),
      total: extractTotal(text),
    };

    // Vendor-specific rules: well-known issuers (MakeMyTrip, etc.) override
    // the generic vendor heuristic, since the legal entity on the receipt
    // is the booking platform, not the airline / hotel / counterparty.
    record = applyVendorRules(record, text);

    // Cross-field repair: if the math doesn't balance, search the document
    // for a (subtotal, tax) pair that sums to total and use that. Handles
    // tabular Indian GST invoices, multi-column receipts, and any case
    // where the subtotal/tax rows weren't reachable by label matching.
    record = tryRepairTotals(record, text);
    record.invoiceDate = normalizeInvoiceDateToDDMMYYYY(record.invoiceDate);

    return Object.assign(
      {
        id:
          (meta && meta.id) ||
          `inv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        source: (meta && meta.source) || "",
        sourceType: (meta && meta.sourceType) || "html",
        capturedAt: (meta && meta.capturedAt) || new Date().toISOString(),
      },
      record,
      // Store a generous slice of the normalized text so post-hoc analysis
      // (currency migration, future fields) doesn't need to re-process the
      // PDF / HTML source.
      { rawTextPreview: text.slice(0, 1500) }
    );
  }

  // ---------------------------------------------------------------------------
  // Currency detection
  // ---------------------------------------------------------------------------

  /**
   * Best-effort document-level currency detection. Looks for currency
   * symbols and ISO 4217 codes anywhere in the text. Used both at parse
   * time and as a fallback in the totals-row computation when an invoice
   * total prints without an explicit currency (e.g. the Air India
   * "3,261.00" cell — the rupee context lives elsewhere in the document).
   */
  function extractCurrency(text) {
    if (!text) return "";
    // Currency-specific markers, in priority order: prefer unambiguous
    // signals (ISO codes, "Amount In INR" headers) over symbol guesses.
    if (/\bAmount\s+In\s+INR\b/i.test(text)) return "INR";
    if (/\bINR\b|\bRs\.?\b|₹/.test(text)) return "INR";
    if (/\bEUR\b|€/.test(text)) return "EUR";
    if (/\bGBP\b|£/.test(text)) return "GBP";
    if (/\bAED\b/.test(text)) return "AED";
    if (/\bSGD\b/.test(text)) return "SGD";
    if (/\bAUD\b/.test(text)) return "AUD";
    if (/\bCAD\b/.test(text)) return "CAD";
    if (/\bJPY\b|円/.test(text)) return "JPY";
    if (/\bCNY\b|¥/.test(text)) return "CNY";
    if (/\bCHF\b/.test(text)) return "CHF";
    if (/\bUSD\b|\$/.test(text)) return "USD";
    return "";
  }

  // ---------------------------------------------------------------------------
  // Vendor-specific rules
  // ---------------------------------------------------------------------------
  //
  // A small registry of well-known invoice issuers. When a vendor is detected
  // in the document, its overrides win — the generic vendor heuristic would
  // otherwise pick up a counterparty (the airline, hotel, restaurant, etc.)
  // when the actual entity charging money is the booking platform.
  //
  // Each rule is { name, detect(text), overrides: { vendor?, ... } } and is
  // intentionally simple so it's trivial to add more (Cleartrip, Goibibo,
  // Yatra, IRCTC, BookMyShow, Uber, Ola, etc.).

  const VENDOR_RULES = [
    {
      name: "MakeMyTrip",
      detect: (text) =>
        /\bmakemytrip\b/i.test(text) ||
        /\bmake\s*my\s*trip\b/i.test(text) ||
        /makemytrip\.com/i.test(text) ||
        // MakeMyTrip booking IDs are commonly prefixed "NF" or "NN" followed
        // by a long digit string, used as a strong fallback signal.
        /\bMMT[A-Z0-9]+\b/.test(text),
      overrides: { vendor: "MakeMyTrip" },
    },
    // Add more issuers below as they come up.
  ];

  function applyVendorRules(record, text) {
    for (const rule of VENDOR_RULES) {
      try {
        if (rule.detect(text)) {
          if (rule.overrides) {
            for (const [k, v] of Object.entries(rule.overrides)) {
              if (v) record[k] = v;
            }
          }
          record.vendorRule = rule.name;
          break;
        }
      } catch (_) {
        // Bad detector — skip silently. Vendor rules must never throw and
        // break the rest of the pipeline.
      }
    }
    return record;
  }

  // ---------------------------------------------------------------------------
  // Cross-field repair
  // ---------------------------------------------------------------------------

  /**
   * If the heuristic produced subtotal/tax/total values that don't satisfy
   * `subtotal + tax ≈ total` (within ~2% / $0.10), search the document's
   * money tokens for a balanced (sub, tax) pair that does. Pairwise sums of
   * money values are also considered as candidates — this is what recovers
   * the tax field on Indian GST invoices, where tax is split into CGST +
   * SGST (or + IGST) and never appears as a single labeled number.
   */
  function tryRepairTotals(record, text) {
    const tot = parseMoneyToNumber(record.total);
    if (!Number.isFinite(tot) || tot <= 0) return record;

    const sub = parseMoneyToNumber(record.subtotal);
    const tax = parseMoneyToNumber(record.tax);

    // Real invoice math is exact (rounding aside), so the tolerance for the
    // repair search must be tight. A loose tolerance lets the search accept
    // imbalanced pairs like (subtotal, single-CGST-value) instead of the
    // correct (subtotal, CGST + SGST) — which is exactly the failure mode
    // we're trying to repair.
    const tolerance = Math.max(0.05, Math.abs(tot) * 0.001);

    const haveSub = Number.isFinite(sub);
    const haveTax = Number.isFinite(tax);

    if (haveSub && haveTax && Math.abs(sub + tax - tot) <= tolerance) {
      return record; // already balanced
    }

    // Collect money-shaped tokens. Filters that keep the candidate set clean:
    //   - require a 2-digit decimal portion (cents) so dates / IDs / rates /
    //     postal codes / counts don't pollute the search space
    //   - skip values immediately followed by '%' (those are rates, not money)
    //   - skip values larger than the total (single line items can't exceed
    //     the grand total of the same invoice)
    const re = new RegExp(MONEY_RE.source, "gi");
    const seen = new Map();
    let m;
    while ((m = re.exec(text)) !== null) {
      const str = m[0];
      if (!/\d[.,]\d{2}(?!\d)/.test(str)) continue;
      const after = text.slice(m.index + str.length, m.index + str.length + 4);
      if (/^\s*%/.test(after)) continue;

      const num = parseMoneyToNumber(str);
      if (!Number.isFinite(num) || num <= 0) continue;
      if (num > tot * 1.05) continue;
      if (Math.abs(num - tot) <= 0.01) continue;

      const key = num.toFixed(2);
      if (!seen.has(key)) seen.set(key, { num, str: str.trim() });
    }
    const baseValues = [...seen.values()];
    if (baseValues.length < 2) return record;

    // Augment with pairwise sums to recover split taxes
    // (CGST 56.57 + SGST 56.57 = 113.14, etc.).
    const candidates = baseValues.slice();
    for (let i = 0; i < baseValues.length; i++) {
      for (let j = i; j < baseValues.length; j++) {
        const s = baseValues[i].num + baseValues[j].num;
        if (s > tot * 1.05 || s < 0.5) continue;
        if (Math.abs(s - tot) <= 0.01) continue;
        candidates.push({
          num: s,
          str: s.toFixed(2),
          derived: true,
          parts: [baseValues[i].str, baseValues[j].str],
        });
      }
    }

    let best = null;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      for (let j = 0; j < candidates.length; j++) {
        if (i === j) continue;
        const a = candidates[i];
        const b = candidates[j];
        if (Math.abs(a.num + b.num - tot) > tolerance) continue;

        // Convention: subtotal is the larger of the two, tax the smaller.
        const subN = Math.max(a.num, b.num);
        const taxN = Math.min(a.num, b.num);
        const subSrc = subN === a.num ? a : b;
        const taxSrc = subN === a.num ? b : a;

        // Realistic invoice: subtotal must be at least ~1.5× tax, and the
        // implied tax rate must be in a plausible band. This rules out the
        // (2376, 885) ≈ 3261 trap on the Air India invoice (those are two
        // line-item totals, not subtotal + tax).
        const ratio = taxN / Math.max(subN, 0.01);
        if (ratio < 0.001 || ratio > 0.5) continue;
        if (subN < taxN * 1.5) continue;

        let score = 0;
        // In-band tax rate (1% – 30% — covers VAT, GST, sales tax).
        if (ratio >= 0.01 && ratio <= 0.3) score += 6;
        if (subSrc.derived) score -= 4;
        // A derived tax is *expected* on Indian invoices (CGST + SGST), so
        // penalize it less than a derived subtotal.
        if (taxSrc.derived) score -= 1;
        // Heavily prefer whatever the heuristic already labeled.
        if (haveSub && Math.abs(subN - sub) <= 0.1) score += 8;
        if (haveTax && Math.abs(taxN - tax) <= 0.1) score += 8;
        // Tiebreaker: larger subtotal is closer to the actual invoice value.
        score += subN / 1e7;

        if (score > bestScore) {
          bestScore = score;
          best = { subSrc, taxSrc, subN, taxN };
        }
      }
    }

    if (!best) return record;

    const out = Object.assign({}, record);
    if (!haveSub || Math.abs(sub - best.subN) > 0.1) {
      out.subtotal = best.subSrc.derived ? best.subN.toFixed(2) : best.subSrc.str;
    }
    if (!haveTax || Math.abs(tax - best.taxN) > 0.1) {
      out.tax = best.taxSrc.derived ? best.taxN.toFixed(2) : best.taxSrc.str;
    }
    return out;
  }

  function validateTotals(record) {
    const sub = parseMoneyToNumber(record && record.subtotal);
    const tax = parseMoneyToNumber(record && record.tax);
    const tot = parseMoneyToNumber(record && record.total);

    const haveSub = Number.isFinite(sub);
    const haveTax = Number.isFinite(tax);
    const haveTot = Number.isFinite(tot);

    if (!haveTot) return { ok: true, diff: 0, tolerance: 0, reason: "no total" };
    if (!haveSub && !haveTax) {
      return { ok: true, diff: 0, tolerance: 0, reason: "only total" };
    }

    const expectedTotal = (haveSub ? sub : 0) + (haveTax ? tax : 0);
    const diff = Math.abs(tot - expectedTotal);
    const tolerance = Math.max(0.1, Math.abs(tot) * 0.02);
    return {
      ok: diff <= tolerance,
      diff,
      tolerance,
      reason: diff <= tolerance ? "balanced" : "imbalanced",
    };
  }

  global.InvoiceParser = {
    normalizeText,
    parseInvoiceText,
    parseMoneyToNumber,
    extractCurrency,
    normalizeInvoiceDate: normalizeInvoiceDateToDDMMYYYY,
    validateTotals,
  };
})(typeof self !== "undefined" ? self : this);

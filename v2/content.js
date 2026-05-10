/*
 * content.js
 * ----------
 * Content script that extracts visible text from the active page when the
 * popup asks for it. The popup, not the content script, is responsible for
 * parsing the text into invoice fields — keeping parsing in one place ensures
 * PDF and HTML invoices share identical heuristics.
 *
 * The script intentionally does almost nothing on load. It just listens for
 * a single "extractInvoiceText" message from the extension runtime.
 */
(function () {
  "use strict";

  // Guard against duplicate registration when executeScript injects this
  // file more than once into the same tab during a session.
  if (window.__invoiceReaderContentLoaded__) return;
  window.__invoiceReaderContentLoaded__ = true;

  /**
   * Walk the DOM and return the visible text content of the current page.
   * Hidden elements (display: none, visibility: hidden, aria-hidden=true) and
   * non-content tags (script/style/noscript) are skipped so the parser does
   * not see template noise.
   */
  function extractVisibleText(root) {
    const SKIP_TAGS = new Set([
      "SCRIPT",
      "STYLE",
      "NOSCRIPT",
      "TEMPLATE",
      "SVG",
      "CANVAS",
      "IFRAME",
      "OBJECT",
      "EMBED",
    ]);

    const walker = document.createTreeWalker(
      root || document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (SKIP_TAGS.has(node.tagName)) {
              return NodeFilter.FILTER_REJECT;
            }
            const style = window.getComputedStyle(node);
            if (
              style &&
              (style.display === "none" ||
                style.visibility === "hidden" ||
                style.opacity === "0")
            ) {
              return NodeFilter.FILTER_REJECT;
            }
            if (node.getAttribute && node.getAttribute("aria-hidden") === "true") {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_SKIP;
          }
          // Text node: keep if it has any non-whitespace content.
          return node.nodeValue && node.nodeValue.trim()
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      }
    );

    const lines = [];
    let lastBlock = null;
    let buffer = [];

    function flush() {
      if (buffer.length) {
        lines.push(buffer.join(" ").replace(/\s+/g, " ").trim());
        buffer = [];
      }
    }

    let node;
    while ((node = walker.nextNode())) {
      const parent = node.parentElement;
      const block = nearestBlock(parent);
      if (block !== lastBlock) {
        flush();
        lastBlock = block;
      }
      buffer.push(node.nodeValue.trim());
    }
    flush();

    return lines.filter(Boolean).join("\n");
  }

  /**
   * Climb the parent chain until we hit a block-level element. Used so that
   * inline text inside the same paragraph is concatenated on one line, while
   * different paragraphs / table cells / list items appear on separate lines.
   */
  function nearestBlock(el) {
    let node = el;
    while (node && node !== document.body) {
      const display = window.getComputedStyle(node).display;
      if (
        display &&
        display !== "inline" &&
        display !== "inline-block" &&
        display !== "inline-flex" &&
        display !== "contents"
      ) {
        return node;
      }
      node = node.parentElement;
    }
    return document.body;
  }

  /**
   * Look for schema.org structured data describing an invoice / order. When
   * present, this is essentially ground truth — far more reliable than any
   * text-based heuristic.
   *
   * Returns a partial { vendor, invoiceNumber, invoiceDate, subtotal, tax,
   * total, currency } object, or null if nothing relevant was found.
   */
  function extractStructuredData() {
    const candidates = [];

    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const s of scripts) {
      try {
        const data = JSON.parse(s.textContent || "");
        collectFromLd(data, candidates);
      } catch (_) {
        /* ignore malformed JSON-LD */
      }
    }

    // Choose the most "invoice-like" candidate.
    const ranked = candidates
      .map((c) => ({ c, score: scoreCandidate(c) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    return ranked.length ? normalizeLdRecord(ranked[0].c) : null;
  }

  function collectFromLd(node, out) {
    if (!node) return;
    if (Array.isArray(node)) {
      node.forEach((n) => collectFromLd(n, out));
      return;
    }
    if (typeof node !== "object") return;

    const t = node["@type"];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => /Invoice|Order|Receipt/i.test(String(x)))) {
      out.push(node);
    }
    if (node["@graph"]) collectFromLd(node["@graph"], out);
    // Nested entities (some schemas embed the invoice inside another type).
    for (const k of Object.keys(node)) {
      if (k === "@graph" || k === "@type") continue;
      const v = node[k];
      if (v && typeof v === "object") collectFromLd(v, out);
    }
  }

  function scoreCandidate(c) {
    let s = 0;
    if (c.totalPaymentDue || c.totalPrice || c.priceTotal || c.total) s += 3;
    if (c.confirmationNumber || c.orderNumber || c.invoiceNumber) s += 2;
    if (c.provider || c.seller || c.merchant || c.broker) s += 2;
    if (c.paymentDueDate || c.orderDate || c.dateCreated) s += 1;
    return s;
  }

  function pickName(obj) {
    if (!obj) return "";
    if (typeof obj === "string") return obj;
    return obj.name || obj.legalName || obj.brand || "";
  }

  function pickPrice(obj) {
    if (!obj) return { value: "", currency: "" };
    if (typeof obj === "string" || typeof obj === "number") {
      return { value: String(obj), currency: "" };
    }
    return {
      value:
        obj.price ?? obj.value ?? obj.amount ?? obj.priceAmount ?? "",
      currency:
        obj.priceCurrency || obj.currency || obj.currencyCode || "",
    };
  }

  function normalizeLdRecord(c) {
    const totalPrice = pickPrice(
      c.totalPaymentDue || c.totalPrice || c.priceTotal || c.total
    );
    return {
      vendor: pickName(c.provider || c.seller || c.merchant || c.broker),
      invoiceNumber:
        c.confirmationNumber ||
        c.orderNumber ||
        c.invoiceNumber ||
        c.identifier ||
        "",
      invoiceDate:
        c.paymentDueDate || c.orderDate || c.dateCreated || c.datePublished || "",
      currency: totalPrice.currency,
      subtotal: "",
      tax: "",
      total:
        totalPrice.value !== "" && totalPrice.value != null
          ? String(totalPrice.value)
          : "",
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "extractInvoiceText") return false;
    try {
      const text = extractVisibleText(document.body);
      const structured = extractStructuredData();
      sendResponse({
        ok: true,
        text,
        structured,
        url: location.href,
        title: document.title || location.hostname,
      });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
    return false;
  });
})();

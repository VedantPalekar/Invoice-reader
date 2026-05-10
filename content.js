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
      "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "SVG",
      "CANVAS", "IFRAME", "OBJECT", "EMBED",
    ]);

    const walker = document.createTreeWalker(
      root || document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
      {
        acceptNode(node) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            if (SKIP_TAGS.has(node.tagName)) return NodeFilter.FILTER_REJECT;
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

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "extractInvoiceText") return false;
    try {
      const text = extractVisibleText(document.body);
      sendResponse({
        ok: true,
        text,
        url: location.href,
        title: document.title || location.hostname,
      });
    } catch (err) {
      sendResponse({ ok: false, error: String(err && err.message || err) });
    }
    return false;
  });
})();

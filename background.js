/*
 * background.js
 * -------------
 * MV3 service worker. Kept intentionally small: the heavy lifting (PDF
 * parsing, Excel export, UI) all runs in the popup context where the
 * required vendor libraries are loaded.
 *
 * Responsibilities:
 *   1. Initialize the chrome.storage.local schema on install.
 *   2. Inject the content script on demand if it has not been auto-injected
 *      yet (e.g. for tabs that were already open before the extension was
 *      loaded). The popup calls into this worker via runtime messages.
 */

const STORAGE_KEY = "invoices";

chrome.runtime.onInstalled.addListener(async () => {
  const existing = await chrome.storage.local.get(STORAGE_KEY);
  if (!Array.isArray(existing[STORAGE_KEY])) {
    await chrome.storage.local.set({ [STORAGE_KEY]: [] });
  }
});

/**
 * Programmatically inject the content + parser scripts into a tab and request
 * the visible text. Using chrome.scripting here (instead of declaring a
 * matches-based content_script in the manifest) keeps the extension dormant
 * until the user explicitly clicks "Add current page as invoice".
 */
async function captureTabInvoiceText(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["content.js"],
  });

  return await chrome.tabs.sendMessage(tabId, { type: "extractInvoiceText" });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "captureActiveTab") return false;

  (async () => {
    try {
      const [tab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      if (!tab || tab.id == null) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      if (
        tab.url &&
        /^(chrome|edge|about|chrome-extension|brave):/i.test(tab.url)
      ) {
        sendResponse({
          ok: false,
          error:
            "This page is a browser internal page and cannot be scraped. Open the invoice page in a normal tab.",
        });
        return;
      }
      const result = await captureTabInvoiceText(tab.id);
      sendResponse(result || { ok: false, error: "No response from page" });
    } catch (err) {
      sendResponse({
        ok: false,
        error: String((err && err.message) || err),
      });
    }
  })();

  return true; // keep the message channel open for the async response
});

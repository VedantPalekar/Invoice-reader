/*
 * llm.js
 * ------
 * LLM-backed invoice field extraction. Provides a single async function
 *
 *   InvoiceLLM.extract(text, settings, options) -> Promise<{record, raw}>
 *
 * that takes the normalized invoice text and an LLM settings object
 * (`{ provider, apiKey, model, baseUrl? }`) and returns a structured invoice
 * record. The function dispatches to either the OpenAI Chat Completions API
 * (also compatible with most OpenAI-compatible providers — Mistral, DeepSeek,
 * Together, local Ollama, etc.) or the Anthropic Messages API.
 *
 * Both providers are asked for STRICT JSON output via:
 *   - OpenAI: response_format={type:"json_schema", json_schema:{...}}
 *   - Anthropic: a tool definition + tool_choice forcing tool use
 *
 * This guarantees valid JSON without us having to repair model output.
 *
 * The script attaches `InvoiceLLM` to the global namespace so popup.js can
 * use it directly. No bundler required.
 */
(function (global) {
  "use strict";

  // The schema used by both providers. Kept identical so the rest of the app
  // does not care which model produced the result. Strings — never numbers —
  // because invoices contain currency symbols, locale-specific separators,
  // and free-form dates that we want to preserve verbatim for display.
  const SCHEMA = {
    name: "extract_invoice_fields",
    description:
      "Extract canonical invoice fields from raw invoice text. Return null for any field that is not unambiguously present.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        vendor: {
          type: ["string", "null"],
          description:
            "The seller / supplier / company that issued the invoice (the entity charging money). NOT the bill-to / customer name.",
        },
        invoiceNumber: {
          type: ["string", "null"],
          description:
            "The invoice number / reference / document ID, exactly as printed.",
        },
        invoiceDate: {
          type: ["string", "null"],
          description:
            "Invoice issue date as DD-MM-YYYY when unambiguous. Otherwise return the date exactly as printed.",
        },
        currency: {
          type: ["string", "null"],
          description:
            "ISO 4217 code of the document currency (e.g. USD, EUR, INR, GBP). Return null if not determinable.",
        },
        subtotal: {
          type: ["string", "null"],
          description:
            "Pre-tax subtotal / net amount as a string formatted exactly as printed (including currency symbol if shown).",
        },
        tax: {
          type: ["string", "null"],
          description:
            "Total tax amount (VAT / GST / sales tax) as a string formatted exactly as printed.",
        },
        total: {
          type: ["string", "null"],
          description:
            "The grand total / amount due as a string formatted exactly as printed.",
        },
        notes: {
          type: ["string", "null"],
          description:
            "Optional one-line free-form note about ambiguity (e.g. 'multiple totals present, picked Amount Due').",
        },
      },
      required: [
        "vendor",
        "invoiceNumber",
        "invoiceDate",
        "currency",
        "subtotal",
        "tax",
        "total",
        "notes",
      ],
    },
  };

  // Compact, pointed system prompt. Keeping it short reduces tokens and
  // keeps the model focused on field extraction (not summarization).
  const SYSTEM_PROMPT = `You are an invoice data extractor. You receive an invoice as text (possibly with imperfect layout from PDF/HTML extraction) and/or as one or more page images. Return a JSON object matching the tool/schema exactly.

General rules:
- Extract values verbatim; do not invent or compute. Return null if a field is not unambiguously present.
- "Vendor" is the SELLER / issuer (the party charging money). NEVER the bill-to / customer / passenger / ship-to.
- "Total" is the FINAL amount payable for the whole invoice — the bottom-line grand total.
- For currency, return the ISO 4217 code (USD, EUR, GBP, INR, JPY, AED, ...) inferred from symbols (₹, $, €, £) or text.
- For invoiceDate, return DD-MM-YYYY when unambiguous (e.g. "March 15, 2024" → "15-03-2024", ISO "2024-03-15" → "15-03-2024"). Otherwise return the date verbatim.

Total selection (critical):
- If the document has a "Grand Total" row, use it. Pick the value in the FINAL / rightmost monetary column ("Total Invoice Value", "Total Amount", "Amount Payable", "Net Payable", "Balance Due"), NOT an intermediate subtotal column.
- Label priority (most → least specific): Grand Total > Total Invoice Value > Amount Due > Net Payable > Balance Due > Total > Invoice Total.
- Subtotal+Tax should approximately equal Total. If your candidate values don't satisfy this within ~2%, you have probably picked the wrong column — re-examine.

Tabular invoices (CRITICAL — common source of errors):
- Many invoices (especially Indian GST tax invoices) have multi-column tables: Taxable Value | Non-Taxable Value | Subtotal | CGST | SGST | IGST | Total Invoice Value. The TRUE invoice total is in the rightmost column, not in any breakdown column.
- For Indian GST invoices: Tax = CGST + SGST + IGST combined. Subtotal = Taxable Value + Non-Taxable Value (or "Total" column before tax). Total = "Total Invoice Value" / "Grand Total" (rightmost).
- When you see images, READ THE TABLE VISUALLY by column positions. Do not pick the first number after "Grand Total" — pick the one in the correct column.

When given page images, prefer the images for layout-sensitive fields (totals, line items, tabular sums) and use the text only for verbatim spellings of invoice numbers, dates, and vendor names.`;

  // ---------------------------------------------------------------------------
  // Provider: OpenAI (and OpenAI-compatible)
  // ---------------------------------------------------------------------------

  async function extractWithOpenAI(text, images, settings, signal) {
    const baseUrl = (settings.baseUrl || "https://api.openai.com").replace(
      /\/+$/,
      ""
    );
    const url = `${baseUrl}/v1/chat/completions`;

    // Build a multi-modal user message: optional image parts followed by
    // the invoice text. OpenAI requires the content array form when any
    // image_url part is present.
    const userParts = [];
    for (const dataUrl of images || []) {
      userParts.push({
        type: "image_url",
        image_url: { url: dataUrl, detail: "high" },
      });
    }
    userParts.push({
      type: "text",
      text: `Extract the invoice fields. ${images && images.length ? `${images.length} page image(s) attached above; treat them as the source of truth for tabular layouts.` : ""}\n\n--- BEGIN INVOICE TEXT ---\n${truncate(text, 18000)}\n--- END INVOICE TEXT ---`,
    });

    const body = {
      model: settings.model || "gpt-4o-mini",
      temperature: 0,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userParts },
      ],
      // Strict structured output — the API rejects any model response that
      // doesn't conform to the schema, so we never have to repair JSON.
      response_format: {
        type: "json_schema",
        json_schema: {
          name: SCHEMA.name,
          schema: SCHEMA.parameters,
          strict: true,
        },
      },
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      throw new Error(await formatHttpError(res, "OpenAI"));
    }

    const data = await res.json();
    const raw = data?.choices?.[0]?.message?.content;
    if (!raw) throw new Error("OpenAI returned an empty response");
    return parseJsonOrThrow(raw);
  }

  // ---------------------------------------------------------------------------
  // Provider: Anthropic
  // ---------------------------------------------------------------------------

  async function extractWithAnthropic(text, images, settings, signal) {
    const baseUrl = (settings.baseUrl || "https://api.anthropic.com").replace(
      /\/+$/,
      ""
    );
    const url = `${baseUrl}/v1/messages`;

    // Build a multi-modal user message: image blocks first (so the model
    // attends to them as primary evidence), then the text block.
    const userContent = [];
    for (const dataUrl of images || []) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || "");
      if (!m) continue;
      userContent.push({
        type: "image",
        source: { type: "base64", media_type: m[1], data: m[2] },
      });
    }
    userContent.push({
      type: "text",
      text: `Extract the invoice fields. ${images && images.length ? `${images.length} page image(s) attached above; treat them as the source of truth for tabular layouts.` : ""}\n\n--- BEGIN INVOICE TEXT ---\n${truncate(text, 18000)}\n--- END INVOICE TEXT ---`,
    });

    const body = {
      model: settings.model || "claude-haiku-4-5",
      max_tokens: 1024,
      temperature: 0,
      system: SYSTEM_PROMPT,
      // Tool-use with tool_choice forces structured JSON output.
      tools: [
        {
          name: SCHEMA.name,
          description: SCHEMA.description,
          input_schema: SCHEMA.parameters,
        },
      ],
      tool_choice: { type: "tool", name: SCHEMA.name },
      messages: [{ role: "user", content: userContent }],
    };

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        // Required so the API allows requests from a browser extension.
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!res.ok) {
      throw new Error(await formatHttpError(res, "Anthropic"));
    }

    const data = await res.json();
    const block = (data?.content || []).find((b) => b.type === "tool_use");
    if (!block || !block.input) {
      throw new Error("Anthropic returned no tool_use block");
    }
    return block.input;
  }

  // ---------------------------------------------------------------------------
  // Public entry point
  // ---------------------------------------------------------------------------

  /**
   * @param {string} text - The normalized invoice text (PDF or HTML).
   * @param {{provider: string, apiKey: string, model?: string, baseUrl?: string}} settings
   * @param {{signal?: AbortSignal, timeoutMs?: number, images?: string[]}} [options]
   *   `options.images` is an optional array of `data:image/...;base64,...`
   *   URLs (typically rendered PDF pages) that will be sent alongside the
   *   text. Both providers in this module support vision input.
   * @returns {Promise<{record: object, raw: object}>}
   */
  async function extract(text, settings, options) {
    if (!settings || !settings.apiKey) {
      throw new Error("LLM API key is not configured");
    }
    const hasText = text && text.trim();
    const images = (options && options.images) || [];
    if (!hasText && images.length === 0) {
      throw new Error("No text and no images — nothing to extract");
    }

    const ctrl = new AbortController();
    const timeoutMs =
      (options && options.timeoutMs) || (images.length ? 90000 : 45000);
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    if (options && options.signal) {
      options.signal.addEventListener("abort", () => ctrl.abort());
    }

    try {
      let raw;
      switch ((settings.provider || "openai").toLowerCase()) {
        case "anthropic":
          raw = await extractWithAnthropic(text || "", images, settings, ctrl.signal);
          break;
        case "openai":
        default:
          raw = await extractWithOpenAI(text || "", images, settings, ctrl.signal);
          break;
      }

      // Some models emit "" for missing fields instead of null. Normalize.
      const norm = {};
      for (const k of Object.keys(SCHEMA.parameters.properties)) {
        const v = raw && raw[k];
        norm[k] = v === undefined || v === null || v === "" ? "" : String(v);
      }
      return { record: norm, raw };
    } finally {
      clearTimeout(timer);
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function truncate(text, max) {
    if (!text) return "";
    if (text.length <= max) return text;
    // Keep both ends: invoice headers often hold the vendor; footers hold the
    // total. Drop the middle to fit within the model's context budget.
    const half = Math.floor(max / 2) - 32;
    return (
      text.slice(0, half) +
      `\n\n[... ${text.length - max} characters omitted ...]\n\n` +
      text.slice(-half)
    );
  }

  function parseJsonOrThrow(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      // Some smaller models occasionally wrap JSON in markdown fences.
      const m = String(s).match(/\{[\s\S]*\}/);
      if (m) {
        try {
          return JSON.parse(m[0]);
        } catch (_) {
          /* fall through */
        }
      }
      throw new Error("Model returned non-JSON output");
    }
  }

  async function formatHttpError(res, providerLabel) {
    let detail = "";
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text);
        detail =
          (json.error && (json.error.message || json.error.type)) ||
          json.message ||
          text.slice(0, 200);
      } catch (_) {
        detail = text.slice(0, 200);
      }
    } catch (_) {
      detail = res.statusText;
    }
    return `${providerLabel} ${res.status}: ${detail || res.statusText}`;
  }

  // ---------------------------------------------------------------------------
  // Defaults (consumed by the settings UI)
  // ---------------------------------------------------------------------------

  const DEFAULTS = {
    openai: {
      label: "OpenAI",
      defaultModel: "gpt-4o-mini",
      modelExamples: ["gpt-4o-mini", "gpt-4o", "gpt-4.1-mini", "gpt-4.1"],
      apiKeyHint: "sk-…",
      apiKeyUrl: "https://platform.openai.com/api-keys",
    },
    anthropic: {
      label: "Anthropic (Claude)",
      defaultModel: "claude-haiku-4-5",
      modelExamples: [
        "claude-haiku-4-5",
        "claude-sonnet-4-5",
        "claude-3-5-haiku-latest",
        "claude-3-5-sonnet-latest",
      ],
      apiKeyHint: "sk-ant-…",
      apiKeyUrl: "https://console.anthropic.com/settings/keys",
    },
  };

  global.InvoiceLLM = { extract, DEFAULTS, SCHEMA };
})(typeof self !== "undefined" ? self : this);

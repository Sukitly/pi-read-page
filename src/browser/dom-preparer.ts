import { parseHTML } from "linkedom";
import type { Page } from "playwright-core";

export async function flattenOpenShadowRoots(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document.querySelectorAll("*").forEach((element) => {
        element.removeAttribute("data-defuddle-shadow");
        const shadowRoot = element.shadowRoot;
        if (shadowRoot?.innerHTML) {
          element.setAttribute("data-defuddle-shadow", shadowRoot.innerHTML);
        }
      });
    })
    .catch(() => undefined);
}

export function prepareHtmlForExtraction(
  html: string,
  url: string,
): {
  extractionHtml: string;
  sanitizedHtml: string;
  fallbackDocument: Document;
} {
  const { document: extractionDocument, baseUrl } = parseDocument(html, url);
  inlineCapturedShadowRoots(extractionDocument);
  absolutizeUrls(extractionDocument, baseUrl);
  const extractionHtml = extractionDocument.documentElement?.outerHTML || html;

  const { document: fallbackDocument, baseUrl: fallbackBaseUrl } =
    parseDocument(extractionHtml, url);
  sanitizeDocumentForOutput(fallbackDocument);
  absolutizeUrls(fallbackDocument, fallbackBaseUrl);

  return {
    extractionHtml,
    sanitizedHtml:
      fallbackDocument.documentElement?.outerHTML || extractionHtml,
    fallbackDocument,
  };
}

function inlineCapturedShadowRoots(document: Document): void {
  document.querySelectorAll("[data-defuddle-shadow]").forEach((host) => {
    const shadowHtml = host.getAttribute("data-defuddle-shadow");
    host.removeAttribute("data-defuddle-shadow");
    if (!shadowHtml) return;

    const { document: shadowDocument } = parseHTML(
      `<html><body>${shadowHtml}</body></html>`,
    );
    const fragment = document.createDocumentFragment();
    for (const node of Array.from(shadowDocument.body?.childNodes ?? [])) {
      fragment.appendChild(document.importNode(node, true));
    }

    if (host.tagName.includes("-") && host.parentNode) {
      const replacement = document.createElement("div");
      replacement.appendChild(fragment);
      host.parentNode.replaceChild(replacement, host);
      return;
    }

    host.textContent = "";
    host.appendChild(fragment);
  });
}

function sanitizeDocumentForOutput(document: Document): void {
  document.querySelectorAll("script, style, noscript").forEach((element) => {
    element.remove();
  });
  document.querySelectorAll("*").forEach((element) => {
    element.removeAttribute("style");
  });
}

function parseDocument(
  html: string,
  url: string,
): { document: Document; baseUrl: string } {
  const { document } = parseHTML(html);
  const base = document.querySelector("base[href]");
  const baseUrl = base?.getAttribute("href")
    ? new URL(base.getAttribute("href") || url, url).href
    : url;

  return { document: document as unknown as Document, baseUrl };
}

function absolutizeUrls(document: Document, baseUrl: string): void {
  document.querySelectorAll("[src], [href], [srcset]").forEach((element) => {
    absolutizeAttribute(element, "src", baseUrl);
    absolutizeAttribute(element, "href", baseUrl);
    absolutizeSrcset(element, baseUrl);
  });
}

function absolutizeAttribute(
  element: Element,
  attr: "src" | "href",
  baseUrl: string,
): void {
  const value = element.getAttribute(attr);
  if (!value) return;
  if (
    value.startsWith("http://") ||
    value.startsWith("https://") ||
    value.startsWith("data:") ||
    value.startsWith("#")
  )
    return;
  if (value.startsWith("//")) {
    const protocol = new URL(baseUrl).protocol;
    element.setAttribute(attr, `${protocol}${value}`);
    return;
  }

  try {
    element.setAttribute(attr, new URL(value, baseUrl).href);
  } catch {
    // Keep the original value if URL parsing fails.
  }
}

function absolutizeSrcset(element: Element, baseUrl: string): void {
  const value = element.getAttribute("srcset");
  if (!value) return;

  const next = value
    .split(",")
    .map((candidate) => {
      const parts = candidate.trim().split(/\s+/);
      const src = parts.shift();
      if (!src) return candidate;

      try {
        const absolute = src.startsWith("data:")
          ? src
          : new URL(src, baseUrl).href;
        return [absolute, ...parts].join(" ");
      } catch {
        return candidate;
      }
    })
    .join(", ");

  element.setAttribute("srcset", next);
}

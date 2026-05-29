import { parseHTML } from "linkedom";
import type { Page } from "playwright-core";

export async function flattenOpenShadowRoots(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      document.querySelectorAll("*").forEach((element) => {
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
): { document: Document; cleanedHtml: string } {
  const { document } = parseHTML(html);

  const base = document.querySelector("base[href]");
  const baseUrl = base?.getAttribute("href")
    ? new URL(base.getAttribute("href") || url, url).href
    : url;

  document.querySelectorAll("script, style, noscript").forEach((element) => {
    element.remove();
  });
  document.querySelectorAll("*").forEach((element) => {
    element.removeAttribute("style");
  });

  absolutizeUrls(document, baseUrl);

  return {
    document: document as unknown as Document,
    cleanedHtml: document.documentElement?.outerHTML || html,
  };
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

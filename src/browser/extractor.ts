import type { DefuddleOptions, DefuddleResponse } from "defuddle/full";
import type { Page } from "playwright-core";
import { createPolicyFetch } from "../security/url-policy";
import type { ExtractedPage, PageMetadata, UserActionDecision } from "../types";
import {
  assessConfidence,
  decideUserAction as decideUserActionFromConfidence,
} from "./confidence";
import {
  flattenOpenShadowRoots,
  prepareHtmlForExtraction,
} from "./dom-preparer";

const DEFAULT_PARSE_TIMEOUT_MS = 8_000;

type ParseMode = ExtractedPage["parseMode"];
type DefuddleNodeModule = typeof import("defuddle/node");

let defuddleNodeModulePromise: Promise<DefuddleNodeModule> | undefined;

async function getDefuddleNodeModule(): Promise<DefuddleNodeModule> {
  defuddleNodeModulePromise ??= import("defuddle/node");
  return defuddleNodeModulePromise;
}

export async function extractMarkdown(page: Page): Promise<ExtractedPage> {
  await flattenOpenShadowRoots(page);

  const url = page.url();
  const rawHtml = await page.content();
  const { fallbackDocument, extractionHtml, sanitizedHtml } =
    prepareHtmlForExtraction(rawHtml, url);
  const { result, parseMode } = await parseWithDefuddle(extractionHtml, url);

  const contentHtml = result.content || fallbackDocument.body?.innerHTML || "";
  const markdown = (
    result.contentMarkdown || structuredTextFallback(contentHtml, url)
  ).trim();
  const textLength = cleanText(markdown).length;
  const metadata = buildMetadata(result);
  const title = cleanText(result.title || document.title || url);

  const withoutConfidence = {
    url,
    title,
    markdown,
    contentHtml,
    fullHtml: sanitizedHtml,
    textLength,
    capturedAt: new Date().toISOString(),
    extractor: "defuddle" as const,
    extraction: result.extractorType || result.debug?.contentSelector || "auto",
    parseMode,
    metadata,
    warnings: buildWarnings(result, markdown, textLength),
    debug: result.debug,
  };

  const confidence = assessConfidence(withoutConfidence);

  return {
    ...withoutConfidence,
    confidence,
  };
}

export function decideUserAction(extracted: ExtractedPage): UserActionDecision {
  return decideUserActionFromConfidence(extracted);
}

async function parseWithDefuddle(
  html: string,
  url: string,
): Promise<{ result: DefuddleResponse; parseMode: ParseMode }> {
  const allowThirdPartyAsync = process.env.READ_PAGE_DEFUDDLE_ASYNC === "1";
  const timeoutMs =
    Number.parseInt(process.env.READ_PAGE_PARSE_TIMEOUT_MS || "", 10) ||
    DEFAULT_PARSE_TIMEOUT_MS;
  const options: DefuddleOptions = {
    url,
    debug: process.env.READ_PAGE_DEFUDDLE_DEBUG === "1",
    useAsync: allowThirdPartyAsync,
    includeReplies: "extractors",
    separateMarkdown: true,
    markdown: false,
    fetch: createPolicyFetch(),
  };

  const { Defuddle } = await getDefuddleNodeModule();

  try {
    const result = await withTimeout(Defuddle(html, url, options), timeoutMs);
    return { result, parseMode: allowThirdPartyAsync ? "async" : "sync" };
  } catch {
    const result = await Defuddle(html, url, {
      ...options,
      useAsync: false,
      separateMarkdown: true,
    });
    return { result, parseMode: "sync-fallback" };
  }
}

function buildMetadata(result: DefuddleResponse): PageMetadata {
  return {
    title: cleanText(result.title || ""),
    author: cleanText(result.author || ""),
    description: cleanText(result.description || ""),
    domain: result.domain || "",
    favicon: result.favicon || "",
    image: result.image || "",
    published: result.published || "",
    site: cleanText(result.site || ""),
    language: result.language || "",
    wordCount: result.wordCount || 0,
    parseTime: result.parseTime || 0,
    schemaOrgData: result.schemaOrgData,
    metaTags: result.metaTags || [],
    variables: result.variables || {},
  };
}

function buildWarnings(
  result: DefuddleResponse,
  markdown: string,
  textLength: number,
): string[] {
  const warnings: string[] = [];

  if (!result.content)
    warnings.push(
      "Defuddle did not return extracted HTML; body fallback may have been used internally.",
    );
  if (!result.contentMarkdown)
    warnings.push(
      "Defuddle did not return Markdown; used structured plain-text fallback, so some formatting may be lost.",
    );
  if (!markdown.trim()) warnings.push("No Markdown content extracted.");
  if (textLength < 500)
    warnings.push(
      "Extracted text is short; the page may require login, captcha, or manual navigation.",
    );
  if (!result.title) warnings.push("No title extracted.");

  return warnings;
}

function structuredTextFallback(html: string, url: string): string {
  const { fallbackDocument } = prepareHtmlForExtraction(
    `<body>${html}</body>`,
    url,
  );
  const blocks = Array.from(
    fallbackDocument.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,pre,blockquote"),
  );

  if (blocks.length === 0) {
    return cleanTextPreservingLines(
      fallbackDocument.body?.textContent ||
        fallbackDocument.documentElement?.textContent ||
        fallbackDocument.textContent ||
        "",
    );
  }

  return blocks
    .map((element) => formatBlock(element))
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function formatBlock(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const text = cleanTextPreservingLines(element.textContent || "");
  if (!text) return "";

  if (/^h[1-6]$/.test(tag))
    return `${"#".repeat(Number(tag.slice(1)))} ${text}`;
  if (tag === "li") return `- ${text}`;
  if (tag === "blockquote")
    return text
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n");
  if (tag === "pre") return `\`\`\`\n${text}\n\`\`\``;
  return text;
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function cleanTextPreservingLines(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

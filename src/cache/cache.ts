import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { NormalizedUrl, UrlNormalization } from "../security/url-policy";
import type { ConfidenceReport, PageMetadata } from "../types";

export const CACHE_DIR = path.join(
  homedir(),
  ".pi",
  "agent",
  "caches",
  "read-page",
);
export const DEFAULT_TTL_DAYS = 30;
export const USER_ACTION_TTL_DAYS = 1;

export type ReadPageCacheSource = "browser";
export type ReadPageCacheStatus =
  | "hit"
  | "miss"
  | "refresh"
  | "refresh-failed-fresh"
  | "stale-fallback";

export type CacheMeta = {
  version: number;
  input_url: string;
  url: string;
  final_url: string;
  cache_key: string;
  url_sha256: string;
  normalization: UrlNormalization;
  source: ReadPageCacheSource;
  extractor: "defuddle";
  extraction: string;
  parse_mode: string;
  browser_profile?: "persistent" | "temporary";
  user_action: boolean;
  confidence: ConfidenceReport;
  metadata: PageMetadata;
  fetched_at: string;
  expires_at: string;
  ttl_days: number;
  content_sha256: string;
  chars: number;
  lines: number;
};

export type CachedDocument = {
  markdown: string;
  meta: CacheMeta;
  fresh: boolean;
};

export type Pagination = {
  selected: string;
  totalLines: number;
  shownStart: number;
  shownEnd: number;
  nextOffset?: number;
};

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function slugify(input: string, fallback: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80)
    .replace(/-$/g, "");
  return slug || fallback;
}

function cacheKey(url: string): string {
  const parsed = new URL(url);
  const urlHash = sha256(url);
  const host = slugify(parsed.hostname, "unknown-host");
  const pathAndSearch = `${parsed.pathname}${parsed.search}`;
  const slug = slugify(pathAndSearch === "/" ? "root" : pathAndSearch, "root");
  return `${host}--${slug}--${urlHash.slice(0, 12)}`;
}

export function cachePaths(url: string): {
  dirPath: string;
  mdPath: string;
  metaPath: string;
  key: string;
  urlSha256: string;
} {
  const key = cacheKey(url);
  const dirPath = path.join(CACHE_DIR, key);
  return {
    dirPath,
    mdPath: path.join(dirPath, "content.md"),
    metaPath: path.join(dirPath, "meta.json"),
    key,
    urlSha256: sha256(url),
  };
}

export function countLines(markdown: string): number {
  return markdown.split(/\r?\n/).length;
}

export function paginate(
  markdown: string,
  offset: number,
  limit: number,
): Pagination {
  const lines = markdown.split(/\r?\n/);
  const totalLines = lines.length;
  const startIndex = Math.max(0, offset - 1);
  if (startIndex >= totalLines) {
    return {
      selected: "",
      totalLines,
      shownStart: totalLines + 1,
      shownEnd: totalLines,
    };
  }
  const endIndex = Math.min(totalLines, startIndex + limit);
  return {
    selected:
      startIndex < totalLines
        ? lines.slice(startIndex, endIndex).join("\n")
        : "",
    totalLines,
    shownStart: totalLines === 0 ? 0 : Math.min(offset, totalLines),
    shownEnd: totalLines === 0 ? 0 : endIndex,
    nextOffset: endIndex < totalLines ? endIndex + 1 : undefined,
  };
}

export async function loadCached(
  url: string,
): Promise<CachedDocument | undefined> {
  const paths = cachePaths(url);
  try {
    return await loadCachedFromPaths(url, paths);
  } catch (error) {
    if (!isNotFoundError(error)) {
      console.warn(
        `[read-page] Ignoring corrupt cache for ${url}: ${errorMessage(error)}`,
      );
    }
    return undefined;
  }
}

export async function loadCachedFromPaths(
  url: string,
  paths: { mdPath: string; metaPath: string },
): Promise<CachedDocument> {
  const [markdown, metaRaw] = await Promise.all([
    readFile(paths.mdPath, "utf8"),
    readFile(paths.metaPath, "utf8"),
  ]);
  const meta = JSON.parse(metaRaw) as CacheMeta;
  if (meta.url !== url) throw new Error("Cache URL mismatch");
  if (meta.content_sha256 !== sha256(markdown))
    throw new Error("Cache checksum mismatch");
  if (!Number.isFinite(Date.parse(meta.expires_at)))
    throw new Error("Invalid cache expires_at");
  const fresh = Date.now() < Date.parse(meta.expires_at);
  return { markdown, meta, fresh };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function writeFileAtomic(
  filePath: string,
  content: string,
): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, content, "utf8");
  await rename(tmpPath, filePath);
}

export async function saveCached(params: {
  normalized: NormalizedUrl;
  finalUrl: string;
  markdown: string;
  extractor: "defuddle";
  extraction: string;
  parseMode: string;
  userAction: boolean;
  confidence: ConfidenceReport;
  metadata: PageMetadata;
  browserProfile?: "persistent" | "temporary";
}): Promise<CacheMeta> {
  const { dirPath, mdPath, metaPath, key, urlSha256 } = cachePaths(
    params.normalized.url,
  );
  await mkdir(dirPath, { recursive: true });

  const now = Date.now();
  const ttlDays = params.userAction ? USER_ACTION_TTL_DAYS : DEFAULT_TTL_DAYS;
  const ttlMs = ttlDays * 24 * 60 * 60 * 1000;

  const meta: CacheMeta = {
    version: 1,
    input_url: params.normalized.inputUrl,
    url: params.normalized.url,
    final_url: params.finalUrl,
    cache_key: key,
    url_sha256: urlSha256,
    normalization: params.normalized.normalization,
    source: "browser",
    extractor: params.extractor,
    extraction: params.extraction,
    parse_mode: params.parseMode,
    browser_profile: params.browserProfile,
    user_action: params.userAction,
    confidence: params.confidence,
    metadata: params.metadata,
    fetched_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttlMs).toISOString(),
    ttl_days: ttlDays,
    content_sha256: sha256(params.markdown),
    chars: params.markdown.length,
    lines: countLines(params.markdown),
  };

  await writeFileAtomic(mdPath, params.markdown);
  await writeFileAtomic(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

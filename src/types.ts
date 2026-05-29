export type HandoffReason = "login_required" | "captcha" | "blocked";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ConfidenceReport {
  level: ConfidenceLevel;
  score: number;
  reasons: string[];
}

export interface PageMetadata {
  title: string;
  author: string;
  description: string;
  domain: string;
  favicon: string;
  image: string;
  published: string;
  site: string;
  language: string;
  wordCount: number;
  parseTime: number;
  schemaOrgData?: unknown;
  metaTags: Array<{ name?: string | null; property?: string | null; content: string | null }>;
  variables: Record<string, string>;
}

export interface ExtractedPage {
  url: string;
  title: string;
  markdown: string;
  contentHtml: string;
  fullHtml: string;
  textLength: number;
  capturedAt: string;
  extractor: "defuddle";
  extraction: string;
  parseMode: "async" | "sync-fallback" | "sync";
  metadata: PageMetadata;
  confidence: ConfidenceReport;
  warnings: string[];
  debug?: unknown;
}

export interface UserActionDecision {
  required: boolean;
  reason?: HandoffReason;
  message?: string;
  confidence: ConfidenceReport;
}

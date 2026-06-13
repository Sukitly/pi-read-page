import type {
  ConfidenceReport,
  ExtractedPage,
  HandoffReason,
  UserActionDecision,
} from "../types";

const CAPTCHA_RE =
  /captcha|recaptcha|hcaptcha|verify you are human|human verification|are you human|请完成安全验证|人机验证/i;
const BLOCK_RE =
  /cloudflare|attention required|checking your browser|just a moment|access denied|temporarily blocked|访问受限|安全检查/i;
const LOGIN_WALL_RE =
  /sign in to continue|log in to continue|login to continue|please sign in|please log in|subscribe to continue|sign up to continue|join to view|登录后(查看|继续|阅读)|请登录(后)?(查看|继续|阅读)?/i;
const LOGIN_URL_RE = /\/(login|signin|sign-in|auth|oauth|session)(\/|$|[?#])/i;
const NAV_ONLY_RE =
  /home\s+about\s+contact|privacy policy|terms of service|all rights reserved/i;

export function assessConfidence(
  page: Omit<ExtractedPage, "confidence">,
): ConfidenceReport {
  const markdown = page.markdown.trim();
  const contentHtml = page.contentHtml.trim();
  const title = page.title.trim();
  const sample =
    `${page.url}\n${title}\n${markdown.slice(0, 10_000)}`.toLowerCase();
  const reasons: string[] = [];

  const wordCount = page.metadata.wordCount || estimateWordCount(markdown);
  const markdownLength = markdown.length;
  let score = 100;

  if (CAPTCHA_RE.test(sample)) {
    score -= 70;
    reasons.push("captcha_or_human_verification_detected");
  }

  if (BLOCK_RE.test(sample)) {
    score -= 70;
    reasons.push("anti_bot_or_access_block_detected");
  }

  if (isLoginWall(page, markdownLength, wordCount)) {
    score -= 65;
    reasons.push("login_wall_detected");
  }

  if (!title) {
    score -= 15;
    reasons.push("missing_title");
  }

  if (!contentHtml) {
    score -= 45;
    reasons.push("missing_extracted_html");
  }

  if (markdownLength < 100) {
    score -= 60;
    reasons.push("markdown_too_short");
  } else if (markdownLength < 500) {
    score -= 25;
    reasons.push("markdown_short");
  } else if (markdownLength < 1_500) {
    score -= 12;
    reasons.push("markdown_somewhat_short");
  }

  if (wordCount < 10) {
    score -= 45;
    reasons.push("word_count_too_low");
  } else if (wordCount < 30) {
    score -= 15;
    reasons.push("word_count_low");
  } else if (wordCount < 200) {
    score -= 8;
    reasons.push("word_count_somewhat_low");
  }

  if (NAV_ONLY_RE.test(sample) && wordCount < 250) {
    score -= 30;
    reasons.push("looks_like_navigation_or_boilerplate");
  }

  if (
    !page.metadata.description &&
    !page.metadata.published &&
    !page.metadata.author &&
    !page.metadata.site
  ) {
    score -= 5;
    reasons.push("little_metadata");
  }

  const boundedScore = Math.max(0, score);
  const level =
    boundedScore >= 70 ? "high" : boundedScore >= 40 ? "medium" : "low";
  return { level, score: boundedScore, reasons };
}

export function decideUserAction(extracted: ExtractedPage): UserActionDecision {
  const handoff = detectActionableHandoff(extracted);
  return {
    required: handoff !== undefined,
    reason: handoff?.reason,
    message: handoff?.message,
    confidence: extracted.confidence,
  };
}

function detectActionableHandoff(
  page: ExtractedPage,
): { reason: HandoffReason; message: string } | undefined {
  const markdown = page.markdown.trim();
  const sample =
    `${page.url}\n${page.title}\n${markdown.slice(0, 10_000)}`.toLowerCase();
  const wordCount = page.metadata.wordCount || estimateWordCount(markdown);
  // Captcha/anti-bot/login handoff is only actionable when the extracted body is
  // thin. A long article that merely discusses these topics is not user-actionable.
  const contentIsThin = wordCount < 120 || markdown.length < 1_200;

  if (contentIsThin && CAPTCHA_RE.test(sample)) {
    return {
      reason: "captcha",
      message: "The page appears to require captcha or human verification.",
    };
  }

  if (contentIsThin && BLOCK_RE.test(sample)) {
    return {
      reason: "blocked",
      message:
        "The page appears to be blocked by an anti-bot or permission interstitial.",
    };
  }

  if (isLoginWall(page, markdown.length, wordCount)) {
    return {
      reason: "login_required",
      message:
        "The page appears to require login, subscription access, or manual navigation.",
    };
  }

  return undefined;
}

function isLoginWall(
  page: Pick<ExtractedPage, "url" | "title" | "markdown" | "contentHtml">,
  markdownLength: number,
  wordCount: number,
): boolean {
  const sample = `${page.url}\n${page.title}\n${page.markdown.slice(0, 10_000)}`;
  const html = page.contentHtml.toLowerCase();
  const hasPasswordInput = /<input\b[^>]*type=["']?password/i.test(html);
  const hasLoginWallText = LOGIN_WALL_RE.test(sample);
  const loginUrl = LOGIN_URL_RE.test(page.url);
  const contentIsThin = wordCount < 120 || markdownLength < 1_200;

  return contentIsThin && (hasPasswordInput || hasLoginWallText || loginUrl);
}

function estimateWordCount(markdown: string): number {
  const asciiWords =
    markdown.match(/[A-Za-z0-9_]+(?:[-'][A-Za-z0-9_]+)*/g)?.length || 0;
  const cjkChars = markdown.match(/[\u3400-\u9fff]/g)?.length || 0;
  return asciiWords + Math.ceil(cjkChars / 2);
}

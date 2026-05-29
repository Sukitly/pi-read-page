import { closeBrowser, openPage } from "../src/browser/browser-manager";
import { decideUserAction, extractMarkdown } from "../src/browser/extractor";

async function main() {
  const url = process.argv[2];
  if (!url) {
    console.error("Usage: npm run smoke -- <url>");
    process.exit(1);
  }

  const page = await openPage(url);
  try {
    const extracted = await extractMarkdown(page);
    const decision = decideUserAction(extracted);

    console.log(JSON.stringify({
      url,
      finalUrl: extracted.url,
      title: extracted.title,
      extractor: extracted.extractor,
      extraction: extracted.extraction,
      parseMode: extracted.parseMode,
      textLength: extracted.textLength,
      wordCount: extracted.metadata.wordCount,
      confidence: extracted.confidence,
      userAction: decision,
      warnings: extracted.warnings,
      markdownPreview: extracted.markdown.slice(0, 1200),
    }, null, 2));
  } finally {
    await page.close().catch(() => undefined);
    await closeBrowser();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

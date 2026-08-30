import {
  closeBrowser,
  closePage,
  openPage,
} from "../src/browser/browser-manager";
import { decideUserAction, extractMarkdown } from "../src/browser/extractor";

async function main() {
  const urls = process.argv.slice(2);
  if (urls.length === 0) {
    console.error("Usage: bun run integration -- <url> [url ...]");
    process.exit(1);
  }

  try {
    const settled = await Promise.allSettled(urls.map(extractUrl));
    const failures = settled.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `${failures.length} browser integration request(s) failed`,
      );
    }

    const results = settled
      .filter(
        (
          result,
        ): result is PromiseFulfilledResult<
          Awaited<ReturnType<typeof extractUrl>>
        > => result.status === "fulfilled",
      )
      .map((result) => result.value);
    console.log(
      JSON.stringify(results.length === 1 ? results[0] : results, null, 2),
    );
  } finally {
    await closeBrowser();
  }
}

async function extractUrl(url: string) {
  const managedPage = await openPage(url);
  try {
    const extracted = await extractMarkdown(managedPage.page);
    const decision = decideUserAction(extracted);
    return {
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
      browserProfile: managedPage.browserProfile,
      warnings: extracted.warnings,
      markdownPreview: extracted.markdown.slice(0, 1200),
    };
  } finally {
    await closePage(managedPage);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

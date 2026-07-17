import { chromium, type Browser } from "playwright";

import { ExtractionError } from "./errors.js";
import type { HtmlRenderer } from "./types.js";

export class PlaywrightHtmlRenderer implements HtmlRenderer {
  private browserPromise: Promise<Browser> | undefined;

  public constructor(
    private readonly userAgent: string,
    private readonly timeoutMs: number,
  ) {}

  public async render(
    html: string,
    baseUrl: string,
    signal: AbortSignal,
  ): Promise<string> {
    try {
      const browser = await this.getBrowser();
      const context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: "block",
        userAgent: this.userAgent,
      });
      try {
        await context.route("**/*", async (route) =>
          route.abort("blockedbyclient"),
        );
        const page = await context.newPage();
        signal.throwIfAborted();
        await page.setContent(injectBaseUrl(html, baseUrl), {
          waitUntil: "domcontentloaded",
          timeout: this.timeoutMs,
        });
        await page.waitForTimeout(100);
        signal.throwIfAborted();
        return await page.content();
      } finally {
        await context.close();
      }
    } catch (error: unknown) {
      if (error instanceof ExtractionError) {
        throw error;
      }
      throw new ExtractionError(
        "BROWSER_UNAVAILABLE",
        "Playwright could not render the already-fetched HTML",
        { retryable: false, cause: error },
      );
    }
  }

  public async close(): Promise<void> {
    if (this.browserPromise !== undefined) {
      await (await this.browserPromise).close();
      this.browserPromise = undefined;
    }
  }

  private getBrowser(): Promise<Browser> {
    this.browserPromise ??= chromium.launch({ headless: true });
    return this.browserPromise;
  }
}

function injectBaseUrl(html: string, baseUrl: string): string {
  const base = `<base href="${escapeAttribute(baseUrl)}">`;
  return /<head(?:\s[^>]*)?>/iu.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/iu, (head) => `${head}${base}`)
    : `${base}${html}`;
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

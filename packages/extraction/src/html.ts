import * as cheerio from "cheerio";

import type { ExtractionMetadata } from "./types.js";

export interface ParsedContent {
  title?: string;
  canonicalUrl?: string;
  text: string;
  metadata: ExtractionMetadata;
  outboundLinks: string[];
  accessRestricted: boolean;
}

const removableSelectors = [
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "nav",
  "header",
  "footer",
  "aside",
  "form",
  "dialog",
  "[hidden]",
  '[aria-hidden="true"]',
  '[class*="cookie"]',
  '[id*="cookie"]',
  '[class*="consent"]',
  '[id*="consent"]',
  '[class*="banner"]',
  '[class*="advert"]',
  '[class*="sidebar"]',
];

const restrictedPattern =
  /\b(captcha|verify you are human|access denied|sign in to continue|subscribe to continue|disable your ad blocker)\b/i;

export function parseHtml(html: string, finalUrl: string): ParsedContent {
  const $ = cheerio.load(html);
  const accessRestricted = restrictedPattern.test($("body").text());
  const title = firstNonEmpty([
    attribute($, 'meta[property="og:title"]', "content"),
    normalizeWhitespace($("title").first().text()),
    normalizeWhitespace($("h1").first().text()),
  ]);
  const canonicalUrl = resolvePublicLink(
    attribute($, 'link[rel="canonical"]', "href"),
    finalUrl,
  );
  const metadata = collectMetadata($);

  $(removableSelectors.join(",")).remove();
  const root = selectContentRoot($);
  const outboundLinks = collectLinks($, root, finalUrl);
  const text = normalizeReadableText(root.text());

  return {
    ...(title === undefined ? {} : { title }),
    ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
    text,
    metadata,
    outboundLinks,
    accessRestricted,
  };
}

export function normalizeReadableText(value: string): string {
  const lines = value
    .replaceAll("\u00a0", " ")
    .split(/\n+/u)
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter((line) => line.length > 0);
  const seen = new Set<string>();
  return lines
    .filter((line) => {
      const key = line.toLocaleLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    })
    .join("\n");
}

export function isMeaningfulContent(text: string, minimumChars: number): boolean {
  return text.replace(/\s/gu, "").length >= minimumChars;
}

function selectContentRoot(
  $: cheerio.CheerioAPI,
): cheerio.Cheerio<cheerio.AnyNode> {
  const candidates = $("main, article, [role='main']").toArray();
  if (candidates.length === 0) {
    return $("body").first();
  }
  const largest = candidates.reduce((best, candidate) =>
    $(candidate).text().length > $(best).text().length ? candidate : best,
  );
  return $(largest);
}

function collectMetadata($: cheerio.CheerioAPI): ExtractionMetadata {
  const entries: Array<[string, string | undefined]> = [
    ["description", attribute($, 'meta[name="description"]', "content")],
    ["keywords", attribute($, 'meta[name="keywords"]', "content")],
    ["author", attribute($, 'meta[name="author"]', "content")],
    ["ogType", attribute($, 'meta[property="og:type"]', "content")],
    ["ogImage", attribute($, 'meta[property="og:image"]', "content")],
    [
      "publishedAt",
      firstNonEmpty([
        attribute($, 'meta[property="article:published_time"]', "content"),
        attribute($, "time[datetime]", "datetime"),
      ]),
    ],
    ["language", normalizeWhitespace($("html").attr("lang") ?? "")],
  ];
  return Object.fromEntries(
    entries.filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

function collectLinks(
  $: cheerio.CheerioAPI,
  root: cheerio.Cheerio<cheerio.AnyNode>,
  baseUrl: string,
): string[] {
  const links = new Set<string>();
  root.find("a[href]").each((_index, element) => {
    const resolved = resolvePublicLink($(element).attr("href"), baseUrl);
    if (resolved !== undefined && links.size < 100) {
      links.add(resolved);
    }
  });
  return [...links];
}

function resolvePublicLink(
  value: string | undefined,
  baseUrl: string,
): string | undefined {
  if (value === undefined || value.trim() === "") {
    return undefined;
  }
  try {
    const url = new URL(value, baseUrl);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

function attribute(
  $: cheerio.CheerioAPI,
  selector: string,
  name: string,
): string | undefined {
  return normalizeWhitespace($(selector).first().attr(name) ?? "");
}

function normalizeWhitespace(value: string): string | undefined {
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized === "" ? undefined : normalized;
}

function firstNonEmpty(
  values: ReadonlyArray<string | undefined>,
): string | undefined {
  return values.find((value) => value !== undefined && value !== "");
}

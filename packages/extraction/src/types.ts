export type FetchMode = "HTTP" | "PLAYWRIGHT";

export interface ExtractionMetadata {
  [key: string]: string | string[];
}

export interface ExtractionResult {
  requestedUrl: string;
  finalUrl: string;
  canonicalUrl?: string;
  title?: string;
  text: string;
  metadata: ExtractionMetadata;
  outboundLinks: string[];
  contentHash: string;
  httpStatus: number;
  fetchMode: FetchMode;
  fetchDurationMs: number;
}

export interface ExtractionConfiguration {
  userAgent: string;
  maxBodyBytes: number;
  maxRedirects: number;
  connectionTimeoutMs: number;
  totalTimeoutMs: number;
  globalConcurrency: number;
  domainConcurrency: number;
  domainDelayMs: number;
  minimumContentCharacters: number;
  playwrightEnabled: boolean;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export interface DnsResolver {
  resolve(hostname: string): Promise<ResolvedAddress[]>;
}

export interface HtmlRenderer {
  render(html: string, sourceUrl: string, signal: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

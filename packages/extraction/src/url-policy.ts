import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

import ipaddr from "ipaddr.js";

import { ExtractionError } from "./errors.js";
import type { DnsResolver, ResolvedAddress } from "./types.js";

const blockedMetadataHostnames = new Set([
  "metadata.google.internal",
  "metadata.aws.internal",
  "instance-data.ec2.internal",
]);

export class SystemDnsResolver implements DnsResolver {
  public async resolve(hostname: string): Promise<ResolvedAddress[]> {
    try {
      const results = await lookup(hostname, { all: true, verbatim: true });
      return results.map((result) => ({
        address: result.address,
        family: result.family === 6 ? 6 : 4,
      }));
    } catch (error: unknown) {
      throw new ExtractionError(
        "DNS_RESOLUTION_FAILED",
        `DNS resolution failed for ${hostname}`,
        { retryable: true, cause: error },
      );
    }
  }
}

export function normalizeSourceUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch (error: unknown) {
    throw new ExtractionError("INVALID_URL", "Source URL is invalid", {
      retryable: false,
      fetchStatus: "BLOCKED",
      cause: error,
    });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ExtractionError(
      "UNSUPPORTED_SCHEME",
      "Only HTTP and HTTPS source URLs are supported",
      { retryable: false, fetchStatus: "BLOCKED" },
    );
  }
  if (url.username !== "" || url.password !== "") {
    throw new ExtractionError(
      "URL_CREDENTIALS_NOT_ALLOWED",
      "Source URLs must not contain credentials",
      { retryable: false, fetchStatus: "BLOCKED" },
    );
  }
  if (url.toString().length > 2_048) {
    throw new ExtractionError("INVALID_URL", "Source URL is too long", {
      retryable: false,
      fetchStatus: "BLOCKED",
    });
  }

  const hostname = normalizeHostname(url.hostname);
  assertHostnameAllowed(hostname);
  url.hostname = hostname;
  url.hash = "";
  url.searchParams.sort();
  return url.toString();
}

export async function resolvePublicAddresses(
  normalizedUrl: string,
  resolver: DnsResolver,
): Promise<ResolvedAddress[]> {
  const hostname = normalizeHostname(new URL(normalizedUrl).hostname);
  assertHostnameAllowed(hostname);
  const addresses = await resolver.resolve(hostname);
  if (addresses.length === 0) {
    throw new ExtractionError(
      "DNS_RESOLUTION_FAILED",
      `DNS returned no addresses for ${hostname}`,
      { retryable: true },
    );
  }

  for (const address of addresses) {
    assertPublicAddress(address.address);
  }
  return addresses;
}

export function assertPublicAddress(address: string): void {
  if (isIP(address) === 0 || !ipaddr.isValid(address)) {
    throw new ExtractionError(
      "DNS_RESOLUTION_FAILED",
      `DNS returned an invalid address for the source host`,
      { retryable: true },
    );
  }

  let parsed = ipaddr.parse(address);
  if (parsed.kind() === "ipv6") {
    const ipv6 = parsed as ipaddr.IPv6;
    if (ipv6.isIPv4MappedAddress()) {
      parsed = ipv6.toIPv4Address();
    }
  }
  if (parsed.range() !== "unicast") {
    throw new ExtractionError(
      "PRIVATE_ADDRESS_BLOCKED",
      "Source URL resolves to a non-public network address",
      { retryable: false, fetchStatus: "BLOCKED" },
    );
  }
}

function assertHostnameAllowed(hostname: string): void {
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    blockedMetadataHostnames.has(hostname)
  ) {
    throw new ExtractionError(
      "PRIVATE_ADDRESS_BLOCKED",
      "Source hostname is not publicly routable",
      { retryable: false, fetchStatus: "BLOCKED" },
    );
  }
  if (isIP(hostname) !== 0) {
    assertPublicAddress(hostname);
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/gu, "");
}

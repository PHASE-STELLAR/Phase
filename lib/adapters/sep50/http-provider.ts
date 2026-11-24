import {
  Sep50ProviderUnavailableError,
  type Sep50Attestation,
  type Sep50IssuerDiscovery,
  type Sep50Provider,
} from "./types";

export class HttpSep50Provider implements Sep50Provider {
  constructor(
    private readonly discoveryUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async discover(homeDomain: string): Promise<Sep50IssuerDiscovery> {
    let response: Response;
    try {
      const url = new URL(this.discoveryUrl);
      url.searchParams.set("domain", homeDomain);
      response = await this.fetchImpl(url.toString(), {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Sep50ProviderUnavailableError("SEP-50 discovery request failed");
    }
    if (!response.ok) {
      throw new Sep50ProviderUnavailableError(
        `SEP-50 discovery returned ${response.status}`,
        response.status === 429 ? 60 : 30,
      );
    }
    try {
      const body = (await response.json()) as Sep50IssuerDiscovery;
      if (
        typeof body.homeDomain !== "string" ||
        typeof body.issuerAccount !== "string" ||
        typeof body.attestationUrl !== "string" ||
        (body.network !== "testnet" && body.network !== "pubnet")
      ) {
        throw new Error("malformed discovery document");
      }
      return body;
    } catch {
      throw new Sep50ProviderUnavailableError("SEP-50 discovery document malformed");
    }
  }

  async fetchAttestation(url: string, sep10Token: string): Promise<Sep50Attestation> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: {
          accept: "application/json",
          authorization: `Bearer ${sep10Token}`,
        },
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      throw new Sep50ProviderUnavailableError("SEP-50 attestation request failed");
    }
    if (!response.ok) {
      throw new Sep50ProviderUnavailableError(
        `SEP-50 attestation returned ${response.status}`,
        response.status === 429 ? 60 : 30,
      );
    }
    try {
      const body = (await response.json()) as Sep50Attestation;
      if (
        body.version !== 1 ||
        typeof body.subjectHash !== "string" ||
        typeof body.signature !== "string" ||
        typeof body.issuedAt !== "number" ||
        typeof body.expiresAt !== "number" ||
        typeof body.issuerAccount !== "string"
      ) {
        throw new Error("malformed attestation");
      }
      return body;
    } catch {
      throw new Sep50ProviderUnavailableError("SEP-50 attestation malformed");
    }
  }
}

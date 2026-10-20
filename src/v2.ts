import type {
  PaymentPayload,
  PaymentPayloadV2,
  PaymentRequirements,
  PaymentRequirementsV2,
} from "./types";
import { addressesEqual } from "./verify";

/**
 * x402 V2 protocol wiring, anchored to the x402-foundation V2 specification.
 * No signing, balances, transactions or facilitator network calls happen here.
 */
const V2_EVM_NETWORKS: Readonly<Record<string, string>> = Object.freeze({
  base: "eip155:8453",
  "eip155:8453": "eip155:8453",
  arbitrum: "eip155:42161",
  "eip155:42161": "eip155:42161",
});

export function caip2Network(network: string): string {
  const mapped = V2_EVM_NETWORKS[network];
  if (!mapped) {
    throw new Error("x402 V2 EVM network not configured: " + network);
  }
  return mapped;
}

/**
 * Preserve EXISTING V1 claim-store keys on upgrade. A payment consumed on the
 * old deployed V1 worker was stored under "base", not "eip155:8453". Mapping
 * BOTH versions to CAIP-2 would accidentally reopen those old authorizations
 * after a production rolling upgrade. V2 maps *back* to the legacy namespace.
 */
export function claimNetwork(network: string): string {
  if (network === "eip155:8453") return "base";
  if (network === "eip155:42161") return "arbitrum";
  return network;
}

/**
 * Claim BOTH historical network spellings on the same EIP-3009 chain.
 * Prior V1 configurations could name either plain "base"/"arbitrum" or the
 * CAIP-2 identifier; omitting one reopens an old spent authorization.
 * Unknown networks and Solana retain their original single scope.
 */
export function claimNetworks(network: string): string[] {
  const canonical = claimNetwork(network);
  if (canonical === "base") return ["base", "eip155:8453"];
  if (canonical === "arbitrum") return ["arbitrum", "eip155:42161"];
  return [canonical];
}

export function v2Requirements(legacy: PaymentRequirements): PaymentRequirementsV2 {
  const network = caip2Network(String(legacy.network));
  return {
    scheme: legacy.scheme,
    network,
    amount: legacy.maxAmountRequired,
    asset: legacy.asset,
    payTo: legacy.payTo,
    maxTimeoutSeconds: legacy.maxTimeoutSeconds,
    ...(legacy.extra ? { extra: legacy.extra } : {}),
  };
}

export interface V2Resource {
  url: string;
  description: string;
  mimeType: string;
}

export function v2Resource(legacy: PaymentRequirements): V2Resource {
  // A V2 PaymentRequired resource URL identifies the specific merchant route.
  // Express exposes req.originalUrl as a RELATIVE path; guessing its origin
  // from an attacker-controlled Host header creates a confused-deputy hazard.
  // Demand a configured absolute canonical URL instead.
  let url: URL;
  try { url = new URL(legacy.resource); }
  catch { throw new Error("V2 resource requires an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("V2 resource must be an HTTP(S) URL without credentials or fragment");
  }
  return {
    url: legacy.resource,
    description: legacy.description,
    mimeType: legacy.mimeType,
  };
}

export type V2Check =
  | { ok: true; normalized: PaymentPayload; quote: unknown }
  | { ok: false; reason: string };

/**
 * Validate the selected V2 offer *before* authorization checks and BEFORE
 * forwarding anything to the facilitator. The EIP-3009 signature itself binds
 * amount, receiver and nonce; an arbitrary accepted envelope isn't trusted.
 */
export function validateV2(input: unknown, legacy: PaymentRequirements): V2Check {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, reason: "missing_payment_payload" };
  }
  const value = input as Partial<PaymentPayloadV2>;
  if (value.x402Version !== 2) return { ok: false, reason: "version_mismatch" };
  if (!value.accepted || typeof value.accepted !== "object" || Array.isArray(value.accepted)) {
    return { ok: false, reason: "missing_accepted" };
  }
  const expected = v2Requirements(legacy);
  const accepted = value.accepted;
  if (accepted.scheme !== expected.scheme ||
      accepted.network !== expected.network ||
      accepted.amount !== expected.amount ||
      !addressesEqual(accepted.asset, expected.asset) ||
      !addressesEqual(accepted.payTo, expected.payTo) ||
      accepted.maxTimeoutSeconds !== expected.maxTimeoutSeconds) {
    return { ok: false, reason: "accepted_terms_mismatch" };
  }
  if (value.resource !== undefined &&
      (!value.resource || typeof value.resource !== "object" ||
       value.resource.url !== legacy.resource)) {
    return { ok: false, reason: "resource_mismatch" };
  }
  const payload = value.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { ok: false, reason: "missing_authorization" };
  }
  const normalized: PaymentPayload = {
    x402Version: 1, // only for reuse of existing safe V1 local EIP-3009 checks
    scheme: expected.scheme,
    network: expected.network,
    payload,
  };
  return { ok: true, normalized, quote: accepted.extra?.quote };
}

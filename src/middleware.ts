import { DEFAULT_FACILITATOR, useFacilitator, type Facilitator } from "./facilitator";
import { verifyLocally } from "./verify";
import { issueQuote, verifyQuote } from "./binding";
import { MemoryClaimStore, canonicalNonce, claimKey, type PaymentClaimStore } from "./claims";
import { caip2Network, claimNetwork, v2Requirements, v2Resource, validateV2 } from "./v2";
import type {
  Network,
  AnyPaymentPayload,
  PaymentPayload,
  PaymentRequirements,
  PaymentRequirementsV2,
  SettlementEvidence,
  SettlementStrength,
} from "./types";

// Framework-agnostic payment gate + Next.js / Express adapters. Gate a route
// behind an x402 micropayment in a few lines; verification and on-chain
// settlement are delegated to a facilitator (Furlpay hosted by default).

const X402_VERSION = 1;

export interface PriceConfig {
  payTo: string;
  /**
   * Canonical absolute URL when mounting Express (which usually exposes a
   * relative req.originalUrl). Required for Express V2 offers; NEVER infer a
   * settlement resource from an untrusted HTTP Host header.
   */
  resourceUrl?: string;
  /**
   * Omitted: keep the V1 JSON challenge for old payers AND advertise a V2
   * PAYMENT-REQUIRED header when this network supports it. Both wire headers
   * can pay this route and share the same nonce claim store.
   *
   * Explicit 1 or 2 pins the route to one protocol for strict deployments.
   */
  x402Version?: 1 | 2;
  network?: Network;
  asset?: string;
  /** Price in atomic units of `asset` (USDC = 6 decimals). e.g. "10000" = $0.01. */
  amount: string;
  description?: string;
  facilitator?: string | Facilitator;
  maxTimeoutSeconds?: number;
  /**
   * Minimum settlement strength before the resource is released.
   *
   * Left unset, `gate()` behaves as it always has: the facilitator says
   * `success: true` and the resource ships. That is the right default only
   * because changing it would break every existing caller — it is NOT a safe
   * posture, and it is why this option exists.
   *
   * Set it and the gate refuses to release against a settlement the facilitator
   * has not claimed is strong enough. `"confirmed"` stops a release against a
   * transaction that is merely broadcast; `"finalized"` stops a release against
   * one a re-org could still undo, which is what the amount at risk should
   * decide. @furlpay/settlement maps an amount to that requirement.
   */
  requireSettlement?: SettlementStrength;
  /**
   * Skip the local field checks and let the facilitator decide alone.
   *
   * Exists as an escape hatch for a scheme whose payload this package cannot
   * interpret, not as a tuning knob — leaving it unset is the safe posture, and
   * setting it restores the behaviour where any facilitator weakness is a full
   * bypass. Named for what it does rather than something reassuring, so it is
   * hard to enable without noticing.
   */
  skipLocalVerification?: boolean;
  /**
   * Server-held secret that binds a payment to THIS resource.
   *
   * Set it and the 402 carries a signed quote the payer must echo back; the
   * gate then refuses any payment whose quote was issued for a different
   * resource, price or recipient. Without it there is no binding at all and two
   * routes at the same price on the same server accept each other's payments —
   * the `exact` scheme's authorization simply does not name a resource.
   *
   * Left unset the gate behaves as before, because turning binding on is a
   * protocol change for payers: they have to echo `extra.quote`. It is opt-in
   * for that reason, not because it is optional in any security sense.
   */
  bindingSecret?: string;
  /**
   * Single-use claim store, so one payment releases one resource.
   *
   * Defaults to a per-config in-memory store, which is correct in ONE process
   * and useless across a fleet — behind a load balancer each instance keeps its
   * own set and a payment replays once per instance. Inject a shared store for
   * anything running more than one copy.
   */
  claimStore?: PaymentClaimStore;
  /** Set false to disable claiming entirely. Replay then rests on the facilitator. */
  singleUse?: boolean;
}

/**
 * Default claim stores, one per distinct config object.
 *
 * Keyed by the config so two routes cannot collide in one another's claim
 * space, and weak so a config that goes out of scope does not pin its store.
 */
const DEFAULT_CLAIM_STORES = new WeakMap<PriceConfig, PaymentClaimStore>();

function resolveClaimStore(cfg: PriceConfig): PaymentClaimStore {
  if (cfg.claimStore) return cfg.claimStore;
  let store = DEFAULT_CLAIM_STORES.get(cfg);
  if (!store) {
    store = new MemoryClaimStore();
    DEFAULT_CLAIM_STORES.set(cfg, store);
  }
  return store;
}

/**
 * Headers that keep a paid response out of a shared cache.
 *
 * A gated route behind a CDN or reverse proxy will otherwise have its PAID
 * response cached and replayed to later UNPAID clients — one payment, unlimited
 * grants, and nothing in the payment layer involved. `private` bars shared
 * caches; `no-store` bars writing it down at all; `Vary: X-PAYMENT` stops a
 * cache that ignores the first two from keying paid and unpaid requests to one
 * entry.
 *
 * Applied to the 402 as well as the 200. A cached challenge is a cached quote,
 * and every payer served it would be answering the same one.
 */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store, private",
  Vary: "X-PAYMENT, PAYMENT-SIGNATURE",
});

const USDC: Readonly<Record<string, string>> = Object.freeze({
  base: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  "eip155:8453": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  "eip155:42161": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  solana: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
});

export function buildRequirements(resource: string, cfg: PriceConfig): PaymentRequirements {
  const network = cfg.network ?? "base";
  const asset = cfg.asset ?? USDC[network];
  // Falling back to BASE USDC on Arbitrum or an unknown chain would advertise
  // the wrong payment token. A seller needs an explicit asset on unknown chains.
  if (!asset) throw new Error("asset must be configured for network " + network);
  return {
    scheme: "exact",
    network,
    maxAmountRequired: cfg.amount,
    resource,
    description: cfg.description ?? "x402 payment",
    mimeType: "application/json",
    payTo: cfg.payTo,
    maxTimeoutSeconds: cfg.maxTimeoutSeconds ?? 300,
    asset,
  };
}

function resolveFacilitator(f: PriceConfig["facilitator"]): Facilitator {
  if (!f) return useFacilitator(DEFAULT_FACILITATOR);
  return typeof f === "string" ? useFacilitator(f) : f;
}

/** Ascending strength. Compared, never assumed. */
const STRENGTH_RANK: Record<SettlementStrength, number> = {
  unknown: 0,
  submitted: 1,
  confirmed: 2,
  finalized: 3,
};

/**
 * Does the evidence clear the bar?
 *
 * Absent evidence is `unknown`, which clears only an `unknown` requirement.
 * Nothing here infers strength from `success` — that inference is precisely the
 * bug this gate exists to prevent.
 */
function meetsStrength(
  evidence: SettlementEvidence | undefined,
  required: SettlementStrength
): boolean {
  const observed: SettlementStrength = evidence?.strength ?? "unknown";
  return STRENGTH_RANK[observed] >= STRENGTH_RANK[required];
}

/**
 * How long past `validBefore` a claim is held. Covers clock skew between this
 * server and the chain, so a claim never lapses while the token contract would
 * still accept the authorization.
 */
const CLAIM_EXPIRY_MARGIN_MS = 10 * 60_000;

type PaymentIdentity = { ok: true; nonce: string; holdUntilMs: number } | { ok: false; detail: string };

/**
 * The replay identity of a payment and how long it must stay claimed.
 *
 * Runs whenever single use is on, including with `skipLocalVerification`: a
 * claim needs a real nonce and a real expiry whatever else is skipped. A
 * payment without `validBefore` is refused because a claim with no end date
 * would have to lapse on the store's TTL while the authorization lived on.
 */
function paymentIdentity(network: string, payload: PaymentPayload): PaymentIdentity {
  const auth = payload?.payload?.authorization;
  const nonce = canonicalNonce(network, auth?.nonce);
  if (!nonce.ok) return nonce;
  const validBefore = Number(auth?.validBefore);
  if (!Number.isSafeInteger(validBefore) || validBefore <= 0) {
    return { ok: false, detail: "authorization.validBefore is missing or not a unix time" };
  }
  return { ok: true, nonce: nonce.nonce, holdUntilMs: validBefore * 1000 + CLAIM_EXPIRY_MARGIN_MS };
}

export type GateResult =
  | {
      paid: false;
      status: 402;
      body: {
        x402Version: number;
        error: string;
        accepts: Array<PaymentRequirements | PaymentRequirementsV2>;
        resource?: ReturnType<typeof v2Resource>;
        extensions?: Record<string, unknown>;
      };
    }
  | { paid: false; status: 400; body: { error: string } }
  | { paid: true; payer: string; transaction: string; settlementHeader: string; settlement?: SettlementEvidence };

/**
 * Framework-neutral gate. Default V1 remains unchanged.
 * Opt-in V2 uses the standard accepted+payload object and CAIP-2 wire shape.
 * The configured facilitator handles actual cryptographic verification and
 * settlement. A local check is NOT proof of a real signature or transaction.
 */
export async function gate(
  resource: string,
  paymentHeader: string | null,
  cfg: PriceConfig
): Promise<GateResult> {
  // A direct gate() caller has no HTTP header name to inspect. With no
  // configured version, infer V2 only from an actual V2 payment payload;
  // the existing no-payment/default challenge remains V1. Framework wrappers
  // pin their mode from the header name and never trust this inference.
  let inferredVersion: 1 | 2 = 1;
  if (cfg.x402Version === undefined && paymentHeader && paymentHeader.length <= 16384) {
    try {
      const preflight = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
      if (preflight?.x402Version === 2) inferredVersion = 2;
    } catch (_) {}
  }
  const version = cfg.x402Version ?? inferredVersion;
  if (version !== 1 && version !== 2) {
    throw new Error("Unsupported x402 protocol version");
  }
  const original = buildRequirements(resource, cfg);
  const requirements = version === 2
    ? { ...original, network: caip2Network(String(original.network)) }
    : original;
  // Enforce canonical merchant resource URL EVEN if a caller presents a
  // pre-signed V2 payload directly without first requesting a 402 challenge.
  if (version === 2) v2Resource(requirements);

  function challenge(error: string, issueFreshQuote = false): GateResult {
    const accepted = issueFreshQuote && cfg.bindingSecret
      ? {
          ...requirements,
          extra: {
            ...requirements.extra,
            quote: issueQuote(requirements, cfg.bindingSecret, requirements.maxTimeoutSeconds),
          },
        }
      : requirements;
    if (version === 2) {
      return {
        paid: false,
        status: 402,
        body: {
          x402Version: 2,
          error,
          resource: v2Resource(requirements),
          accepts: [v2Requirements(accepted)],
          extensions: {},
        },
      };
    }
    return {
      paid: false,
      status: 402,
      body: { x402Version: 1, error, accepts: [accepted] },
    };
  }

  if (!paymentHeader) {
    return challenge(version === 2 ? "PAYMENT-SIGNATURE required" : "X-PAYMENT required", true);
  }
  if (paymentHeader.length > 16384) {
    return { paid: false, status: 400, body: { error: "payment header exceeds 16KiB" } };
  }

  let payload: AnyPaymentPayload;
  try {
    payload = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  } catch {
    return {
      paid: false,
      status: 400,
      body: { error: version === 2 ? "PAYMENT-SIGNATURE is not valid base64 JSON" : "X-PAYMENT is not valid base64 JSON" },
    };
  }

  let checkedPayload: PaymentPayload;
  let echoedQuote: unknown;
  if (version === 2) {
    // Validate the V2 accepted envelope BEFORE any facilitator receives funds.
    // This also refuses mismatched versions on the same route.
    const v2 = validateV2(payload, requirements);
    if (!v2.ok) return challenge(v2.reason);
    checkedPayload = v2.normalized; // reuse V1 EIP-3009 auth checks without trusting new fields
    echoedQuote = v2.quote;
  } else {
    checkedPayload = payload as PaymentPayload;
    echoedQuote = checkedPayload?.extra?.quote;
  }

  if (!cfg.skipLocalVerification) {
    const local = verifyLocally(checkedPayload, requirements);
    if (!local.ok) {
      return challenge((local.reason ?? "invalid_payment") + ": " + (local.detail ?? ""));
    }
  }

  if (cfg.bindingSecret) {
    const quote = verifyQuote(echoedQuote, requirements, cfg.bindingSecret);
    if (!quote.ok) {
      return challenge((quote.reason ?? "invalid_quote") + ": " + (quote.detail ?? ""));
    }
  }

  // IMPORTANT: V2 CAIP-2 network ids map to the existing deployed V1
  // claim-store namespace, so a rolling upgrade cannot reclaim an earlier
  // on-chain EIP-3009 authorization under a different key.
  const singleUse = cfg.singleUse !== false;
  const store = singleUse ? resolveClaimStore(cfg) : null;
  let key = "";
  if (store) {
    const identity = paymentIdentity(String(requirements.network), checkedPayload);
    if (!identity.ok) return challenge("malformed_payload: " + identity.detail);
    key = claimKey(claimNetwork(String(requirements.network)), identity.nonce);
    const won = await store.claim(key, identity.holdUntilMs);
    if (!won) {
      return challenge("payment_already_used: this authorization has already released the resource");
    }
  }

  const facilitator = resolveFacilitator(cfg.facilitator);
  let settlement: Awaited<ReturnType<Facilitator["settle"]>>;
  try {
    settlement = await facilitator.settle(
      payload,
      version === 2 ? v2Requirements(requirements) : requirements
    );
  } catch (err) {
    // UNKNOWN, not a definite failure. Keep nonce claimed so that an
    // indeterminate settlement cannot release goods twice.
    return challenge("settlement_unknown: " + (err instanceof Error ? err.name : "Error"));
  }

  if (!settlement.success) {
    if (store) await store.release(key);
    return challenge(settlement.errorReason ?? "payment_failed");
  }
  if (cfg.requireSettlement && !meetsStrength(settlement.settlement, cfg.requireSettlement)) {
    // Only a paid response that passed the configured finality gate grants
    // the resource; this 402 refuses access without pretending it's settled.
    if (store) await store.release(key);
    return challenge("settlement_strength_insufficient: required " +
      cfg.requireSettlement + ", observed " + (settlement.settlement?.strength ?? "unknown"));
  }

  return {
    paid: true,
    payer: settlement.payer ?? "",
    transaction: settlement.transaction ?? "",
    settlementHeader: Buffer.from(JSON.stringify(settlement)).toString("base64"),
    settlement: settlement.settlement,
  };
}

/**
 * Next.js App Router wrapper. Gates a Route Handler behind an x402 payment.
 *
 * @example
 *   export const GET = withX402(
 *     async () => Response.json({ data: "premium" }),
 *     { payTo: "0x...", network: "base", amount: "10000", description: "Premium data" },
 *   );
 */
/**
 * Default V1 routes also emit an optional V2 challenge header.
 * Never advertise a V2 network we cannot map (e.g. Solana without EVM).
 */
async function v2HeaderFor(
  resource: string,
  cfg: PriceConfig,
  result: GateResult
): Promise<string | undefined> {
  if (result.paid || result.status !== 402 || cfg.x402Version === 1) return undefined;
  if (cfg.x402Version === 2) {
    return Buffer.from(JSON.stringify(result.body)).toString("base64");
  }
  try {
    const v2 = await gate(resource, null, { ...cfg, x402Version: 2 });
    if (!v2.paid && v2.status === 402) {
      return Buffer.from(JSON.stringify(v2.body)).toString("base64");
    }
  } catch (_) {
    // Existing V1 unsupported-by-V2 networks keep their old V1 challenge.
  }
  return undefined;
}

export function withX402(
  handler: (req: Request) => Promise<Response> | Response,
  cfg: PriceConfig
): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const legacy = req.headers.get("x-payment");
    const modern = req.headers.get("payment-signature");
    const mode = cfg.x402Version ?? (modern ? 2 : 1);
    if ((legacy && modern) || (cfg.x402Version === 2 && legacy) ||
        (cfg.x402Version === 1 && modern)) {
      return Response.json({ error: "conflicting_or_wrong_payment_header" }, {
        status: 400, headers: NO_STORE_HEADERS,
      });
    }
    // Reuse ONE original config claim store across both version modes.
    const effective: PriceConfig = cfg.x402Version === undefined
      ? { ...cfg, x402Version: mode, claimStore: resolveClaimStore(cfg) }
      : cfg;
    const result = await gate(req.url, mode === 2 ? modern : legacy, effective);
    if (!result.paid) {
      const headers: Record<string, string> = { ...NO_STORE_HEADERS };
      const modernChallenge = await v2HeaderFor(req.url, cfg, result);
      if (modernChallenge && result.status === 402) {
        headers["PAYMENT-REQUIRED"] = modernChallenge;
      }
      return Response.json(result.body, { status: result.status, headers });
    }
    const res = await handler(req);
    res.headers.set(mode === 2 ? "PAYMENT-RESPONSE" : "X-PAYMENT-RESPONSE", result.settlementHeader);
    for (const [k, v] of Object.entries(NO_STORE_HEADERS)) res.headers.set(k, v);
    return res;
  };
}

// Minimal Express-style types so we don't depend on @types/express.
interface ReqLike { originalUrl?: string; url: string; headers: Record<string, string | string[] | undefined>; }
interface ResLike { status(code: number): ResLike; json(body: unknown): void; setHeader(k: string, v: string): void; }

/**
 * Express/Connect middleware. Gates the mounted route behind an x402 payment.
 *
 * @example
 *   app.get("/premium", expressX402({ payTo: "0x...", amount: "10000" }), handler);
 */
export function expressX402(cfg: PriceConfig) {
  return async (req: ReqLike, res: ResLike, next: () => void) => {
    const legacy = req.headers["x-payment"];
    const modern = req.headers["payment-signature"];
    const mode = cfg.x402Version ?? (modern ? 2 : 1);
    for (const [k, v] of Object.entries(NO_STORE_HEADERS)) res.setHeader(k, v);
    const malformed = (Array.isArray(legacy) && legacy.length !== 1) ||
      (Array.isArray(modern) && modern.length !== 1);
    if (malformed || (legacy && modern) || (cfg.x402Version === 2 && legacy) ||
        (cfg.x402Version === 1 && modern)) {
      res.status(400).json({ error: "conflicting_or_wrong_payment_header" });
      return;
    }
    const effective: PriceConfig = cfg.x402Version === undefined
      ? { ...cfg, x402Version: mode, claimStore: resolveClaimStore(cfg) }
      : cfg;
    const header = mode === 2 ? modern : legacy;
    const payment = Array.isArray(header) ? header[0] : header ?? null;
    const resource = cfg.resourceUrl ?? req.originalUrl ?? req.url;
    const result = await gate(resource, payment, effective);
    if (!result.paid) {
      const modernChallenge = await v2HeaderFor(resource, cfg, result);
      if (modernChallenge && result.status === 402) {
        res.setHeader("PAYMENT-REQUIRED", modernChallenge);
      }
      res.status(result.status).json(result.body);
      return;
    }
    res.setHeader(mode === 2 ? "PAYMENT-RESPONSE" : "X-PAYMENT-RESPONSE", result.settlementHeader);
    next();
  };
}

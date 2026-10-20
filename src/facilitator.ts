import type {
  PaymentPayload,
  PaymentRequirements,
  AnyPaymentPayload,
  AnyPaymentRequirements,
  SettleResponse,
  SettlementEvidence,
  SettlementStrength,
  SupportedKind,
  VerifyResponse,
} from "./types";

// The hosted Furlpay facilitator. Point at your own deployment to self-host.
//
// WHAT IT CAN SETTLE, precisely, because this used to overclaim. The hosted
// facilitator verifies EIP-3009 authorizations by EIP-712 ecrecover (plus
// ERC-1271 for contract wallets) and settles them on EVM networks — Arbitrum
// and Base today. It does NOT verify Solana: SVM uses a different signature
// scheme, and the verifier returns `svm_verification_unavailable` rather than
// accepting something it has not checked.
//
// The MIDDLEWARE in this package is a separate matter and is chain-agnostic:
// buildRequirements() will happily emit a Solana 402 with the right USDC mint.
// Emitting a requirement and settling a payment are different capabilities, and
// conflating them is what the old comment here did.
export const DEFAULT_FACILITATOR = "https://furlpay.com/api/x402/facilitator";

export interface Facilitator {
  supported(): Promise<{ kinds: SupportedKind[] }>;
  verify(paymentPayload: AnyPaymentPayload, paymentRequirements: AnyPaymentRequirements): Promise<VerifyResponse>;
  settle(paymentPayload: AnyPaymentPayload, paymentRequirements: AnyPaymentRequirements): Promise<SettleResponse>;
}

/**
 * Client for an x402 facilitator's verify/settle/supported API.
 *
 * @example
 *   const facilitator = useFacilitator();               // Furlpay hosted
 *   const facilitator = useFacilitator("http://localhost:3000/api/x402/facilitator");
 */
export function useFacilitator(
  baseUrl: string = DEFAULT_FACILITATOR,
  fetchImpl: typeof fetch = fetch,
  /** How long to wait for the facilitator before giving up. */
  timeoutMs = 30_000
): Facilitator {
  const base = baseUrl.replace(/\/$/, "");

  /**
   * One request, with the transport answer and the application answer kept apart.
   *
   * THE BUG THIS REPLACES: the previous implementation was
   * `return (await res.json()) as T` — the HTTP status was never read. A 500
   * whose body happened to be `{"success": true}` was therefore accepted as a
   * settlement, and so was a 402, a 403, or an error page from a proxy that
   * happened to serialise as JSON. `as T` performed no validation either, so
   * `gate()` went on to dereference `settlement.payer!` on whatever came back.
   *
   * Two rules now, and they do not blend:
   *
   *   1. A non-2xx response is a failed request, whatever the body claims. An
   *      application-level `success` cannot promote a transport failure.
   *   2. A body that is not a JSON object is not an answer. Empty bodies,
   *      HTML error pages and arrays are refused rather than cast.
   *
   * Errors are returned as data rather than thrown, because the previous
   * behaviour threw out of `settle()`, escaped `gate()` and surfaced as an
   * unhandled rejection instead of a 402.
   */
  async function post<T extends Record<string, unknown>>(
    path: string,
    body: unknown
  ): Promise<{ ok: true; data: T } | { ok: false; reason: string }> {
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        // A facilitator that never answers must not hold the route open.
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      // Network failure, DNS, abort. Indeterminate — never a success.
      return { ok: false, reason: `facilitator_unreachable: ${errorName(e)}` };
    }

    if (!res.ok) {
      // Read before deciding, so the reason can carry the status, but the
      // status alone has already decided the outcome.
      return { ok: false, reason: `facilitator_http_${res.status}` };
    }

    let parsed: unknown;
    try {
      parsed = await res.json();
    } catch {
      return { ok: false, reason: "facilitator_response_not_json" };
    }

    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, reason: "facilitator_response_not_an_object" };
    }

    return { ok: true, data: parsed as T };
  }

  /** An error's name without its message, so nothing sensitive reaches a caller. */
  function errorName(e: unknown): string {
    if (e && typeof e === "object" && "name" in e && typeof e.name === "string") return e.name;
    return "Error";
  }

  return {
    async supported() {
      try {
        const res = await fetchImpl(`${base}/supported`, {
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return { kinds: [] };
        const parsed = (await res.json()) as { kinds?: SupportedKind[] };
        return { kinds: Array.isArray(parsed?.kinds) ? parsed.kinds : [] };
      } catch {
        // A discovery call that fails is an empty capability set, not a throw.
        return { kinds: [] };
      }
    },

    async verify(paymentPayload, paymentRequirements) {
      const res = await post<Record<string, unknown>>("/verify", {
        x402Version: paymentPayload.x402Version,
        paymentPayload,
        paymentRequirements,
      });
      if (!res.ok) return { isValid: false, invalidReason: res.reason };
      // `isValid` must be the boolean true, not merely truthy: a facilitator
      // returning the string "false" would otherwise verify.
      const isValid = res.data.isValid === true;
      return {
        isValid,
        payer: typeof res.data.payer === "string" ? res.data.payer : undefined,
        invalidReason: isValid
          ? undefined
          : typeof res.data.invalidReason === "string"
            ? res.data.invalidReason
            : "verification_failed",
      };
    },

    async settle(paymentPayload, paymentRequirements) {
      const network = paymentRequirements.network;
      const res = await post<Record<string, unknown>>("/settle", {
        x402Version: paymentPayload.x402Version,
        paymentPayload,
        paymentRequirements,
      });
      if (!res.ok) return { success: false, network, errorReason: res.reason };

      const data = res.data;
      // Structural validation before the answer is believed. A settlement that
      // claims success without naming a transaction has not evidenced anything,
      // and `gate()` used to assert `transaction!` on exactly that shape.
      if (data.success !== true) {
        return {
          success: false,
          network: typeof data.network === "string" ? data.network : network,
          errorReason:
            typeof data.errorReason === "string" ? data.errorReason : "settlement_failed",
        };
      }
      if (typeof data.transaction !== "string" || data.transaction.length === 0) {
        return { success: false, network, errorReason: "settlement_missing_transaction" };
      }

      return {
        success: true,
        transaction: data.transaction,
        network: typeof data.network === "string" ? data.network : network,
        payer: typeof data.payer === "string" ? data.payer : undefined,
        settlement: parseEvidence(data.settlement),
      };
    },
  };
}

/**
 * Read settlement evidence, refusing to invent any.
 *
 * An unrecognised or absent strength becomes `unknown` rather than being
 * guessed from `success`. That is the whole point of the field: `success` says
 * a transaction exists, and strength says how much that is worth.
 */
function parseEvidence(raw: unknown): SettlementEvidence | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const e = raw as Record<string, unknown>;
  const strength: SettlementStrength =
    e.strength === "submitted" || e.strength === "confirmed" || e.strength === "finalized"
      ? e.strength
      : "unknown";
  const confirmations =
    e.confirmations === null
      ? null
      : typeof e.confirmations === "number" && Number.isFinite(e.confirmations)
        ? e.confirmations
        : undefined;
  return {
    strength,
    ...(confirmations !== undefined ? { confirmations } : {}),
    ...(typeof e.slot === "number" && Number.isFinite(e.slot) ? { slot: e.slot } : {}),
    ...(typeof e.observedAt === "string" ? { observedAt: e.observedAt } : {}),
  };
}

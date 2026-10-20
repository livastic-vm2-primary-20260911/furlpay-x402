"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {
  buildRequirements,
  gate,
  withX402,
  expressX402,
  verifyLocally,
  addressesEqual,
} = require("../dist/index.js");

// ---------------------------------------------------------------------------
// Attack II (#6) — gate() no longer delegates the whole decision, and
// Attack III (#4) — paid responses are no longer cacheable.
//
// The facilitator in these tests is a STUB THAT ALWAYS SAYS YES. That is the
// point: every refusal below happens with a facilitator actively approving the
// payment, which is what "defense in depth" has to mean. A test using an honest
// facilitator would pass whether or not the local checks existed.
// ---------------------------------------------------------------------------

const PAY_TO = "0x1111111111111111111111111111111111111111";
const CFG = { payTo: PAY_TO, amount: "10000" };

/** Approves anything, and records what it was asked to settle. */
function yesFacilitator() {
  const calls = [];
  return {
    calls,
    async supported() {
      return { kinds: [] };
    },
    async verify() {
      return { isValid: true };
    },
    async settle(payload, requirements) {
      calls.push({ payload, requirements });
      return { success: true, transaction: "0xtx", network: "base", payer: "0xpayer" };
    },
  };
}

const now = () => Math.floor(Date.now() / 1000);

function payment(over = {}, authOver = {}) {
  return {
    x402Version: 1,
    scheme: "exact",
    network: "base",
    payload: {
      signature: "0xsig",
      authorization: {
        from: "0x2222222222222222222222222222222222222222",
        to: PAY_TO,
        value: "10000",
        validAfter: String(now() - 60),
        validBefore: String(now() + 600),
        nonce: "0x" + "ab".repeat(32),
        ...authOver,
      },
    },
    ...over,
  };
}

const header = (p) => Buffer.from(JSON.stringify(p)).toString("base64");

// ── the checks themselves ──────────────────────────────────────────────────

const REQS = buildRequirements("https://api.example.com/premium", CFG);

test("a well-formed payment for this resource verifies", () => {
  assert.strictEqual(verifyLocally(payment(), REQS).ok, true);
});

test("a payment addressed to someone else is refused", () => {
  // The one a broken facilitator most plausibly lets through, and the one that
  // pays an attacker while unlocking our resource.
  const v = verifyLocally(payment({}, { to: "0x9999999999999999999999999999999999999999" }), REQS);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.reason, "recipient_mismatch");
});

test("underpayment is refused, overpayment is not", () => {
  assert.strictEqual(verifyLocally(payment({}, { value: "9999" }), REQS).reason, "amount_below_required");
  assert.strictEqual(verifyLocally(payment({}, { value: "50000" }), REQS).ok, true);
});

test("an expired authorization is refused even if the facilitator would take it", () => {
  const v = verifyLocally(payment({}, { validBefore: String(now() - 1) }), REQS);
  assert.strictEqual(v.reason, "authorization_expired");
});

test("a not-yet-valid authorization is refused, with a little skew allowance", () => {
  assert.strictEqual(
    verifyLocally(payment({}, { validAfter: String(now() + 3600) }), REQS).reason,
    "authorization_not_yet_valid"
  );
  // Within the default 5s skew window, accepted — clocks differ.
  assert.strictEqual(verifyLocally(payment({}, { validAfter: String(now() + 3) }), REQS).ok, true);
});

test("scheme, network and version must match what we asked for", () => {
  assert.strictEqual(verifyLocally(payment({ scheme: "upto" }), REQS).reason, "scheme_mismatch");
  assert.strictEqual(verifyLocally(payment({ network: "solana" }), REQS).reason, "network_mismatch");
  assert.strictEqual(verifyLocally(payment({ x402Version: 2 }), REQS).reason, "version_mismatch");
});

test("a payload missing its signature or authorization is malformed", () => {
  assert.strictEqual(verifyLocally({ x402Version: 1, scheme: "exact", network: "base", payload: {} }, REQS).reason, "malformed_payload");
  const noSig = payment();
  delete noSig.payload.signature;
  assert.strictEqual(verifyLocally(noSig, REQS).reason, "malformed_payload");
});

test("a non-integer amount is refused rather than coerced", () => {
  assert.strictEqual(verifyLocally(payment({}, { value: "1e4" }), REQS).reason, "amount_unparseable");
});

test("EVM addresses compare case-insensitively, base58 does not", () => {
  // EIP-55 checksumming means the same EVM address arrives in different cases;
  // rejecting that would refuse correct payments. Base58 is case-significant,
  // so lowercasing it would make two DIFFERENT Solana addresses compare equal.
  assert.strictEqual(addressesEqual(PAY_TO, PAY_TO.toUpperCase().replace("0X", "0x")), true);
  assert.strictEqual(
    addressesEqual("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "epjfwdd5aufqssqem2qn1xzybapc8g4weggkzwytdt1v"),
    false
  );
});

// ── gate() behaviour, against a facilitator that approves everything ────────

test("gate refuses a mismatched payment even when the facilitator approves it", async () => {
  const f = yesFacilitator();
  const bad = payment({}, { to: "0x9999999999999999999999999999999999999999" });
  const result = await gate("https://api.example.com/premium", header(bad), { ...CFG, facilitator: f });

  assert.strictEqual(result.paid, false);
  assert.strictEqual(result.status, 402);
  assert.match(result.body.error, /recipient_mismatch/);
});

test("a refused payment is never sent for settlement", async () => {
  // Settling first and refusing afterwards would move money on-chain for a
  // resource we then decline to release — worse than a 402.
  const f = yesFacilitator();
  await gate("https://x/premium", header(payment({}, { value: "1" })), { ...CFG, facilitator: f });
  assert.strictEqual(f.calls.length, 0);
});

test("a valid payment still settles and releases", async () => {
  const f = yesFacilitator();
  const result = await gate("https://x/premium", header(payment()), { ...CFG, facilitator: f });
  assert.strictEqual(result.paid, true);
  assert.strictEqual(f.calls.length, 1);
});

test("skipLocalVerification restores the old behaviour, and is the unsafe posture", async () => {
  const f = yesFacilitator();
  const bad = payment({}, { to: "0x9999999999999999999999999999999999999999" });
  const result = await gate("https://x/premium", header(bad), {
    ...CFG,
    facilitator: f,
    skipLocalVerification: true,
  });
  assert.strictEqual(result.paid, true, "escape hatch must still work for unknown schemes");
});

// ── Attack III: caching ────────────────────────────────────────────────────

test("withX402 marks the PAID response uncacheable", async () => {
  const f = yesFacilitator();
  const handler = withX402(async () => Response.json({ data: "premium" }), { ...CFG, facilitator: f });
  const res = await handler(
    new Request("https://x/premium", { headers: { "x-payment": header(payment()) } })
  );

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers.get("cache-control"), "no-store, private");
  assert.strictEqual(res.headers.get("vary"), "X-PAYMENT, PAYMENT-SIGNATURE");
});

test("withX402 overrides a handler that set its own cache policy", async () => {
  // The handler chose that policy without knowing the response was paid for.
  const f = yesFacilitator();
  const handler = withX402(
    async () => new Response(JSON.stringify({ data: "x" }), { headers: { "Cache-Control": "public, max-age=3600" } }),
    { ...CFG, facilitator: f }
  );
  const res = await handler(
    new Request("https://x/premium", { headers: { "x-payment": header(payment()) } })
  );
  assert.strictEqual(res.headers.get("cache-control"), "no-store, private");
});

test("withX402 marks the 402 CHALLENGE uncacheable too", async () => {
  const handler = withX402(async () => Response.json({}), CFG);
  const res = await handler(new Request("https://x/premium"));
  assert.strictEqual(res.status, 402);
  assert.strictEqual(res.headers.get("cache-control"), "no-store, private");
});

test("expressX402 sets the headers on both the challenge and the paid path", async () => {
  const f = yesFacilitator();
  const mk = () => {
    const headers = {};
    return {
      headers,
      statusCode: 0,
      body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; },
      setHeader(k, v) { headers[k] = v; },
    };
  };

  // Challenge.
  const res1 = mk();
  await expressX402(CFG)({ url: "/premium", headers: {} }, res1, () => {});
  assert.strictEqual(res1.statusCode, 402);
  assert.strictEqual(res1.headers["Cache-Control"], "no-store, private");

  // Paid.
  const res2 = mk();
  let nexted = false;
  await expressX402({ ...CFG, facilitator: f })(
    { url: "/premium", headers: { "x-payment": header(payment()) } },
    res2,
    () => { nexted = true; }
  );
  assert.strictEqual(nexted, true);
  assert.strictEqual(res2.headers["Cache-Control"], "no-store, private");
  assert.strictEqual(res2.headers["Vary"], "X-PAYMENT, PAYMENT-SIGNATURE");
});

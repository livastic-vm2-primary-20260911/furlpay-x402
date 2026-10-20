"use strict";
const test = require("node:test");
const assert = require("node:assert");
const {
  gate,
  buildRequirements,
  issueQuote,
  verifyQuote,
  MemoryClaimStore,
  claimKey,
} = require("../dist/index.js");

// ---------------------------------------------------------------------------
// The two halves of #6 that field checks cannot reach.
//
// Cross-resource substitution is invisible to field validation: a payment for
// /a and a payment for /b at the same price on the same server differ in NO
// field the authorization carries. Replay is invisible for the same reason —
// the second presentation of a valid payment is byte-identical to the first.
//
// Both facilitator stubs below approve everything, so every refusal is the
// middleware's own.
// ---------------------------------------------------------------------------

const PAY_TO = "0x1111111111111111111111111111111111111111";
const SECRET = "test-binding-secret-value";
const CFG = { payTo: PAY_TO, amount: "10000", bindingSecret: SECRET };

function yesFacilitator() {
  const calls = [];
  return {
    calls,
    supported: async () => ({ kinds: [] }),
    verify: async () => ({ isValid: true }),
    settle: async (payload, requirements) => {
      calls.push({ payload, requirements });
      return { success: true, transaction: "0xtx", network: "base", payer: "0xpayer" };
    },
  };
}

const now = () => Math.floor(Date.now() / 1000);

function payment(quote, over = {}, authOver = {}) {
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
        nonce: "0x" + require("node:crypto").randomBytes(32).toString("hex"),
        ...authOver,
      },
    },
    extra: quote ? { quote } : undefined,
    ...over,
  };
}

const header = (p) => Buffer.from(JSON.stringify(p)).toString("base64");

/** Pull the quote out of a real 402 challenge, as a payer would. */
async function quoteFor(resource, cfg = CFG) {
  const challenge = await gate(resource, null, cfg);
  return challenge.body.accepts[0].extra.quote;
}

// ── binding ────────────────────────────────────────────────────────────────

test("the 402 challenge carries a quote when binding is on", async () => {
  const q = await quoteFor("https://x/a");
  assert.ok(typeof q === "string" && q.includes("."));
});

test("no quote is issued when no binding secret is configured", async () => {
  const challenge = await gate("https://x/a", null, { payTo: PAY_TO, amount: "10000" });
  assert.strictEqual(challenge.body.accepts[0].extra, undefined);
});

test("a payment carrying its own resource's quote is accepted", async () => {
  const f = yesFacilitator();
  const q = await quoteFor("https://x/a");
  const r = await gate("https://x/a", header(payment(q)), { ...CFG, facilitator: f });
  assert.strictEqual(r.paid, true);
});

test("A PAYMENT FOR /a CANNOT UNLOCK /b — the whole point", async () => {
  // Same price, same payTo, same network, same everything the authorization
  // carries. Only the quote distinguishes them.
  const f = yesFacilitator();
  const quoteForA = await quoteFor("https://x/a");
  const r = await gate("https://x/b", header(payment(quoteForA)), { ...CFG, facilitator: f });

  assert.strictEqual(r.paid, false);
  assert.match(r.body.error, /quote_resource_mismatch/);
  assert.strictEqual(f.calls.length, 0, "must not even attempt settlement");
});

test("a payment with no quote is refused once binding is on", async () => {
  const f = yesFacilitator();
  const r = await gate("https://x/a", header(payment(null)), { ...CFG, facilitator: f });
  assert.match(r.body.error, /quote_missing/);
});

test("a forged quote does not verify", async () => {
  const reqs = buildRequirements("https://x/a", CFG);
  const forged = issueQuote(reqs, "a-different-secret", 300);
  assert.strictEqual(verifyQuote(forged, reqs, SECRET).reason, "quote_signature_invalid");
});

test("a tampered quote body does not verify", async () => {
  const reqs = buildRequirements("https://x/a", CFG);
  const good = issueQuote(reqs, SECRET, 300);
  const [body, sig] = good.split(".");
  const claims = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
  claims.r = "https://x/b";
  const tamperedBody = Buffer.from(JSON.stringify(claims)).toString("base64url");
  assert.strictEqual(
    verifyQuote(`${tamperedBody}.${sig}`, reqs, SECRET).reason,
    "quote_signature_invalid"
  );
});

test("an expired quote does not verify", async () => {
  const reqs = buildRequirements("https://x/a", CFG);
  const q = issueQuote(reqs, SECRET, 60);
  assert.strictEqual(verifyQuote(q, reqs, SECRET, now() + 120).reason, "quote_expired");
});

test("a quote does not survive a price change at the same URL", async () => {
  const cheap = buildRequirements("https://x/a", { payTo: PAY_TO, amount: "10000" });
  const q = issueQuote(cheap, SECRET, 300);
  const dear = buildRequirements("https://x/a", { payTo: PAY_TO, amount: "9999999" });
  assert.strictEqual(verifyQuote(q, dear, SECRET).reason, "quote_terms_mismatch");
});

test("a quote does not survive a payTo change", async () => {
  const mine = buildRequirements("https://x/a", { payTo: PAY_TO, amount: "10000" });
  const q = issueQuote(mine, SECRET, 300);
  const theirs = buildRequirements("https://x/a", {
    payTo: "0x9999999999999999999999999999999999999999",
    amount: "10000",
  });
  assert.strictEqual(verifyQuote(q, theirs, SECRET).reason, "quote_terms_mismatch");
});

test("malformed quotes are refused rather than throwing", () => {
  const reqs = buildRequirements("https://x/a", CFG);
  assert.strictEqual(verifyQuote("no-dot-here", reqs, SECRET).reason, "quote_malformed");
  assert.strictEqual(verifyQuote(12345, reqs, SECRET).reason, "quote_missing");
  assert.strictEqual(verifyQuote("!!!.###", reqs, SECRET).reason, "quote_signature_invalid");
});

// ── replay ─────────────────────────────────────────────────────────────────

test("the same payment cannot release the resource twice", async () => {
  const f = yesFacilitator();
  const cfg = { ...CFG, facilitator: f };
  const q = await quoteFor("https://x/a", cfg);
  const h = header(payment(q));

  const first = await gate("https://x/a", h, cfg);
  assert.strictEqual(first.paid, true);

  const second = await gate("https://x/a", h, cfg);
  assert.strictEqual(second.paid, false);
  assert.match(second.body.error, /payment_already_used/);
  assert.strictEqual(f.calls.length, 1, "the replay must not reach the settler");
});

test("concurrent copies of one payment release it exactly once", async () => {
  const f = yesFacilitator();
  const cfg = { ...CFG, facilitator: f };
  const q = await quoteFor("https://x/a", cfg);
  const h = header(payment(q));

  const results = await Promise.all(Array.from({ length: 8 }, () => gate("https://x/a", h, cfg)));
  assert.strictEqual(results.filter((r) => r.paid).length, 1);
  assert.strictEqual(f.calls.length, 1);
});

test("a declined payment can be retried — the claim is given back", async () => {
  // No money moved, so locking the payer out of their own authorization would
  // be the gate inventing a penalty the protocol does not have.
  const declining = {
    supported: async () => ({ kinds: [] }),
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: false, errorReason: "insufficient_funds", network: "base" }),
  };
  const cfg = { ...CFG, facilitator: declining };
  const q = await quoteFor("https://x/a", cfg);
  const h = header(payment(q));

  const first = await gate("https://x/a", h, cfg);
  assert.match(first.body.error, /insufficient_funds/);

  // Same header again reaches the facilitator rather than being refused as used.
  const second = await gate("https://x/a", h, cfg);
  assert.match(second.body.error, /insufficient_funds/);
});

test("a settlement that THROWS keeps the claim — unknown is not failed", async () => {
  // The transaction may well have landed and the response lost. Releasing here
  // would re-open replay for the payment most likely to have actually settled.
  let attempts = 0;
  const flaky = {
    supported: async () => ({ kinds: [] }),
    verify: async () => ({ isValid: true }),
    settle: async () => {
      attempts++;
      throw new Error("upstream timeout");
    },
  };
  const cfg = { ...CFG, facilitator: flaky };
  const q = await quoteFor("https://x/a", cfg);
  const h = header(payment(q));

  const first = await gate("https://x/a", h, cfg);
  assert.match(first.body.error, /settlement_unknown/);

  const second = await gate("https://x/a", h, cfg);
  assert.match(second.body.error, /payment_already_used/);
  assert.strictEqual(attempts, 1, "must not retry an unknown settlement automatically");
});

test("an insufficiently-deep settlement CAN be retried", async () => {
  // This 402 invites the payer to wait and try again; holding the claim would
  // make that the one thing they cannot do.
  let depth = "submitted";
  const deepening = {
    supported: async () => ({ kinds: [] }),
    verify: async () => ({ isValid: true }),
    settle: async () => ({
      success: true,
      transaction: "0xtx",
      network: "base",
      payer: "0xp",
      settlement: { strength: depth },
    }),
  };
  const cfg = { ...CFG, facilitator: deepening, requireSettlement: "finalized" };
  const q = await quoteFor("https://x/a", cfg);
  const h = header(payment(q));

  const early = await gate("https://x/a", h, cfg);
  assert.strictEqual(early.paid, false);
  assert.match(early.body.error, /settlement_strength_insufficient/);

  depth = "finalized";
  const later = await gate("https://x/a", h, cfg);
  assert.strictEqual(later.paid, true, "the payer must be able to come back once it is deep");
});

test("singleUse:false restores facilitator-only replay resistance", async () => {
  const f = yesFacilitator();
  const cfg = { ...CFG, facilitator: f, singleUse: false };
  const q = await quoteFor("https://x/a", cfg);
  const h = header(payment(q));

  assert.strictEqual((await gate("https://x/a", h, cfg)).paid, true);
  assert.strictEqual((await gate("https://x/a", h, cfg)).paid, true);
  assert.strictEqual(f.calls.length, 2);
});

test("an injected claim store is used instead of the default", async () => {
  const store = new MemoryClaimStore();
  const f = yesFacilitator();
  const cfg = { ...CFG, facilitator: f, claimStore: store };
  const q = await quoteFor("https://x/a", cfg);
  await gate("https://x/a", header(payment(q)), cfg);
  // A single EIP-3009 authorization reserves BOTH historically deployed
  // V1 network aliases (plain "base" and CAIP-2), so a rolling deployment
  // cannot reuse the same spent authorization under a different spelling.
  assert.strictEqual(store.size, 2);
});

// ── the store itself ───────────────────────────────────────────────────────

test("MemoryClaimStore admits exactly one claimant", () => {
  const s = new MemoryClaimStore();
  assert.strictEqual(s.claim("k"), true);
  assert.strictEqual(s.claim("k"), false);
  s.release("k");
  assert.strictEqual(s.claim("k"), true);
});

test("claims expire", () => {
  const s = new MemoryClaimStore(0);
  assert.strictEqual(s.claim("k"), true);
  assert.strictEqual(s.claim("k"), true, "a zero TTL claim is immediately reclaimable");
});

test("claim keys are network-scoped and never quote-scoped", () => {
  // The same nonce on two chains is two different payments.
  assert.notStrictEqual(claimKey("base", "0x1"), claimKey("solana", "0x1"));
  // This test used to assert the opposite: that a quote id REPLACED the nonce
  // in the key. Quotes are free and unlimited, so that let one authorization
  // win one claim per quote. The nonce is the identity whatever the quote.
  assert.strictEqual(claimKey("base", "0x1", "q1"), claimKey("base", "0x1", "q2"));
  assert.strictEqual(claimKey("base", "0x1", "q1"), claimKey("base", "0x1"));
  assert.match(claimKey("base", "0x1", "q1"), /^n:/);
});

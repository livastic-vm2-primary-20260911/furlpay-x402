# @furlpay/x402

![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Next.js](https://img.shields.io/badge/Next.js-000000?style=flat-square&logo=nextdotjs&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)
![Base](https://img.shields.io/badge/Base-0052FF?style=flat-square&logo=coinbase&logoColor=white)
![Arbitrum](https://img.shields.io/badge/Arbitrum-213147?style=flat-square&logo=arbitrum&logoColor=white)
![Solana](https://img.shields.io/badge/Solana-9945FF?style=flat-square&logo=solana&logoColor=white)
![x402](https://img.shields.io/badge/x402-0052FF?style=flat-square)
![USDC](https://img.shields.io/badge/USDC-2775CA?style=flat-square)

[![license](https://img.shields.io/badge/license-MIT-green)](./LICENSE)

x402 payment middleware and facilitator client — gate any HTTP route behind a stablecoin micropayment in a few lines. Built on the [x402 protocol](https://www.x402.org/) (HTTP 402 "Payment Required" revived for machine-to-machine payments).

- Framework adapters for Next.js App Router and Express/Connect, plus a framework-agnostic core.
- Verification and on-chain settlement are delegated to a facilitator — the hosted Furlpay facilitator by default, or point at your own.
- Native Circle USDC on Base and Arbitrum, plus Solana USDC, resolved automatically; other assets via explicit config.

### What settles, and what merely quotes

These are different capabilities and this README used to blur them:

| | Base | Arbitrum | Solana |
| --- | --- | --- | --- |
| Middleware can emit a 402 | yes | yes | yes |
| Hosted facilitator verifies + settles | yes | yes | **no** |

The middleware is chain-agnostic — `buildRequirements()` resolves the right USDC
asset and returns a well-formed 402 for any network you configure. Settlement is
delegated to a facilitator, and the hosted Furlpay facilitator verifies EIP-3009
authorizations by EIP-712 `ecrecover` (plus ERC-1271 for contract wallets). That
is an EVM mechanism. Solana uses a different signature scheme, so the verifier
returns `svm_verification_unavailable` rather than accepting something it has not
checked — it fails closed, but it does fail.

So: point the middleware at Solana if you are running a facilitator that can
settle SVM. If you are using the hosted default, use an EVM network.
- Zero runtime dependencies. Node 18+. TypeScript types included.

## Why x402

AI agents, scripts, and API clients cannot fill out card checkout forms. x402 lets a server answer HTTP 402 with machine-readable payment requirements; the client signs an authorization and retries with a version-appropriate payment header. This middleware verifies local fields before asking the configured facilitator to settle, then serves only after a successful settlement verdict. No account or subscription is required by the protocol.

### Protocol versions: V1 and V2 (issue #17)

**On an unpinned Base or Arbitrum route**, the same middleware:
- Preserves the existing **V1 JSON body**, accepting `X-PAYMENT` and returning `X-PAYMENT-RESPONSE`, with legacy plain network names.
- Also includes a base64-encoded **V2 `PAYMENT-REQUIRED`** HTTP header. It contains a separate `resource` descriptor and an `accepts` offer with `amount`, not V1 `maxAmountRequired`; networks use CAIP-2 IDs (`eip155:8453` and `eip155:42161`).
- Accepts V2 `PAYMENT-SIGNATURE` and returns `PAYMENT-RESPONSE` on success, while refusing simultaneous/conflicting payment headers.
- Claims the EIP-3009 nonce **once across both wire versions**, reserving the old V1 plain and CAIP-2 namespace aliases on upgrades. A single payment therefore occupies **two** alias keys on a known EVM chain; failure rolls back only keys acquired by that attempt, indeterminate outcomes retain both. An injected cross-instance claim store remains required for multi-worker deployments.

To **pin a route to one version**, set `x402Version: 1` (legacy) or `x402Version: 2` (V2-only) in the usual `withX402` / `expressX402` config:

```ts
export const GET = withX402(
  async () => Response.json({ ok: true }),
  {
    payTo: "0xYOUR_RECOVERABLE_ADDRESS",
    network: "arbitrum",
    amount: "5000", // 0.005 native Circle USDC (six decimals)
    x402Version: 2,
    requireSettlement: "finalized",
  }
);
```

Arbitrum's default asset is native Circle USDC
`0xaf88d065e77c8cC2239327C5EDb3A432268e5831`, **not bridged USDC.e**.
Unknown EVM networks require an explicit `asset`, not a Base USDC fallback.
V2 presently refuses network identifiers it cannot translate for Base or Arbitrum.

**Express V2 resource binding:** Express usually exposes only a relative
`req.originalUrl`. To issue a valid V2 challenge, configure `resourceUrl` to
the specific trusted absolute endpoint URL; this SDK intentionally **does
not** derive the paid resource origin from the incoming HTTP `Host` header.
Unpinned Express routes with a relative URL keep the legacy V1 quote but
decline V2 until configured. No source data is uploaded by this policy.

```ts
app.get("/premium",
  expressX402({
    payTo: "0xYOUR_RECOVERABLE_ADDRESS",
    network: "arbitrum",
    amount: "5000",
    resourceUrl: "https://merchant.example.com/premium",
    requireSettlement: "finalized",
  }),
  handler
);
```

**Settlement caution:** local regression tests use only synthetic fixture payloads
and injected fake facilitators. They prove refusal/replay/wire-format logic,
**not** real EIP-712 signature verification, successful facilitator interoperability,
a mainnet payment or a real buyer. The public FurlPay facilitator advertises
V2 support for Arbitrum/Base, but its public discovery lists plain network names
while the V2 wire specification requires CAIP-2. Confirm end-to-end settlement,
correct chain/token, finality and a safely recoverable owner payee **before
collecting live funds**. Mock `success: true` is not revenue.

## Installation

```bash
npm install @furlpay/x402
```

## Quickstart — Next.js App Router

```ts
// app/api/premium/route.ts
import { withX402 } from "@furlpay/x402";

export const GET = withX402(
  async () => Response.json({ data: "premium market signal" }),
  {
    payTo: "0xYourReceivingAddress",
    network: "base",          // or "solana"
    amount: "10000",          // atomic units of the asset; USDC has 6 decimals, so "10000" = $0.01
    description: "Premium data",
  }
);
```

Unpaid requests receive a `402` with the payment requirements in the body; paid requests are settled and served with an `X-PAYMENT-RESPONSE` receipt header.

## Quickstart — Express

```ts
import express from "express";
import { expressX402 } from "@furlpay/x402";

const app = express();

app.get(
  "/premium",
  expressX402({ payTo: "0xYourAddress", network: "base", amount: "10000" }),
  (req, res) => res.json({ data: "premium" })
);
```

## Framework-agnostic core

`gate()` implements the whole flow without any framework assumptions:

```ts
import { gate } from "@furlpay/x402";

const result = await gate(requestUrl, xPaymentHeaderOrNull, {
  payTo: "0xYourAddress",
  amount: "10000",
});

if (!result.paid) {
  // result.status is 402 (challenge) or 400 (malformed header)
  // result.body is the JSON to return
} else {
  // result.payer, result.transaction, result.settlementHeader
}
```

## Configuration

| Option | Type | Default | Description |
|---|---|---|---|
| `payTo` | `string` | — | Receiving address on the target network. Required. |
| `network` | `"base"` \| `"arbitrum"` \| `"solana"` | `"base"` | Settlement network. V2 uses CAIP-2 on Base/Arbitrum and declines unknown V2 networks. |
| `x402Version` | `1` \| `2` (optional) | Both | Default preserves V1 body and adds V2 header for known EVM networks; an explicit version pins the route. |
| `resourceUrl` | `string` (optional) | request URL | Canonical absolute HTTP(S) URL for Express V2; do not infer from untrusted Host. |
| `asset` | `string` | USDC on the chosen network | Token contract / mint address. |
| `amount` | `string` | — | Price in atomic units of `asset` (USDC: 6 decimals). Required. |
| `description` | `string` | `"x402 payment"` | Human-readable description in the 402 challenge. |
| `facilitator` | `string \| Facilitator` | Furlpay hosted | Facilitator base URL, or your own `Facilitator` implementation (useful in tests). |
| `maxTimeoutSeconds` | `number` | `300` | How long the signed payment stays valid. |

## Facilitator client

Talk to any x402 facilitator's `supported` / `verify` / `settle` API directly:

```ts
import { useFacilitator, DEFAULT_FACILITATOR } from "@furlpay/x402";

const facilitator = useFacilitator();                     // hosted: https://furlpay.com/api/x402/facilitator
const local = useFacilitator("http://localhost:3000/api/x402/facilitator");

const { kinds } = await facilitator.supported();          // supported (scheme, network) pairs
const verdict = await facilitator.verify(payload, requirements);
const receipt = await facilitator.settle(payload, requirements);
```

`useFacilitator(baseUrl, fetchImpl)` accepts a custom fetch for proxies and tests.

## Requirements builder

`buildRequirements(resource, config)` produces the spec-shaped `PaymentRequirements` object (scheme `exact`, resolved asset, timeout) if you need to construct challenges manually.

## Security notes

### What this package checks itself

`gate()` verifies the presented payload against the requirements **it** built,
before forwarding anything to a facilitator:

| Checked locally | Refused when |
| --- | --- |
| `payTo` | the authorization is addressed to someone else |
| amount | `authorization.value < maxAmountRequired` (overpayment is fine) |
| `scheme` / `network` / `x402Version` | they differ from the challenge |
| validity window | expired, or not yet valid beyond a 5s skew allowance |
| shape | no signature, or no authorization object |

These hold even when the facilitator is wrong, misconfigured or hostile — which
matters because `facilitator` is a documented option, so "the hosted one" and
"any third party" are the same code path. A payment that fails them is **never
submitted for settlement**, so a mismatched payment does not move money on-chain
for a resource that is then refused.

`skipLocalVerification: true` restores the old delegate-everything behaviour for
a scheme this package cannot interpret. It is an escape hatch, not a tuning
knob: setting it makes any facilitator weakness a full bypass again.

Paid responses and 402 challenges are both stamped `Cache-Control: no-store,
private` and `Vary: X-PAYMENT`, so a CDN or reverse proxy cannot serve a paid
response to a later unpaid client.

### Resource binding — one payment, one resource

Field checks cannot stop cross-resource substitution: a payment for `/a` and a
payment for `/b` at the same price on the same server differ in **no field the
authorization carries**. The `exact` scheme simply does not name a resource.

Set `bindingSecret` and the 402 carries a signed quote the payer echoes back in
`extra.quote`:

```ts
withX402(handler, {
  payTo: "0x...",
  amount: "10000",
  bindingSecret: process.env.X402_BINDING_SECRET, // server-held, never shipped
});
```

The quote is HMAC'd over the resource, price, recipient and network, so a payer
can return one but cannot mint one for a different route — and a quote stops
verifying the moment any of those terms change.

Opt-in because it is a protocol change for payers, not because it is optional in
any security sense.

### Replay — one payment, one grant

`gate()` claims each payment before settling, so a replayed `X-PAYMENT` header
is refused rather than releasing the resource again. The claim key is the
network plus the authorization's on-chain nonce, **with or without resource
binding**: a quote is free with every 402, so it restricts which resource a
payment unlocks but is never the replay identity. The nonce is validated and
canonicalized first (EVM: exactly 32 bytes of hex, lowercased; `0xAB…` and
`ab…` are one nonce), and a payment with a missing or malformed nonce or no
`validBefore` is refused before settlement. The release rule is the part that
matters:

| Settlement outcome | Claim |
| --- | --- |
| success | kept — the payment is spent |
| definite failure | **released** — no money moved, so the payer can retry |
| not yet deep enough | **released** — that 402 invites a retry |
| threw / timed out | **kept** — unknown is not "did not happen" |

The default store is in-memory and therefore **single-instance only**: its
atomicity comes from Node being single-threaded, which is worth nothing across
two workers. Behind a load balancer each instance keeps its own set and a
payment replays once per instance — inject a shared store (Redis `SET NX`) via
`claimStore`, or set `singleUse: false` to leave replay entirely to the
facilitator.

A claim must outlive the authorization it guards. `gate()` passes
`holdUntilMs` (the authorization's `validBefore` plus a margin) as the second
argument to `claim()`; a shared store must keep the key at least that long
(for Redis, `SET key 1 NX PXAT holdUntilMs`). A store that ignores it and
expires keys sooner reopens replay for any authorization still inside its
validity window.

### What still lives in the facilitator

Local checks are field checks, not a **signature** check — verifying the
authorization's signature needs the chain's curve and is the facilitator's job.
Settlement finality is governed by `requireSettlement` (see
`SettlementStrength`), which refuses to release against a transaction the
facilitator has not claimed is strong enough.

That distinction only matters if you change the facilitator — and the `facilitator`
option exists precisely so you can. Against the hosted Furlpay facilitator you get
the hardened verifier described below. Against your own deployment, or any third
party, you get exactly what that facilitator enforces, plus the local checks above.

The hardened server-side verifier used by the hosted facilitator defends the four
published x402 attack classes: authorization (server-side truth for every field),
binding (HMAC over resource + method + amount + expiry), replay (single-use nonces
and quote ids), and web-layer handling (size-capped, fail-closed header parsing).
See the [Furlpay security write-up](https://furlpay.com/blog/five-ways-to-rob-an-ai-agent-securing-x402)
for details.

### Self-hosting or using another facilitator

Add the defenses at your own edge:

- [`@furlpay/x402-guard`](https://github.com/FurlPay/x402-guard) — request binding (F1),
  atomic nonce linearization (F2), reserve-commit allowances (F3) and settlement
  capacity limits (F4), all failure-closed.
- [`@furlpay/settlement`](https://github.com/FurlPay/furlpay-settlement) — `assessSettlement`
  decides whether an observed on-chain state is strong enough to release, given the
  amount at risk. A `SettleResponse` reporting `success` says a transaction exists; it
  does not say the transaction is irreversible.

Neither is a dependency of this package, so neither is applied unless you wire it in.

## Testing

The package ships a `node:test` suite covering the requirements builder, the 402/400/settlement paths of `gate`, the Next.js wrapper, and facilitator URL routing:

```bash
npm test
```

Inject a stub facilitator in your own tests via the `facilitator` option — no network needed.

## Related

- [furlpay-solana-actions-template](https://github.com/FurlPay/furlpay-solana-actions-template) — Solana Actions and Blinks starter
- [furlpay-node](https://github.com/FurlPay/furlpay-node) — the Furlpay API SDK
- [Documentation](https://furlpay.com/docs)

## Contributing and security

See [CONTRIBUTING.md](./CONTRIBUTING.md). Report vulnerabilities privately per [SECURITY.md](./SECURITY.md).

## License

MIT

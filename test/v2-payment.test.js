"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  gate, withX402, expressX402, buildRequirements, MemoryClaimStore,
  claimKey, claimNetwork, claimNetworks,
} = require("../dist/index.js");

const TO = "0x1111111111111111111111111111111111111111";
const FROM = "0x2222222222222222222222222222222222222222";
const URL = "https://merchant.example/paid.csv";
const NONCE = "0x" + "aa".repeat(32);
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const USDC_ARB = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const cfgV2 = { payTo: TO, amount: "5000", network: "arbitrum", x402Version: 2 };
const hdr = object => Buffer.from(JSON.stringify(object)).toString("base64");

function stub() {
  const calls = [];
  return {
    calls,
    supported: async () => ({ kinds: [] }),
    verify: async () => ({ isValid: true }),
    settle: async (payload, requirements) => {
      calls.push({payload, requirements});
      return {
        success: true,
        transaction: "0x" + "cd".repeat(32),
        network: requirements.network,
        payer: FROM,
        settlement: {strength: "finalized", confirmations: null},
      };
    }
  };
}
function v2Payment(offer, resource = URL, overrides = {}, auth = {}) {
  const now = Math.floor(Date.now()/1000);
  return {
    x402Version: 2,
    resource: {url: resource, description:"synthetic local only",mimeType:"application/json"},
    accepted: {...offer},
    payload: {
      signature: "0xsynthetic-TEST-SIGNATURE-not-a-valid-onchain-payment",
      authorization: {
        from: FROM, to: TO, value: offer.amount,
        validAfter: String(now-90), validBefore: String(now+500),
        nonce: NONCE, ...auth,
      },
    },
    extensions:{},
    ...overrides
  };
}
function v1Payment(value="5000", network="arbitrum", nonce=NONCE) {
  const now=Math.floor(Date.now()/1000);
  return {
    x402Version:1, scheme:"exact",network,
    payload:{signature:"0xsynthetic-TEST-SIGNATURE",authorization:{
      from:FROM,to:TO,value,validAfter:String(now-90),validBefore:String(now+500),nonce
    }}
  };
}
async function offerFor(cfg=cfgV2,resource=URL){
  const challenge=await gate(resource,null,cfg);
  assert.equal(challenge.paid,false);
  assert.equal(challenge.status,402);
  assert.equal(challenge.body.x402Version,2);
  return challenge.body.accepts[0];
}

test("opt-in V2 advertises CAIP-2 Arbitrum native Circle USDC without V1 fields",async()=>{
  const ch=await gate(URL,null,cfgV2);
  assert.equal(ch.body.x402Version,2);
  assert.equal(ch.body.resource.url,URL);
  assert.deepEqual(ch.body.extensions,{});
  const a=ch.body.accepts[0];
  assert.equal(a.network,"eip155:42161");
  assert.equal(a.asset,USDC_ARB);
  assert.equal(a.amount,"5000");
  assert.equal(a.payTo,TO);
  assert.equal(a.maxTimeoutSeconds,300);
  assert.equal(a.scheme,"exact");
  assert.equal(Object.hasOwn(a,"maxAmountRequired"),false);
  assert.equal(Object.hasOwn(a,"resource"),false);
  assert.equal(Object.hasOwn(a,"mimeType"),false);
});

test("V2 uses native Circle BASE USDC, not bridged/mismatched asset",async()=>{
  const a=await offerFor({...cfgV2,network:"base"});
  assert.equal(a.network,"eip155:8453");
  assert.equal(a.asset,USDC_BASE);
});

test("unknown V2 chains fail closed instead of defaulting to Base USDC",async()=>{
  await assert.rejects(gate(URL,null,{...cfgV2,network:"arbitrum-sepolia"}),/(not configured|asset must be configured)/);
  assert.throws(()=>buildRequirements(URL,{payTo:TO,amount:"2",network:"unknown-net"}),/asset must be configured/);
});

test("V1 default remains byte-shape compatible for existing Base clients",async()=>{
  const ch=await gate(URL,null,{payTo:TO,amount:"5000"});
  assert.equal(ch.body.x402Version,1);
  assert.equal(ch.body.accepts[0].network,"base");
  assert.equal(ch.body.accepts[0].maxAmountRequired,"5000");
  assert.equal(ch.body.accepts[0].asset,USDC_BASE);
  assert.equal(Object.hasOwn(ch.body,"resource"),false);
});

test("V2 valid synthetic envelope reaches injected local facilitator with V2 wire fields",async()=>{
  const f=stub();
  const cfg={...cfgV2,facilitator:f};
  const a=await offerFor(cfg);
  const p=v2Payment(a);
  const paid=await gate(URL,hdr(p),cfg);
  assert.equal(paid.paid,true);
  assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].payload.x402Version,2);
  assert.deepEqual(f.calls[0].payload.accepted,p.accepted);
  assert.equal(f.calls[0].requirements.amount,"5000");
  assert.equal(f.calls[0].requirements.network,"eip155:42161");
  assert.equal(Object.hasOwn(f.calls[0].requirements,"maxAmountRequired"),false);
  assert.equal(paid.transaction,"0x"+"cd".repeat(32));
});

test("V2 accepted terms cannot be substituted; facilitator is never called",async()=>{
 const offer=await offerFor();
 const mutations=[
  {scheme:"not-exact"},
  {network:"eip155:8453"},
  {amount:"4999"},
  {amount:"5001"},
  {payTo:FROM},
  {asset:USDC_BASE},
  {maxTimeoutSeconds:299},
 ];
 for(const changed of mutations){
  const f=stub();
  const out=await gate(URL,hdr(v2Payment({...offer,...changed})),{...cfgV2,facilitator:f});
  assert.equal(out.paid,false,JSON.stringify(changed));
  assert.equal(out.status,402);
  assert.match(out.body.error,/accepted_terms_mismatch/);
  assert.equal(f.calls.length,0);
 }
});

test("V2 EIP-3009 authorization recipient and amount remain local-checked",async()=>{
 const offer=await offerFor();
 for(const badAuth of [{to:FROM},{value:"4999"},{value:"not-a-number"}]){
  const f=stub(), cfg={...cfgV2,facilitator:f};
  const out=await gate(URL,hdr(v2Payment(offer,URL,{},badAuth)),cfg);
  assert.equal(out.paid,false);
  assert.equal(out.status,402);
  assert.equal(f.calls.length,0);
 }
});

test("V2 wrong x402Version/missing accepted is not a V1 fallback",async()=>{
 const offer=await offerFor(),f=stub(),cfg={...cfgV2,facilitator:f};
 for(const bad of [
  v2Payment(offer,URL,{x402Version:1}),
  v2Payment(offer,URL,{accepted:null}),
  v2Payment(offer,URL,{accepted:[]})
 ]){
  const out=await gate(URL,hdr(bad),cfg);
  assert.equal(out.paid,false);
  assert.equal(out.status,402);
 }
 assert.equal(f.calls.length,0);
});

test("V2 explicit mismatched resource is refused before settlement",async()=>{
 const offer=await offerFor(),f=stub(),cfg={...cfgV2,facilitator:f};
 const out=await gate(URL,hdr(v2Payment(offer,"https://merchant.example/other.csv")),cfg);
 assert.equal(out.paid,false);
 assert.match(out.body.error,/resource_mismatch/);
 assert.equal(f.calls.length,0);
});

test("V2 HMAC quote echo binds the whole route and cannot unlock another resource",async()=>{
 const bindingSecret="locally generated-test-only-binding-secret";
 const f=stub(),cfg={...cfgV2,facilitator:f,bindingSecret};
 const ch=await offerFor(cfg,URL);
 assert.equal(typeof ch.extra.quote,"string");
 const good=await gate(URL,hdr(v2Payment(ch)),cfg);
 assert.equal(good.paid,true);
 const cross=await gate("https://merchant.example/different",
   hdr(v2Payment(ch, URL, {resource:undefined})),cfg);
 assert.equal(cross.paid,false);
 assert.match(cross.body.error,/quote_resource_mismatch/);
 assert.equal(f.calls.length,1);
});

test("one EIP-3009 nonce grants at most ONE V1 or V2 request across shared store",async()=>{
 const store=new MemoryClaimStore();
 const f=stub();
 const common={payTo:TO,network:"arbitrum",amount:"5000",claimStore:store,facilitator:f};
 const v1=await gate(URL,hdr(v1Payment()),{...common,x402Version:1});
 assert.equal(v1.paid,true);
 const offered=await offerFor({...common,x402Version:2});
 const v2=await gate(URL,hdr(v2Payment(offered)),{...common,x402Version:2});
 assert.equal(v2.paid,false);
 assert.match(v2.body.error,/payment_already_used/);
 assert.equal(f.calls.length,1);
});

test("V1 and V2 racing with the same nonce must settle at most once",async()=>{
 const store=new MemoryClaimStore(),f=stub();
 const common={payTo:TO,network:"arbitrum",amount:"5000",claimStore:store,facilitator:f};
 const a=await offerFor({...common,x402Version:2});
 const out=await Promise.all([
  gate(URL,hdr(v1Payment()),{...common,x402Version:1}),
  gate(URL,hdr(v2Payment(a)),{...common,x402Version:2}),
 ]);
 assert.equal(out.filter(x=>x.paid).length,1);
 assert.equal(f.calls.length,1);
 assert.match(out.find(x=>!x.paid).body.error,/payment_already_used/);
});

test("distinct chain/nonce scopes do not conflict with cross-version protection",async()=>{
 const store=new MemoryClaimStore(),f=stub();
 const arb={...cfgV2,claimStore:store,facilitator:f};
 const base={...arb,network:"base"};
 const a=await offerFor(arb),b=await offerFor(base);
 const paidArb=await gate(URL,hdr(v2Payment(a)),arb);
 const paidBase=await gate(URL,hdr(v2Payment(b)),base);
 assert.equal(paidArb.paid,true);
 assert.equal(paidBase.paid,true);
 assert.equal(f.calls.length,2);
});

test("V2 Next.js emits PAYMENT-REQUIRED header with proper envelope, not X-PAYMENT",async()=>{
 const cfg={...cfgV2,facilitator:stub()};
 const handler=withX402(async()=>Response.json({success:true}),cfg);
 const res=await handler(new Request(URL));
 assert.equal(res.status,402);
 assert.equal(res.headers.get("cache-control"),"no-store, private");
 assert.equal(res.headers.get("vary"),"X-PAYMENT, PAYMENT-SIGNATURE");
 const raw=res.headers.get("PAYMENT-REQUIRED");
 assert.ok(raw);
 const decoded=JSON.parse(Buffer.from(raw,"base64").toString("utf8"));
 assert.equal(decoded.x402Version,2);
 assert.equal(decoded.accepts[0].network,"eip155:42161");
 assert.equal(res.headers.get("X-PAYMENT"),null);
});

test("V2 Next.js accepts only PAYMENT-SIGNATURE and returns PAYMENT-RESPONSE on paid route",async()=>{
 const f=stub(),cfg={...cfgV2,facilitator:f};
 const handler=withX402(async()=>new Response("premium",{headers:{"Cache-Control":"public, max-age=999"}}),cfg);
 const a=await offerFor(cfg);
 const paid=await handler(new Request(URL,{headers:{"PAYMENT-SIGNATURE":hdr(v2Payment(a))}}));
 assert.equal(paid.status,200);
 assert.equal(await paid.text(),"premium");
 assert.ok(paid.headers.get("PAYMENT-RESPONSE"));
 assert.equal(paid.headers.get("X-PAYMENT-RESPONSE"),null);
 assert.equal(paid.headers.get("Cache-Control"),"no-store, private");
 assert.equal(f.calls.length,1);
});

test("V2 rejects conflicts and legacy-only headers without contacting facilitator",async()=>{
 const f=stub(), cfg={...cfgV2,facilitator:f};
 const handler=withX402(async()=>Response.json({paid:true}),cfg);
 const a=await offerFor(cfg);
 const bad=[
  {"x-payment":hdr(v1Payment())},
  {"x-payment":hdr(v1Payment()),"PAYMENT-SIGNATURE":hdr(v2Payment(a))}
 ];
 for(const headers of bad){
  const res=await handler(new Request(URL,{headers}));
  assert.equal(res.status,400);
  assert.equal(res.headers.get("PAYMENT-REQUIRED"),null);
 }
 assert.equal(f.calls.length,0);
});

test("V1 Next.js keeps X-PAYMENT-RESPONSE even after adding V2",async()=>{
 const f=stub(),cfg={payTo:TO,network:"arbitrum",amount:"5000",facilitator:f};
 const handler=withX402(async()=>Response.json({ok:true}),cfg);
 const paid=await handler(new Request(URL,{headers:{"X-PAYMENT":hdr(v1Payment())}}));
 assert.equal(paid.status,200);
 assert.ok(paid.headers.get("X-PAYMENT-RESPONSE"));
 assert.equal(paid.headers.get("PAYMENT-RESPONSE"),null);
 assert.equal(paid.headers.get("vary"),"X-PAYMENT, PAYMENT-SIGNATURE");
});

test("V2 Express challenge and paid response headers use new wire names",async()=>{
 const f=stub(),cfg={...cfgV2,facilitator:f},middleware=expressX402(cfg);
 function res(){
  return {headers:{},statusCode:0,body:null,status(code){this.statusCode=code;return this;},
   json(body){this.body=body},setHeader(k,v){this.headers[k]=v}};
 }
 const challenge=res();let called=false;
 await middleware({url:URL,headers:{}},challenge,()=>called=true);
 assert.equal(challenge.statusCode,402);
 assert.equal(challenge.headers["Vary"],"X-PAYMENT, PAYMENT-SIGNATURE");
 assert.ok(challenge.headers["PAYMENT-REQUIRED"]);
 assert.equal(called,false);
 const accepted=JSON.parse(Buffer.from(challenge.headers["PAYMENT-REQUIRED"],"base64")).accepts[0];
 const paid=res();
 await middleware({url:URL,headers:{"payment-signature":hdr(v2Payment(accepted))}},paid,()=>called=true);
 assert.equal(called,true);
 assert.ok(paid.headers["PAYMENT-RESPONSE"]);
 assert.equal(paid.headers["X-PAYMENT-RESPONSE"],undefined);
 assert.equal(f.calls.length,1);
});

test("V2 Express refuses conflicting or multi-valued headers before grant",async()=>{
 const f=stub(),middleware=expressX402({...cfgV2,facilitator:f});
 for(const headers of [
   {"x-payment":hdr(v1Payment()),"payment-signature":hdr(v2Payment(await offerFor()))},
   {"payment-signature":["x","y"]},
   {"x-payment":hdr(v1Payment())}
 ]){
  let nexted=false;
  const res={headers:{},statusCode:0,status(n){this.statusCode=n;return this;},
    json(){},setHeader(k,v){this.headers[k]=v}};
  await middleware({url:URL,headers},res,()=>nexted=true);
  assert.equal(res.statusCode,400);
  assert.equal(nexted,false);
 }
 assert.equal(f.calls.length,0);
});

test("V2 unknown settlement strength does not make a paid resource available",async()=>{
 const f=stub();
 f.settle=async()=>({success:true,transaction:"0x"+"bb".repeat(32),network:"eip155:42161",payer:FROM});
 const cfg={...cfgV2,facilitator:f,requireSettlement:"finalized"};
 const out=await gate(URL,hdr(v2Payment(await offerFor(cfg))),cfg);
 assert.equal(out.paid,false);
 assert.match(out.body.error,/settlement_strength_insufficient/);
});

test("V2 oversized signed header and malformed base64 are bounded",async()=>{
 const cfg={...cfgV2,facilitator:stub()};
 let res=await gate(URL,"A".repeat(16385),cfg);
 assert.equal(res.status,400);
 res=await gate(URL,"BAD_NOT_JSON",cfg);
 assert.equal(res.status,400);
});


test("V2 preserves existing deployed V1 claim-key namespace across upgrades",()=>{
  const nonce="0x"+"ae".repeat(32);
  assert.equal(claimNetwork("base"),"base");
  assert.equal(claimNetwork("eip155:8453"),"base");
  assert.equal(claimNetwork("arbitrum"),"arbitrum");
  assert.equal(claimNetwork("eip155:42161"),"arbitrum");
  assert.equal(claimKey(claimNetwork("eip155:8453"),nonce),claimKey("base",nonce));
  assert.equal(claimKey(claimNetwork("eip155:42161"),nonce),claimKey("arbitrum",nonce));
});


test("default unpinned route advertises V1 body and V2 PAYMENT-REQUIRED header",async()=>{
 const cfg={payTo:TO,amount:"5000",network:"arbitrum"};
 const handler=withX402(async()=>Response.json({}),cfg);
 const res=await handler(new Request(URL));
 assert.equal(res.status,402);
 const legacy=await res.json();
 assert.equal(legacy.x402Version,1);
 assert.equal(legacy.accepts[0].network,"arbitrum");
 const modern=JSON.parse(Buffer.from(res.headers.get("PAYMENT-REQUIRED"),"base64").toString("utf8"));
 assert.equal(modern.x402Version,2);
 assert.equal(modern.accepts[0].network,"eip155:42161");
 assert.equal(modern.accepts[0].asset,USDC_ARB);
 assert.equal(modern.resource.url,URL);
 assert.equal(res.headers.get("cache-control"),"no-store, private");
 assert.equal(res.headers.get("vary"),"X-PAYMENT, PAYMENT-SIGNATURE");
});

test("default unpinned V1 challenge accepts V2 PAYMENT-SIGNATURE and uses one claim",async()=>{
 const f=stub(),cfg={payTo:TO,amount:"5000",network:"arbitrum",facilitator:f};
 const handler=withX402(async()=>Response.json({granted:true}),cfg);
 const ch=await handler(new Request(URL));
 const offer=JSON.parse(Buffer.from(ch.headers.get("PAYMENT-REQUIRED"),"base64")).accepts[0];
 const paid=await handler(new Request(URL,{headers:{"PAYMENT-SIGNATURE":hdr(v2Payment(offer))}}));
 assert.equal(paid.status,200);
 assert.ok(paid.headers.get("PAYMENT-RESPONSE"));
 assert.equal(f.calls.length,1);
 const replay=await handler(new Request(URL,{headers:{"X-PAYMENT":hdr(v1Payment())}}));
 assert.equal(replay.status,402);
 assert.match((await replay.json()).error,/payment_already_used/);
 assert.equal(f.calls.length,1);
});

test("default V1 and V2 HTTP requests RACE under one original claim store",async()=>{
 const f=stub(),cfg={payTo:TO,amount:"5000",network:"arbitrum",facilitator:f};
 const handler=withX402(async()=>Response.json({granted:true}),cfg);
 const ch=await handler(new Request(URL));
 const a=JSON.parse(Buffer.from(ch.headers.get("PAYMENT-REQUIRED"),"base64")).accepts[0];
 const requests=[
  new Request(URL,{headers:{"x-payment":hdr(v1Payment())}}),
  new Request(URL,{headers:{"payment-signature":hdr(v2Payment(a))}})
 ];
 const out=await Promise.all(requests.map(r=>handler(r)));
 assert.deepEqual(out.map(x=>x.status).sort(),[200,402]);
 assert.equal(f.calls.length,1);
});

test("direct gate with no pinned version recognizes the standard V2 envelope and shares claims",async()=>{
 const f=stub(),store=new MemoryClaimStore();
 const cfg={payTo:TO,amount:"5000",network:"arbitrum",facilitator:f,claimStore:store};
 const offer=await offerFor({...cfg,x402Version:2});
 const paid=await gate(URL,hdr(v2Payment(offer)),cfg);
 assert.equal(paid.paid,true);
 const replay=await gate(URL,hdr(v1Payment()),cfg);
 assert.equal(replay.paid,false);
 assert.match(replay.body.error,/payment_already_used/);
 assert.equal(f.calls.length,1);
});

test("v1-pinned route does NOT accept a V2 payload under legacy HTTP header",async()=>{
 const cfg={payTo:TO,amount:"5000",network:"arbitrum",x402Version:1,facilitator:stub()};
 const a=await offerFor({...cfg,x402Version:2});
 const h=withX402(async()=>new Response("paid"),cfg);
 const res=await h(new Request(URL,{headers:{"X-PAYMENT":hdr(v2Payment(a))}}));
 assert.equal(res.status,402);
 assert.equal(res.headers.get("PAYMENT-REQUIRED"),null);
 assert.equal(res.headers.get("PAYMENT-RESPONSE"),null);
});

test("default V1 Solana advertises no unsupported V2 EIP-3009 facilitator route",async()=>{
 const cfg={payTo:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",amount:"1",network:"solana"};
 const handler=withX402(async()=>Response.json({}),cfg);
 const r=await handler(new Request(URL));
 assert.equal(r.status,402);
 assert.equal((await r.json()).x402Version,1);
 assert.equal(r.headers.get("PAYMENT-REQUIRED"),null);
});

test("default Express V1 middleware includes a V2 payment-required quote header",async()=>{
 const cfg={payTo:TO,amount:"5000",network:"arbitrum",facilitator:stub()};
 const handler=expressX402(cfg);
 const headers={};
 const response={
  statusCode:0,body:undefined,status(n){this.statusCode=n;return this},
  json(x){this.body=x},setHeader(k,v){headers[k]=v}
 };
 await handler({url:URL,headers:{}},response,()=>{throw Error("unpaid request should not grant")});
 assert.equal(response.statusCode,402);
 assert.equal(response.body.x402Version,1);
 assert.equal(headers.Vary,"X-PAYMENT, PAYMENT-SIGNATURE");
 const decoded=JSON.parse(Buffer.from(headers["PAYMENT-REQUIRED"],"base64").toString("utf8"));
 assert.equal(decoded.x402Version,2);
 assert.equal(decoded.accepts[0].network,"eip155:42161");
});

test("default Express accepts v2 header and rejects V1 replay using same onchain nonce",async()=>{
 const f=stub(),cfg={payTo:TO,amount:"5000",network:"arbitrum",facilitator:f};
 const handler=expressX402(cfg);
 const mk=()=>({headers:{},statusCode:0,status(n){this.statusCode=n;return this},
 json(x){this.body=x},setHeader(k,v){this.headers[k]=v}});
 const challenge=mk();
 await handler({url:URL,headers:{}},challenge,()=>{throw Error("unpaid grant")});
 const accepted=JSON.parse(Buffer.from(challenge.headers["PAYMENT-REQUIRED"],"base64")).accepts[0];
 let granted=0;
 const paid=mk();
 await handler({url:URL,headers:{"payment-signature":hdr(v2Payment(accepted))}},paid,()=>granted++);
 assert.equal(granted,1);
 assert.ok(paid.headers["PAYMENT-RESPONSE"]);
 const replay=mk();
 await handler({url:URL,headers:{"x-payment":hdr(v1Payment())}},replay,()=>granted++);
 assert.equal(replay.statusCode,402);
 assert.match(replay.body.error,/payment_already_used/);
 assert.equal(granted,1);
 assert.equal(f.calls.length,1);
});

test("V2 requires absolute resource URL; an Express Host header cannot create it",async()=>{
  const f=stub();
  const cfg={payTo:TO,network:"arbitrum",amount:"5000",facilitator:f};
  const middleware=expressX402(cfg);
  const headers={};
  const reply={statusCode:0,body:null,status(n){this.statusCode=n;return this},
    json(x){this.body=x},setHeader(k,v){headers[k]=v}};
  await middleware({url:"/paid.csv",headers:{host:"attacker.example"}},reply,
    ()=>{throw Error("unpaid must not grant")});
  assert.equal(reply.statusCode,402);
  assert.equal(reply.body.x402Version,1);
  assert.equal(headers["PAYMENT-REQUIRED"],undefined,
    "never claim a V2 canonical URL using untrusted Host");
  await assert.rejects(gate("/relative.csv",null,{...cfg,x402Version:2}),/absolute HTTP/);
  assert.equal(f.calls.length,0);
});

test("Express can safely pin a canonical resourceUrl for V2 challenge and payment",async()=>{
 const f=stub();
 const cfg={payTo:TO,amount:"5000",network:"arbitrum",
   resourceUrl:URL,facilitator:f};
 const middleware=expressX402(cfg);
 const mk=()=>({headers:{},statusCode:0,body:null,status(n){this.statusCode=n;return this},
    json(x){this.body=x},setHeader(k,v){this.headers[k]=v}});
 let called=false;
 const challenge=mk();
 await middleware({url:"/paid.csv",headers:{host:"attacker.example"}},challenge,()=>called=true);
 assert.equal(challenge.statusCode,402);
 const decoded=JSON.parse(Buffer.from(challenge.headers["PAYMENT-REQUIRED"],"base64"));
 assert.equal(decoded.resource.url,URL);
 const paid=mk();
 await middleware({url:"/paid.csv",headers:{"payment-signature":hdr(v2Payment(decoded.accepts[0]))}},paid,()=>called=true);
 assert.equal(called,true);
 assert.ok(paid.headers["PAYMENT-RESPONSE"]);
 assert.equal(f.calls.length,1);
});

test("V2 cannot bypass absolute resource gate with a forged direct paid header",async()=>{
 const f=stub(),cfg={...cfgV2,facilitator:f};
 const offer=await offerFor(cfg);
 const payload=v2Payment(offer);
 delete payload.resource; // Resource is OPTIONAL in x402 V2, so must fail safely.
 await assert.rejects(gate("/relative.csv",hdr(payload),cfg),/absolute HTTP/);
 assert.equal(f.calls.length,0);
});


test("both old V1 network alias names block a new V2 claim after rolling upgrade",async()=>{
 for(const oldNetwork of ["base","eip155:8453","arbitrum","eip155:42161"]){
  const isBase=oldNetwork==="base"||oldNetwork==="eip155:8453";
  const network=isBase?"base":"arbitrum";
  const store=new MemoryClaimStore();
  assert.equal(store.claim(claimKey(oldNetwork,NONCE)),true);
  const f=stub(),cfg={...cfgV2,network,facilitator:f,claimStore:store};
  const offer=await offerFor(cfg);
  // Match target chain only; no user wallet or network calls.
  const out=await gate(URL,hdr(v2Payment(offer)),cfg);
  assert.equal(out.paid,false,oldNetwork);
  assert.match(out.body.error,/payment_already_used/);
  assert.equal(f.calls.length,0);
  // Keys tentatively claimed by the failed new attempt must be released.
  // Never release the OLD known-spent authorization.
  assert.equal(store.size,1,"old claimed alias must survive");
  assert.equal(store.claim(claimKey(oldNetwork,NONCE)),false);
 }
});

test("V2 reserves both old V1 alias keys for one real authorization",async()=>{
 assert.deepEqual(claimNetworks("base"),["base","eip155:8453"]);
 assert.deepEqual(claimNetworks("eip155:8453"),["base","eip155:8453"]);
 assert.deepEqual(claimNetworks("arbitrum"),["arbitrum","eip155:42161"]);
 assert.deepEqual(claimNetworks("eip155:42161"),["arbitrum","eip155:42161"]);
 assert.deepEqual(claimNetworks("solana"),["solana"]);
 const store=new MemoryClaimStore(),f=stub(),cfg={...cfgV2,claimStore:store,facilitator:f};
 const offer=await offerFor(cfg);
 assert.equal((await gate(URL,hdr(v2Payment(offer)),cfg)).paid,true);
 assert.equal(store.size,2);
 for(const alias of claimNetworks("arbitrum")){
  assert.equal(store.claim(claimKey(alias,NONCE)),false,alias);
 }
});

test("definite facilitator refusal releases both legacy claim aliases",async()=>{
 const store=new MemoryClaimStore(),f=stub(),cfg={...cfgV2,claimStore:store,facilitator:f};
 f.settle=async()=>({success:false,errorReason:"insufficient_funds",network:"eip155:42161"});
 const offer=await offerFor(cfg);
 const out=await gate(URL,hdr(v2Payment(offer)),cfg);
 assert.equal(out.paid,false);
 assert.match(out.body.error,/insufficient_funds/);
 assert.equal(store.size,0);
});

test("indeterminate facilitator timeout keeps BOTH legacy claim aliases",async()=>{
 const store=new MemoryClaimStore(),f=stub(),cfg={...cfgV2,claimStore:store,facilitator:f};
 f.settle=async()=>{throw new Error("network timeout")};
 const offer=await offerFor(cfg);
 const first=await gate(URL,hdr(v2Payment(offer)),cfg);
 assert.equal(first.paid,false);
 assert.match(first.body.error,/settlement_unknown/);
 assert.equal(store.size,2);
 for(const alias of claimNetworks("arbitrum")){
  assert.equal(store.claim(claimKey(alias,NONCE)),false);
 }
});

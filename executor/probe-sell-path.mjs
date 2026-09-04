/* Does the planned approval actually unblock a real sell? Simulated with state
   overrides — nothing signed, nothing sent, no key. */
const RPC="https://rpc.mainnet.chain.robinhood.com";
const NATIVE="0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
const CASHCAT="0x020bfC650A365f8BB26819deAAbF3E21291018b4";
const FROM="0x1111111111111111111111111111111111111111";
const rpc=async(m,p)=>{const r=await fetch(RPC,{method:"POST",headers:{"content-type":"application/json"},
  signal:AbortSignal.timeout(25000),body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})});
  const j=await r.json(); if(j.error) throw new Error(j.error.message); return j.result;};
const A=await import("/Users/michaelkennethbrillantes/Downloads/claude-co-robinhood/executor/approvals.mjs");

const amt=10n**18n;
const q=new URLSearchParams({tokenIn:CASHCAT,tokenOut:NATIVE,amountIn:amt.toString(),to:FROM,gasInclude:"true"});
const route=(await (await fetch(`https://aggregator-api.kyberswap.com/robinhood/api/v1/routes?${q}`,{headers:{"x-client-id":"c"}})).json()).data.routeSummary;
const built=(await (await fetch("https://aggregator-api.kyberswap.com/robinhood/api/v1/route/build",
  {method:"POST",headers:{"content-type":"application/json","x-client-id":"c"},
   body:JSON.stringify({routeSummary:route,sender:FROM,recipient:FROM,slippageTolerance:100})})).json()).data;
const ROUTER=built.routerAddress;

console.log("selling 1 CASHCAT ->", (Number(route.amountOut)/1e18).toFixed(8), "ETH  via", ROUTER, "\n");

// 1. What does the planner say, against real on-chain allowance state?
const plan=await A.planApproval(rpc,{token:CASHCAT,owner:FROM,spender:ROUTER,amount:amt});
console.log(`1. PLAN      have=${plan.have} need=${plan.need} -> ${plan.steps.length} tx (${plan.reason})`);
for (const s of plan.steps) console.log(`   approve(${ROUTER.slice(0,10)}…, ${s.amount})  ${s.data.slice(0,10)}…`);

// 2. Does the approval calldata actually execute against the token?
try{
  await rpc("eth_call",[{from:FROM,to:plan.steps.at(-1).to,data:plan.steps.at(-1).data},"latest",
    {[FROM]:{balance:"0x"+(10n**18n).toString(16)}}]);
  console.log("\n2. APPROVE   eth_call accepted");
}catch(e){ console.log("\n2. APPROVE   reverted:", e.message.slice(0,80)); }

// 3. The sell, WITHOUT the allowance — must fail.
const sellCall={from:FROM,to:ROUTER,data:built.data,gas:"0x"+(3000000).toString(16)};
const fund={balance:"0x"+(10n**18n).toString(16)};
try{ await rpc("eth_call",[sellCall,"latest",{[FROM]:fund}]);
  console.log("3. NO GRANT  accepted  <- unexpected");
}catch(e){ console.log("3. NO GRANT  reverted:", e.message.slice(0,64), " <- as expected"); }

// 4. The sell WITH balance and allowance overridden into place — must succeed.
//    Slot layout differs per token, so try the common ERC-20 layouts for balances/allowances.
const kec=async(s)=>rpc("web3_sha3",[s]);
const padA=(a)=>a.toLowerCase().replace("0x","").padStart(64,"0");
let ok=false;
for (const [balSlot,allSlot] of [[0,1],[1,2],[2,3],[3,4],[0,2],[5,6],[9,10]]) {
  const bKey=await kec("0x"+padA(FROM)+BigInt(balSlot).toString(16).padStart(64,"0"));
  const aOuter=await kec("0x"+padA(FROM)+BigInt(allSlot).toString(16).padStart(64,"0"));
  const aKey=await kec("0x"+padA(ROUTER)+aOuter.slice(2));
  const big="0x"+(amt*10n).toString(16).padStart(64,"0");
  try{
    const r=await rpc("eth_call",[sellCall,"latest",
      {[FROM]:{...fund,},[CASHCAT]:{stateDiff:{[bKey]:big,[aKey]:big}}}]);
    const out=BigInt("0x"+r.slice(2,66));
    if(out>0n){ console.log(`4. WITH GRANT accepted (balance slot ${balSlot}, allowance slot ${allSlot}) -> ${(Number(out)/1e18).toFixed(8)} ETH`); ok=true; break; }
  }catch(e){ /* wrong slot layout, try the next */ }
}
if(!ok) console.log("4. WITH GRANT could not locate this token's storage slots — inconclusive, not a failure");

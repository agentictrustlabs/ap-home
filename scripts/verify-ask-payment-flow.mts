/**
 * The conversational payment, driven end to end — spec 350 §3.5/§3.6 + spec 360 effects.
 *
 *   npx tsx scripts/verify-ask-payment-flow.mts
 *
 * alice asks "send money to bob"; the driver answers each prompt the way the Home surface does
 * (choice → pick, signature → persona-sign, authority_required → mint the mandate) until done, then
 * prints the step receipt's `effects` — the spec 360 outcome: ok:true means the payee's PERSON (via the
 * on-chain ap:charteredUnder edge) was messaged and both parties hold the PaymentReceipt record.
 */
import { toHex, type Hex } from 'viem';
import { buildDigestBindingCaveat, paymentHandler, capabilityHandler, registerDefaultSubsetHandlers, hashDelegation, ROOT_AUTHORITY, PAYMENT_RAR_TYPE, type Delegation, type MandateRequirementV1 } from '../packages/delegation/src/index.js';
registerDefaultSubsetHandlers();
const HOME='https://www.faithnet.me'; const CHAIN=34348;
const D={dm:'0x710cb1bF08C234Df397e0910331e0A29710EF4F7',timestamp:'0x73A7B878168b7DE48677617179A8bE894f0Dfe96',allowedTargets:'0x2156311097A936de1916a878bF53Bfd43c7b5715',allowedMethods:'0xdBb2E47793393C499efB0f3fcbf6Ca8669791a41',value:'0x8759c1a6cEBF1D5069e9434EF46327Bf2ef69975',payment:'0x07fA0aE59FdE4B7ce8962d6fE7a1d648ec3DD5CE',digestBinding:'0xA3bb9BCC9b2F6F2419E1aBe5ED6Fd5399b9E68e1'} as const;
const enforcers={delegationManager:D.dm,timestamp:D.timestamp,allowedTargets:D.allowedTargets,allowedMethods:D.allowedMethods,value:D.value,payment:D.payment,digestBinding:D.digestBinding} as const;
const j=async(r:Response)=>{const t=await r.text();try{return JSON.parse(t)}catch{return{_raw:t.slice(0,300)}}};
const si=await j(await fetch(`${HOME}/connect/demo-signin`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:'alice',client_id:'demo-jp'})}));
const sign=async(d:Hex):Promise<Hex>=>{const b=await j(await fetch(`${HOME}/connect/persona-sign`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${si.homeSession}`},body:JSON.stringify({digest:d})}));if(!b.signature)throw new Error(JSON.stringify(b).slice(0,200));return b.signature;};
const csrfRes=await fetch(`${HOME}/a2a/auth/csrf`,{headers:{origin:HOME}});
const csrf=await j(csrfRes) as {token?:string}; const cookie=(csrfRes.headers.get('set-cookie')??'').split(';')[0];
const ask=async(body:Record<string,unknown>)=>j(await fetch(`${HOME}/a2a/harness/ask`,{method:'POST',headers:{'content-type':'application/json',origin:HOME,cookie,'x-csrf-token':csrf.token??''},body:JSON.stringify({session:si.homeSession,addressee:si.agent,...body})}));

let r=await ask({message:'send money to bob'});
const runRef=r.reply?.runRef;
for (let turn=0; turn<8; turn++) {
  const k=r.reply?.kind;
  if (k==='prompt' && r.reply.prompt.kind==='data') {
    const f=r.reply.prompt.fields[0];
    // A CHOICE is answered by picking; a TEXT field is answered the way a person types it — including
    // the currency word, which is what "send money to bob" leads to and what used to loop.
    const pick=(f.choices??[]).find((c:{label:string})=>/^alice2|^nathan/.test(c.label))??(f.choices??[])[0];
    const value = pick ? pick.value : '1 usdc';
    console.log(`turn${turn}: answer ${f.name}=${pick ? pick.label : value}`);
    r=await ask({runRef,supplied:[{stepRef:r.reply.prompt.stepRef,data:{[f.name]:value}}]});
  } else if (k==='prompt' && r.reply.prompt.kind==='signature') {
    const pr=r.reply.prompt;
    console.log(`turn${turn}: sign approval`);
    r=await ask({runRef,supplied:[{stepRef:pr.stepRef,signature:{digest:pr.digest,signer:pr.signer,signature:await sign(pr.digest as Hex),payload:pr.payload}}]});
  } else if (k==='authority_required') {
    const req=r.reply.requirement as MandateRequirementV1;
    const handler=req.type===PAYMENT_RAR_TYPE?paymentHandler:capabilityHandler;
    const caveats=[...handler.toCaveats(req,enforcers as never),buildDigestBindingCaveat(D.digestBinding,'intent',req.intentDigest as Hex)];
    const salt=BigInt(toHex(crypto.getRandomValues(new Uint8Array(16))));
    const mandate:Delegation={delegator:r.reply.delegator,delegate:r.reply.delegate,authority:ROOT_AUTHORITY,caveats,salt,signature:'0x'};
    mandate.signature=await sign(hashDelegation(mandate,CHAIN,D.dm));
    console.log(`turn${turn}: mint mandate for ${r.reply.capability}`);
    r=await ask({runRef,presented:[{...mandate,salt:salt.toString()}]});
  } else break;
}
console.log('final:',r.reply?.kind);
const rec=(r.reply?.receipts??[])[0]??{};
console.log('effects:',JSON.stringify(rec.effects??null));

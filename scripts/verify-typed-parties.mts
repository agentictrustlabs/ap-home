/**
 * THE TYPED SUFFIX SAYS WHICH NATHAN — spec 346 (ADR-0061) meeting spec 352 F2.
 *
 *   npx tsx scripts/verify-typed-parties.mts
 *
 * Alice knows nathan.me, nathan.org, nathan.team and nathan.treasury. "Send nathan a message" and "send
 * money to nathan" are the same word and different agents, and the difference is not in the sentence — it
 * is in the CAPABILITY. A message goes to the person; money goes to the treasury.
 *
 * A pass proves the narrowing is real (two capabilities, one word, two addresses) and that what it chose
 * is SHOWN — a rule that picks silently is only as good as the person's ability to catch it being wrong.
 */
const HOME='https://www.faithnet.me';
const j=async(r:Response)=>{const t=await r.text();try{return JSON.parse(t)}catch{return{_raw:t.slice(0,250),_s:r.status}}};
const c=await fetch(`${HOME}/a2a/auth/csrf`,{headers:{origin:HOME}});
const csrf=await j(c) as {token?:string}; const cookie=(c.headers.get('set-cookie')??'').split(';')[0];
const s=await j(await fetch(`${HOME}/connect/demo-signin`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:'alice',client_id:'demo-jp'})}));
const surface={ceremonies:['data','confirmation','signature']};
for (const message of ['send nathan a message saying hello','send 1 usdc to nathan from alice2.treasury']) {
  const t:any=await j(await fetch(`${HOME}/a2a/harness/ask`,{method:'POST',headers:{'content-type':'application/json',origin:HOME,cookie,'x-csrf-token':csrf.token??''},body:JSON.stringify({session:s.homeSession,addressee:s.agent,message,surface,runRef:`t-${Date.now().toString(36)}${Math.random().toString(36).slice(2,5)}`})}));
  const r=t.reply??t;
  console.log(`\n"${message}"\n  → ${r.kind} ${r.capability??''}`);
  for (const p of r.parties??[]) console.log(`     ${p.arg}: ${p.label??p.agent} ${p.hint?`| ${p.hint}`:''}`);
  if (r.prompt) { console.log(`     ? ${r.prompt.prompt}`); for (const ch of r.prompt.fields?.[0]?.choices??[]) console.log(`        • ${ch.label}`); }
  if (r.error||r.text) console.log(`     ${String(r.error??r.text).slice(0,150)}`);
  const party = (arg:string)=>(r.parties??[]).find((p:any)=>p.arg===arg)?.label;
  if (message.includes('a message')) {
    if (party('recipient')!=='nathan.me') { console.error(`✗ a message must go to the PERSON, got ${party('recipient')}`); process.exit(1); }
  } else if (party('payee')!=='nathan.treasury') { console.error(`✗ money must go to the TREASURY, got ${party('payee')}`); process.exit(1); }
}
console.log('\n✓ the same word, two capabilities, two agents — and each one shown before it is authorized.');

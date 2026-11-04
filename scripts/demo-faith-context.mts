/** Demo-only custodian ceremony. Additive skill composition and source pointers; never copies sermon/prayer text. */
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const {composeDefinitions}=await import(pathToFileURL(resolve(process.env.SKILLS_REPO??'../skills','packages/archetype-compiler/src/index.ts')).href);
import {CONTRACTS as C} from '@agenticprimitives/contracts/deployments/faithchain';
import {hashDelegation,buildCaveat,encodeTimestampTerms,buildVaultRecordScopeCaveat,ROOT_AUTHORITY,type Delegation} from '@agenticprimitives/delegation';
import {definitionDigest,validateAgentHarnessDefinition} from '@agenticprimitives/capability-claims';
import definitions from '../apps/shared/src/faith-skills.json';
const home='https://www.faithnet.me',runtime='https://a2a.faithnet.io';
const org='0x863bd39e938ac593c8d67a11f2f6c12d824b2526';
const app='0x471890c24795a82973323b1ea6440df89c0934c5',appDelegate='0xaf1cd4c4c7fddB58e1CC31f905c46Cc0F3CE71E7'.toLowerCase();
// Scripture uses a service endpoint: an explicit audience identity is supplied by the caller/manifest, not guessed.
const ns='https://ontology.faithchain.org/faith-context#';
async function json(res:Response){const b=await res.json() as any;if(!res.ok||b.ok===false||b.error)throw new Error(`Faith ceremony ${res.status}: ${b.error??'refused'}`);return b;}
process.env.NEXT_PUBLIC_CHAIN_ID='34348';process.env.NEXT_PUBLIC_CONTRACTS_JSON=JSON.stringify(C);
process.env.NEXT_PUBLIC_INTERACTIONS_SERVICE_SA='0x39508624387fed3b9d6dd15ba86d3ace8a3f0a6a';
const {buildInteractionsGrantForScript}=await import('../apps/home/src/lib/delegation');
const report=[];
for(const handle of ((process.argv.includes('--sources-only')||process.argv.includes('--service-probe'))?['calvary']:(process.argv.includes('--personal-only')?['alice','bob']:['calvary','alice','bob']))){
 const login=await json(await fetch(home+'/connect/demo-signin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle,client_id:'demo-web'})}));
 const owner=handle==='calvary'?org:login.agent.toLowerCase(),role=handle==='calvary'?'org':'person';
 const sign=async(digest:string)=>(await json(await fetch(home+'/connect/persona-sign',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${login.homeSession}`},body:JSON.stringify({digest})}))).signature;
 if(!process.argv.includes('--probe-only')){
  const d:Delegation={delegator:owner,delegate:owner,authority:ROOT_AUTHORITY,caveats:[buildCaveat(C.timestampEnforcer,encodeTimestampTerms(0,Math.floor(Date.now()/1000)+3600)),buildVaultRecordScopeCaveat([{server:'demo-mcp',resources:['vault:archetype.assignment','vault:faith.context:manifest'],ops:['read','write']},{server:'demo-mcp',resources:['vault:church.sermon:*','vault:church.sermon-insight:*'],ops:['read']}])],salt:BigInt('0x'+crypto.randomUUID().replace(/-/g,'')),signature:'0x'};
  d.signature=await sign(hashDelegation(d,34348,C.delegationManager));const wire={...d,salt:d.salt.toString()};
  const vault=async(method:string,recordType:string,data?:unknown)=>json(await fetch('https://edge.faithnet.io/mcp/vault/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({delegation:wire,requester:owner,recordType,...(data!==undefined?{data}:{})})}));
  const unwrap=(r:any)=>r.data??r.record??null;
  const held=unwrap(await vault('get','archetype.assignment'));
  if(!held?.definition)throw new Error(`${handle}: existing playbook missing; refusing replacement`);
  const addition=role==='org'?definitions.church:definitions.person;
  // Use the shared compiler's composition identity. Keeping the default archetype ID lets Home's
  // default refresh erase the added capability during the next Connect session.
  let base=held.definition;
  const installed=base.archetypeId.includes('+'+addition.archetypeId);
  const current=installed&&Object.entries(addition.sourceCommitments).every(([k,v])=>base.sourceCommitments[k]===v);
  if(installed&&!current){
   // Upgrade only the pack this ceremony appended. Refuse unfamiliar compositions rather than
   // replacing a person's other roles. Composition itself still belongs to the shared compiler.
   const suffix='+'+addition.archetypeId,marker='\n\n## As '+addition.archetypeId+'\n\n';
   const start=base.instructions.indexOf(marker);
   if(!base.archetypeId.endsWith(suffix)||start<0||base.instructions.indexOf('\n\n## As ',start+marker.length)>=0)throw new Error('Faith pack is not the final composition; upgrade it through its original composition owner');
   const baseId=base.archetypeId.slice(0,-suffix.length),commitments={...base.sourceCommitments};
   for(const key of [...Object.keys(addition.sourceCommitments),'part:'+addition.archetypeId,'part:'+baseId])delete commitments[key];
   base={...base,archetypeId:baseId,instructions:base.instructions.slice(0,start),tools:base.tools.filter((t:any)=>!addition.tools.some(a=>a.id===t.id)),sourceCommitments:commitments};
  }
  const composed=current?{definition:held.definition,digest:held.definitionDigest}:composeDefinitions(
   {ref:base.archetypeId,definition:base,digest:definitionDigest(base)},
   [{ref:addition.archetypeId,definition:addition,digest:definitionDigest(addition as never)}]);
  const definition=composed.definition;
  if(!validateAgentHarnessDefinition(definition).ok)throw new Error('Invalid composed playbook');
  if(!process.argv.includes('--sources-only'))await vault('set','archetype.assignment',{...held,archetypeId:definition.archetypeId,archetypeVersion:definition.archetypeVersion,definition,definitionDigest:composed.digest});
  const previous=unwrap(await vault('get','faith.context:manifest'));
  if(previous&&(previous.owner!==owner||previous.role!==role))throw new Error('Existing manifest owner mismatch');
  const entries=new Map((previous?.entries??[]).map((e:any)=>[e.recordType,e]));
  if(role==='person'){
   // Existing answer settings only. No manufactured prayer, journey, age or maturity profile.
   entries.set('person.preferences',{recordType:'person.preferences',class:'https://agenticprimitives.dev/ns/context#PersonPreferences',category:'guidance',fields:['/answer/language','/answer/style'],release:{visibility:'recipients',recipients:[app,appDelegate,org,'0x3064d88922223881b206dcab68b992b9b2ba90b2'],purposes:['faith-ask']}});
  }else{
   for(const id of ['campus_messages_msg_2606','campus_messages_msg_2605','campus_messages_msg_2604']){
    const key='church.sermon:'+id;const r=unwrap(await vault('get',key));if(!r?.data)throw new Error('Missing sermon '+id);
    const data=r.data;
    for(const ref of [data.transcriptRecordId,data.summaryRecordId].filter(Boolean)){
     if(!/^[a-zA-Z0-9_:-]+$/.test(ref))throw new Error('Invalid sermon source reference');
     const linkedKey='church.sermon:'+ref;const linked=unwrap(await vault('get',linkedKey));
     if(!linked?.data)continue;
     console.log(JSON.stringify({source:linkedKey,fields:Object.keys(linked.data),class:linked['@type']}));
     entries.set(linkedKey,{recordType:linkedKey,class:linked['@type'],category:'sermon',fields:['/title','/data/text','/data/transcript','/data/description','/data/summary'],campusIds:data.campusIds??[data.campusId].filter(Boolean),date:String(data.preachedDate??data.publishedAt).slice(0,10),passages:[data.passage].filter(Boolean),release:{visibility:'public',recipients:[],purposes:['faith-ask']}});
    }
    entries.set(key,{recordType:key,class:r['@type'],category:'sermon',fields:['/title','/data/speaker','/data/publishedAt','/data/passage','/data/series','/data/publicationUrl','/data/url','/data/description','/data/transcriptText'],campusIds:data.campusIds??[data.campusId].filter(Boolean),date:String(data.preachedDate??data.publishedAt).slice(0,10),passages:[data.passage].filter(Boolean),release:{visibility:'public',recipients:[],purposes:['faith-ask']}});
   }
  }
  await vault('set','faith.context:manifest',{'@type':ns+'ContextManifest',owner,role,version:1,revision:crypto.randomUUID(),updatedAt:new Date().toISOString(),entries:[...entries.values()]});
  if(process.argv.includes('--sources-only'))continue;
  const {grant,sessionLeaf}=await buildInteractionsGrantForScript(owner,sign,async path=>json(await fetch(home+'/a2a'+path)));
  const cr=await fetch(home+'/a2a/auth/csrf',{headers:{origin:home}}),csrf=await json(cr);
  await json(await fetch(home+`/a2a/interactions/${owner}/grant`,{method:'POST',headers:{'content-type':'application/json',origin:home,cookie:(cr.headers.get('set-cookie')??'').split(';')[0]??'','x-csrf-token':csrf.token??''},body:JSON.stringify({delegation:grant,sessionLeaf})}));
  console.log(JSON.stringify({handle,owner,skill:role==='org'?'church.context.prepare':'faith.context.prepare',installed:true}));
 }
 if(process.argv.includes('--install-only'))continue;
 const toolId=role==='org'?'church.context.prepare':'faith.context.prepare';
 const start=Date.now();
 const cr=await fetch(runtime+'/auth/csrf',{headers:{origin:home}}),csrf=await json(cr);
 const response=await json(await fetch(runtime+'/harness/ask',{method:'POST',headers:{'content-type':'application/json',origin:home,cookie:(cr.headers.get('set-cookie')??'').split(';')[0]??'','x-csrf-token':csrf.token??''},body:JSON.stringify({session:login.homeSession,addressee:owner,message:role==='org'?'Who spoke at Calvary this week?':'Prepare my permitted faith context',rowsOnly:true,plan:{steps:[{id:'faith',toolId,args:{question:process.argv.includes('--service-probe')?'What are Sunday service times at my campus? Name the campus.':'Who spoke at Calvary this week?',recipients:app,purpose:'faith-ask',...(process.argv.includes('--service-probe')?{campusId:'campus_erie'}:{})}}]}})}));
 if(process.argv.includes('--service-probe'))writeFileSync('/tmp/church-faith-org-probe.json',JSON.stringify(response,null,2));
 const contribution=response.reply?.results?.find((r:any)=>r.toolId===toolId)?.result;
 if(contribution?.refused)console.log(JSON.stringify({playbook:response.reply?.plannerTrace?.playbook,unreadable:response.reply?.plannerTrace?.playbookUnreadable}));
 if(!response.runRef||contribution?.refused||contribution?.status!=='ready')throw new Error(`${handle}: no successful contribution: ${JSON.stringify(response.reply).slice(0,500)}`);
 report.push({handle,owner,runRef:response.runRef,durationMs:Date.now()-start,skill:toolId,sourceCount:contribution.sources.length,sourceKeys:contribution.sources.map((s:any)=>s.recordType),manifestRevision:contribution.manifestRevision});
 console.log(JSON.stringify(report.at(-1)));
}
if(report.length)writeFileSync(resolve('docs/faith/live-intent-evidence.json'),JSON.stringify({checkedAt:new Date().toISOString(),runs:report},null,2)+'\n');

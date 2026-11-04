/** Live demo acceptance: create a clearly labelled fixture through person.faith.*, verify sharing, then remove it. */
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {definitionDigest,validateAgentHarnessDefinition} from '@agenticprimitives/capability-claims';
import {CONTRACTS as C} from '@agenticprimitives/contracts/deployments/faithchain';
import {hashDelegation,buildCaveat,encodeTimestampTerms,buildVaultRecordScopeCaveat,ROOT_AUTHORITY,type Delegation} from '@agenticprimitives/delegation';
const home='https://www.faithnet.me',runtime='https://a2a.faithnet.io';
const app='0x471890c24795a82973323b1ea6440df89c0934c5',church='0x863bd39e938ac593c8d67a11f2f6c12d824b2526',scripture='0x3064d88922223881b206dcab68b992b9b2ba90b2';
async function json(response:Response){const body=await response.json() as any;if(!response.ok||body.error)throw new Error(`Runtime request refused (${response.status}): ${body.error??'unknown'}`);return body;}
async function csrfRequest(){for(let attempt=0;;attempt++){try{return await fetch(runtime+'/auth/csrf',{headers:{origin:home}});}catch(error){if(attempt>=2)throw error;}}}
const login=await json(await fetch(home+'/connect/demo-signin',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({handle:'alice',client_id:'demo-web'})}));
const owner=login.agent.toLowerCase();
// The writer is Seed's existing skill artifact, composed temporarily for this acceptance check.
// Only its custodian changes the assignment; restore it afterwards without overwriting concurrent edits.
const vault=async(method:string,data?:unknown)=>{
 const cr=await csrfRequest(),csrf=await json(cr);
 const result=await json(await fetch(runtime+`/interactions/${owner}/channels.archetypeAssignment.${method==='get'?'get':'put'}`,{method:'POST',headers:{'content-type':'application/json',origin:home,cookie:(cr.headers.get('set-cookie')??'').split(';')[0]??'','x-csrf-token':csrf.token??''},body:JSON.stringify({session:login.homeSession,...(data?{record:data}:{})})}));
 return {...result,data:result.record};
};
const held=(await vault('get')).data;
assert.ok(held?.definition,'An existing playbook is required');
let installedDigest:string|undefined;
if(!held.definition.tools.some((t:any)=>t.id==='person.faith.journey.record')){
 assert.ok(process.env.FAITH_WRITER_DEFINITION,'Supply the compiled Seed journey-writer skill via FAITH_WRITER_DEFINITION');
 const writer=JSON.parse(readFileSync(process.env.FAITH_WRITER_DEFINITION,'utf8'));
 assert.deepEqual(validateAgentHarnessDefinition(writer),{ok:true,errors:[]},'Writer artifact must satisfy the current AP contract before assignment');
 const {composeDefinitions}=await import(pathToFileURL(resolve(process.env.SKILLS_REPO??'../skills','packages/archetype-compiler/src/index.ts')).href);
 const composed=composeDefinitions({ref:held.archetypeId,definition:held.definition,digest:held.definitionDigest},[{ref:writer.archetypeId,definition:writer,digest:definitionDigest(writer)}]);
 assert.equal(validateAgentHarnessDefinition(composed.definition).ok,true);
 installedDigest=composed.digest;
 await vault('set',{...held,archetypeId:composed.definition.archetypeId,definition:composed.definition,definitionDigest:composed.digest});
}
const evidence:Array<Record<string,unknown>>=[];
async function ask(toolId:string,args:Record<string,unknown>,message:string){
 const csrfResponse=await csrfRequest(),csrf=await json(csrfResponse);
 const response=await json(await fetch(runtime+'/harness/ask',{method:'POST',headers:{'content-type':'application/json',origin:home,cookie:(csrfResponse.headers.get('set-cookie')??'').split(';')[0]??'','x-csrf-token':csrf.token??''},body:JSON.stringify({session:login.homeSession,addressee:login.agent,message,rowsOnly:true,plan:{steps:[{id:'check',toolId,args}]}})}));
 const result=response.reply?.results?.find((r:any)=>r.toolId===toolId)?.result;
 assert.ok(response.runRef,'Expected a real runtime run');if(args.remove&&String(result?.refused??'').startsWith('there is no journey record'))return {alreadyRemoved:true};if(result?.refused)console.log(JSON.stringify({toolId,refused:result.refused,playbook:response.reply?.plannerTrace?.playbook,unreadable:response.reply?.plannerTrace?.playbookUnreadable}));assert.ok(result&&!result.refused,JSON.stringify(result));
 evidence.push({toolId,runRef:response.runRef});return result;
}
const ids:string[]=[];
const note='Temporary automated acceptance fixture; not biographical data. Removed by the test.';
async function orphanedFixtures(){
 const grant:Delegation={delegator:owner,delegate:owner,authority:ROOT_AUTHORITY,caveats:[buildCaveat(C.timestampEnforcer,encodeTimestampTerms(0,Math.floor(Date.now()/1000)+600)),buildVaultRecordScopeCaveat([{server:'demo-mcp',resources:['vault:faith.journey-stage:*'],ops:['read']}])],salt:BigInt('0x'+crypto.randomUUID().replace(/-/g,'')),signature:'0x'};
 grant.signature=(await json(await fetch(home+'/connect/persona-sign',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${login.homeSession}`},body:JSON.stringify({digest:hashDelegation(grant,34348,C.delegationManager)})}))).signature;
 const read=async(op:string,args:Record<string,unknown>={})=>json(await fetch('https://edge.faithnet.io/mcp/vault/'+op,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({delegation:{...grant,salt:grant.salt.toString()},requester:owner,...args})}));
 const keys=(await read('list')).records.map((r:any)=>r.record_type).filter((key:string)=>key.startsWith('faith.journey-stage:'));
 if(!keys.length)return [];
 const records=(await read('get-many',{recordTypes:keys})).records;
 return keys.filter((key:string)=>records[key]?.aboutSubject===owner&&records[key]?.note===note&&!records[key]?.removedAt).map((key:string)=>key.slice('faith.journey-stage:'.length));
}
async function remove(id:string){for(let attempt=0;;attempt++){try{await ask('person.faith.journey.record',{remove:id},'As demo Alice, remove the temporary acceptance fixture.');return;}catch(error){if(attempt>=2||!(error instanceof TypeError))throw error;}}}
const probe=()=>ask('faith.context.prepare',{question:'Help me understand my next step in faith',purpose:'faith-ask',recipients:[app,church,scripture].join(',')},'Prepare only my permitted context for this automated acceptance test.');
try{
 for(const orphan of await orphanedFixtures())await remove(orphan);
 const id=crypto.randomUUID(),key='faith.journey-stage:'+id;ids.push(id);
 const opened=await ask('person.faith.journey.record',{id,stage:'NewBeliever',visibility:'Open',note},'As demo Alice, record this temporary acceptance fixture with Open visibility.');
 assert.equal(opened.recorded.stage.id,id);
 assert.ok((await probe()).sources.some((s:any)=>s.recordType===key&&s.fields.some((f:any)=>f.path==='/stage'&&f.value==='NewBeliever')),'Open native record must contribute');
 const privateId=crypto.randomUUID();ids.push(privateId);
 const closed=await ask('person.faith.journey.record',{id:privateId,stage:'NewBeliever',visibility:'Confidential',note},'As demo Alice, record a new temporary acceptance stage that is Confidential.');
 assert.equal(closed.recorded.stage.id,privateId);
 assert.ok(!(await probe()).sources.some((s:any)=>ids.some(id=>s.recordType==='faith.journey-stage:'+id)),'The confidential current stage must not expose itself or superseded public history');
}finally{
 try{for(const id of ids)await remove(id);}
 finally{if(installedDigest){assert.equal((await vault('get')).data?.definitionDigest,installedDigest,'Assignment changed concurrently; refusing to overwrite it');await vault('set',held);}}
}
assert.ok(!(await probe()).sources.some((s:any)=>ids.some(id=>s.recordType==='faith.journey-stage:'+id)),'Removed record must not contribute');
writeFileSync('docs/faith/native-record-evidence.json',JSON.stringify({checkedAt:new Date().toISOString(),person:login.agent,checks:['Open record contributed','Confidential change withheld it','Fixture removed'],runs:evidence},null,2)+'\n');
console.log('Native person faith records: Open release, Confidential revocation, and cleanup verified.');

import {describe,it,expect,vi} from 'vitest';
import {faithContextInvoker,FAITH_MANIFEST,FAITH_NS,FAITH_TOOLS} from '../src/faith-context.js';
import {harnessInvoker} from '../src/harness-run.js';
import {validateAgentHarnessDefinition,definitionDigest} from '@agenticprimitives/capability-claims';
import definitions from '../../shared/src/faith-skills.json';
import {FAITH_CLASS,FAITH_RECORD} from '../src/faith-records.js';
const me='0x'+'1'.repeat(40),org='0x'+'2'.repeat(40),app='0x'+'3'.repeat(40),scripture='0x'+'4'.repeat(40),other='0x'+'5'.repeat(40);
const cls='https://ontology.faithchain.org/incubator#PrayerRequest';
const source={recordType:'faith.prayer:one',class:cls,category:'prayer',fields:['/text'],release:{visibility:'recipients',recipients:[app,scripture],purposes:['faith-ask']}};
const manifest=(entries:unknown[]=[source],role='person',owner=me)=>({'@type':FAITH_NS+'ContextManifest',owner,role,version:1,revision:'1',updatedAt:new Date().toISOString(),entries});
const args={question:'Help me pray',purpose:'faith-ask',recipients:scripture};
function setup(m:unknown=manifest(),role='person',owner=me,records:Record<string,unknown>={'faith.prayer:one':{'@type':cls,owner:me,text:'Please help me be patient.',private:'must not leave'}}){
 const read=vi.fn(async(_owner:string,key:string)=>({ok:true,data:key===FAITH_MANIFEST?m:records[key]??null}));
 const call=faithContextInvoker({readSubjectRecordStatus:read,addresseeKind:role,faithReceivers:[app]},me,owner);
 return {read,call:(a:Record<string,unknown>=args)=>call(role==='person'?'faith.context.prepare':'church.context.prepare',a,{} as never)};
}
describe('faith intent release before retrieval',()=>{
 it('projects only released fields and binds recipients, source and skill',async()=>{const {call}=setup();const r=await call() as any;expect(r.sources[0].fields).toEqual([{path:'/text',value:'Please help me be patient.',truncated:false,start:0,end:26}]);expect(r.recipients).toEqual([scripture,app]);expect(r.skill.commitments).toBeTruthy();expect(JSON.stringify(r)).not.toContain('must not leave');});
 for(const [label,release] of [['private',{visibility:'private'}],['revoked',{revoked:true}],['expired',{expiresAt:'2020-01-01T00:00:00.000Z'}],['missing app',{recipients:[scripture]}],['missing downstream',{recipients:[app]}],['personal public',{visibility:'public'}]] as const){
  it(`${label} is never fetched or disclosed`,async()=>{const {call,read}=setup(manifest([{...source,recordType:'faith.prayer:SECRET',release:{...source.release,...release}}]));const r=await call();expect(read).toHaveBeenCalledTimes(1);expect(JSON.stringify(r)).not.toContain('SECRET');});
 }
 it('cannot omit the authenticated app to release to self',async()=>{const {call,read}=setup(manifest([{...source,release:{...source.release,recipients:[me]}}]));expect((await call({...args,recipients:me}) as any).sources).toEqual([]);expect(read).toHaveBeenCalledTimes(1);});
 it('does not treat grant failure as absent context',async()=>{const call=faithContextInvoker({addresseeKind:'person',readSubjectRecordStatus:async()=>({ok:false,data:null})},me,me);await expect(call('faith.context.prepare',args,{} as never)).rejects.toThrow('could not be read');});
 it('rejects another person and mismatched owner',async()=>{const read=vi.fn();expect(await faithContextInvoker({addresseeKind:'person',readSubjectRecordStatus:read},other,me)('faith.context.prepare',args,{} as never)).toHaveProperty('refused');expect(read).not.toHaveBeenCalled();expect(await setup(manifest([source],'person',other)).call()).toHaveProperty('refused');});
 it('refuses arbitrary extra subject selection',async()=>{expect(await setup().call({...args,subject:other})).toHaveProperty('refused');});
 it('does not allow manifest pointers into credentials',async()=>{const {call,read}=setup(manifest([{...source,recordType:'credentials.private'}]));expect((await call() as any).sources).toEqual([]);expect(read).toHaveBeenCalledTimes(1);});
 it('rejects wrong-class and wrong-owner source data',async()=>{const wrong=setup(manifest(),undefined,undefined,{'faith.prayer:one':{'@type':cls,owner:other,text:'secret'}});await expect(wrong.call()).rejects.toThrow('owner');const c=setup(manifest(),undefined,undefined,{'faith.prayer:one':{'@type':'https://example.org/Secret',text:'secret'}});expect((await c.call() as any).sources).toHaveLength(0);});
 it('bounds excerpts and never serializes nested objects',async()=>{const x=setup(manifest([{...source,fields:['/text','/nested']}]),undefined,undefined,{'faith.prayer:one':{'@type':cls,owner:me,text:'a'.repeat(5000),nested:{secret:'sensitive'}}});const r=await x.call() as any;expect(r.sources[0].fields).toHaveLength(1);expect(r.sources[0].fields[0].value.length).toBe(1200);expect(r.sources[0].fields[0].truncated).toBe(true);});
 it('fresh reads reflect revocation on next request',async()=>{let m=manifest();const read=vi.fn(async(_s:string,k:string)=>({ok:true,data:k===FAITH_MANIFEST?m:{'@type':cls,owner:me,text:'released'}}));const call=faithContextInvoker({readSubjectRecordStatus:read,addresseeKind:'person',faithReceivers:[app]},me,me);expect((await call('faith.context.prepare',args,{} as never) as any).sources).toHaveLength(1);m=manifest([{...source,release:{...source.release,revoked:true}}]);expect((await call('faith.context.prepare',args,{} as never) as any).sources).toHaveLength(0);expect(read).toHaveBeenCalledTimes(3);});
 it('organization reads own public sources and honors campus and date',async()=>{const sermon={...source,recordType:'church.sermon:one',class:'https://churchcore.ai/ontology/church#Sermon',category:'sermon',campusIds:['erie'],date:'2026-11-01',release:{visibility:'public',purposes:['faith-ask']}};const x=setup(manifest([sermon],'org',org),'org',org,{'church.sermon:one':{'@type':sermon.class,owner:org,text:'Church teaching'}});expect((await x.call({...args,campusId:'boulder'}) as any).sources).toHaveLength(0);const result=await x.call({...args,campusId:'erie',date:'2026-11-01'}) as any;expect(result.sources).toHaveLength(1);expect(result.scope).toMatchObject({campusId:'erie',date:'2026-11-01'});expect(x.read.mock.calls.every(c=>c[0]===org)).toBe(true);});
 it('missing manifest is explicitly not configured',async()=>{expect(await setup(null).call()).toHaveProperty('status','not-configured');});
 it('only an assigned skill can be invoked inside the harness',async()=>{const invoke=harnessInvoker({addresseeKind:'person'} as never,{} as never,null,vi.fn(),me as never,undefined,undefined,me as never,null);expect(await invoke('faith.context.prepare',args,{step:{id:'faith',toolId:'faith.context.prepare',args},index:0,intent:{goal:'faith context'},operationId:'test'} as never)).toHaveProperty('refused');});
 it('compiled artifacts are valid and contain the executable capabilities',()=>{for(const d of Object.values(definitions)){expect(validateAgentHarnessDefinition(d).ok).toBe(true);expect(definitionDigest(d as never)).toMatch(/^0x/);expect(d.tools[0]?.source?.contractDigest).not.toMatch(/^id:/);}expect(FAITH_TOOLS.map(t=>t.id)).toEqual(['faith.context.prepare','church.context.prepare']);});
});
describe('Seed faith records in collaborative context',()=>{
 const stageKey=FAITH_RECORD.stage+':current',prayerKey=FAITH_RECORD.prayer+':current';
 function native(records:Record<string,unknown>){
  const read=vi.fn(async(_owner:string,key:string)=>({ok:true,data:records[key]??null}));
  const survey=vi.fn(async()=>Object.keys(records).map(recordType=>({recordType})));
  const invoke=faithContextInvoker({addresseeKind:'person',faithReceivers:[app],readSubjectRecordStatus:read,survey},me,me);
  return {call:()=>invoke('faith.context.prepare',args,{} as never),read};
 }
 it('uses Open records written by person.faith.* without requiring a second manifest',async()=>{
  const {call}=native({[stageKey]:{'@type':FAITH_CLASS.stage,aboutSubject:me,stage:'NewBeliever',assertedAt:'2026-11-03T00:00:00Z',visibility:'Open'},[prayerKey]:{'@type':FAITH_CLASS.prayer,aboutSubject:me,label:'Patience',description:'Help me be patient.',visibility:'Open',privateInternal:'not a release field'}});
  const result=await call() as any;expect(result.status).toBe('ready');expect(result.sources).toHaveLength(2);expect(result.sources[0]).toMatchObject({recordType:stageKey,category:'guidance'});expect(JSON.stringify(result)).toContain('NewBeliever');expect(JSON.stringify(result)).not.toContain('privateInternal');
 });
 it('does not widen confidential or audience-specific records to the app and Scripture agent',async()=>{
  for(const visibility of ['Confidential','BodyOnly','Friends','LeadersOnly',undefined]){
   const {call}=native({[prayerKey]:{'@type':FAITH_CLASS.prayer,aboutSubject:me,label:'SECRET',visibility,sharedWith:[org]}});
   const result=await call() as any;expect(result.sources).toEqual([]);expect(JSON.stringify(result)).not.toContain('SECRET');expect(result).not.toHaveProperty('withheld');
  }
 });
 it('does not share old stage history when the current stage is private',async()=>{
  const {call}=native({[stageKey]:{'@type':FAITH_CLASS.stage,aboutSubject:me,stage:'Growing',assertedAt:'2026-11-03T00:00:00Z',visibility:'Confidential'},[FAITH_RECORD.stage+':older']:{'@type':FAITH_CLASS.stage,aboutSubject:me,stage:'Seeker',assertedAt:'2026-10-01T00:00:00Z',visibility:'Open'}});
  expect((await call() as any).sources).toEqual([]);
 });
 it('rejects removed, wrong-class and cross-person native records',async()=>{
  for(const extra of [{removedAt:'2026-11-03T00:00:00Z'},{'@type':FAITH_CLASS.care},{aboutSubject:other}]){
   expect((await native({[prayerKey]:{'@type':FAITH_CLASS.prayer,aboutSubject:me,label:'SECRET',visibility:'Open',...extra}}).call() as any).sources).toEqual([]);
  }
 });
 it('fresh inline visibility changes revoke disclosure on the next request',async()=>{
  const record={'@type':FAITH_CLASS.prayer,aboutSubject:me,label:'Patience',visibility:'Open'};
  const {call}=native({[prayerKey]:record});expect((await call() as any).sources).toHaveLength(1);record.visibility='Confidential';expect((await call() as any).sources).toHaveLength(0);
 });
 it('bounds reads and never reads care requests for general collaborative Ask',async()=>{
  const records=Object.fromEntries(Array.from({length:40},(_,i)=>[`${FAITH_RECORD.prayer}:${i}`,{'@type':FAITH_CLASS.prayer,aboutSubject:me,label:'Patience',visibility:'Open'}]));
  records[FAITH_RECORD.care+':private']={'@type':FAITH_CLASS.care,aboutSubject:me,label:'SECRET',visibility:'Open'};
  const {read,call}=native(records);const result=await call() as any;expect(result.sources.length).toBeLessThanOrEqual(8);expect(read).toHaveBeenCalledTimes(33);expect(read.mock.calls.some(([,key])=>key.startsWith(FAITH_RECORD.care))).toBe(false);
 });
});

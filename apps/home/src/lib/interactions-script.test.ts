import {describe,it,expect,vi} from 'vitest';
vi.hoisted(()=>{process.env.NEXT_PUBLIC_CHAIN_ID='34348';process.env.NEXT_PUBLIC_VAULT_SERVER_ID='demo-mcp';});
import {buildInteractionsGrantForScript,PERSON_INTERACTIONS_SESSION_LEAF_TTL_SECONDS,ORG_INTERACTIONS_SESSION_LEAF_TTL_SECONDS} from './delegation';
import {CONTRACTS} from './chain';
import {decodeTimestampTerms} from '@agenticprimitives/delegation';
const owner='0x'+'1'.repeat(40),delegate='0x'+'2'.repeat(40);
describe('operator enable lifetime',()=>{
 it('uses the organization lifetime when a verified steward enables an organization',async()=>{const sign=vi.fn(async()=> '0x12'),get=async()=>({ok:true,address:delegate});const person=await buildInteractionsGrantForScript(owner,sign,get),org=await buildInteractionsGrantForScript(owner,sign,get,'org');const end=(wire:any)=>decodeTimestampTerms(wire.caveats.find((c:any)=>c.enforcer.toLowerCase()===CONTRACTS.timestampEnforcer.toLowerCase()).terms).validUntil;expect(Number(end(org.sessionLeaf))-Number(end(person.sessionLeaf))).toBeCloseTo(ORG_INTERACTIONS_SESSION_LEAF_TTL_SECONDS-PERSON_INTERACTIONS_SESSION_LEAF_TTL_SECONDS,-1);expect(org.grant.delegator).toBe(owner);});
});

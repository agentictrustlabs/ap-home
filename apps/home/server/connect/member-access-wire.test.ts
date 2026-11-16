import {it,expect} from 'vitest';
import {scopedWireFor} from './channels';
const person='0x1111111111111111111111111111111111111111',org='0x2222222222222222222222222222222222222222';
const env=(link:unknown)=>({AUTH_CODES:{get:async()=>JSON.stringify(link)}}) as never;
it('presents org-to-member data authority rather than member-to-org consent',async()=>{
 const consent={delegator:person,delegate:org},access={delegator:org,delegate:person};
 expect(await scopedWireFor(env({membershipDelegation:consent,memberAccessDelegation:access}),person,org)).toEqual(access);
 expect(await scopedWireFor(env({membershipDelegation:consent}),person,org)).toBeNull();
 expect(await scopedWireFor(env({memberAccessDelegation:{delegator:org,delegate:org}}),person,org)).toBeNull();
});

import {it,expect} from 'vitest';
import {decodeVaultRecordScopeTerms,vaultRecordScopeAllows,VAULT_RECORD_SCOPE_ENFORCER} from '@agenticprimitives/delegation';
import {issueOrganizationLibraryMemberAccessDelegation} from './delegation';
it('member access permits only the shared plan, index and org profile; no other documents, private notes or payments',async()=>{
 const org='0x1111111111111111111111111111111111111111',person='0x2222222222222222222222222222222222222222';
 const wire=await issueOrganizationLibraryMemberAccessDelegation(org,person,['family-field-plan-v1'],'test-vault',async()=>'0xab');
 const scope=wire.caveats.find(c=>c.enforcer.toLowerCase()===VAULT_RECORD_SCOPE_ENFORCER.toLowerCase())!;
 const grants=decodeVaultRecordScopeTerms(scope.terms);
 const allowed=(resource:string,op:'read'|'write')=>vaultRecordScopeAllows(grants,{server:'test-vault',resource,op});
 expect(wire.delegator).toBe(org);expect(wire.delegate).toBe(person);
 expect(allowed('vault:content.artifact.family-field-plan-v1','read')).toBe(true);expect(allowed('vault:content.artifact.family-field-plan-v1','write')).toBe(true);
 expect(allowed('vault:content.artifact.private','read')).toBe(false);expect(allowed('vault:impact-profile','read')).toBe(false);expect(allowed('vault:org.profile','write')).toBe(false);expect(allowed('vault:treasury','write')).toBe(false);
 await expect(issueOrganizationLibraryMemberAccessDelegation(org,person,['*'],'test-vault',async()=>'0xab')).rejects.toThrow();
});

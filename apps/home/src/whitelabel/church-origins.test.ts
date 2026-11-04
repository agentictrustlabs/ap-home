import {describe,it,expect} from 'vitest';
import {provisionsCommunityMessaging,reusesStandingGrantWithSelfVault,sharesEmailClaim} from './provisioning';
import {whitelabel} from './config';
import {getClient,clientAllowsRedirect,clientAllowsTemplate,isAllowedRelyingOrigin} from '../lib/oidc-clients';
describe('church portal sign-in registration',()=>{
 const church=getClient('ap-church')!;
 it('returns to the canonical church origin and retains the explicit legacy/local callbacks',()=>{
  expect(church.redirect_uris[0]).toBe('https://church.faithnet.io/');
  for(const origin of ['https://church.faithnet.io','https://ap-church-a2a-faithnet.richardpedersen3.workers.dev','http://localhost:5178','http://127.0.0.1:5178']){
   expect(clientAllowsRedirect(church,origin+'/')).toBe(true);expect(isAllowedRelyingOrigin(origin)).toBe(true);
  }
 });
 it('refuses lookalike hosts and unregistered callback paths',()=>{
  expect(clientAllowsRedirect(church,'https://church.faithnet.io.evil.example/')).toBe(false);
  expect(clientAllowsRedirect(church,'https://church.faithnet.io/other')).toBe(false);
  expect(isAllowedRelyingOrigin('https://evilchurch.faithnet.io')).toBe(false);
 });
 it('grants sign-in and personal Ask while leaving church authority separate',()=>{
  expect(church.allowed_delegation_templates).toEqual(['site-login', 'ask-as-me']);
  expect(clientAllowsTemplate(church,'org-create')).toBe(false);
  expect(church.operational_delegate).toBeUndefined();expect(church.org_read_grant).toBeUndefined();expect(church.self_vault_grant).toEqual({server:'demo-mcp',resources:['vault:church.*'],ops:['read','write']});
 });
 it('keeps church connect focused on church records without unrelated messaging or email sharing',()=>{expect(provisionsCommunityMessaging('ap-church')).toBe(false);expect(reusesStandingGrantWithSelfVault('ap-church')).toBe(true);expect(sharesEmailClaim(church)).toBe(false);});
 it('keeps existing relying applications registered',()=>{for(const client of ['gather-app','skills-app','pokernight','town-app'])expect(whitelabel.relyingApps.some(a=>a.client_id===client)).toBe(true);});
});

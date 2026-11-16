'use client';
// One relying-app request. The app chooses a recipient; Home alone signs the invitation or acceptance.
import { useEffect, useState } from 'react';
import type { Address } from '@agenticprimitives/types';
import { useSession } from '../../../src/context/session';
import { resolveVia, signHashFor } from '../../../src/home/onboarding';
import { inviteThroughHarness } from '../../../src/home/invite-harness';
import { recordInvitation } from '../../../src/home/ask-record';
import { joinOrganization } from '../../../src/home/join-organization';
import { issueOrganizationLibraryMemberAccessDelegation, toWire } from '../../../src/lib/delegation';
import { MCP_SERVER_ID } from '../../../src/lib/inbox-delivery';
import { whitelabel } from '../../../src/whitelabel/config';

const address = (s: string): s is Address => /^0x[0-9a-fA-F]{40}$/.test(s);
export default function OrganizationInvitationPage() {
  const { session, agentAddress, agentName, personName, profile } = useSession();
  const [request, setRequest] = useState<{org: Address; person?: Address; label: string; artifacts: string[]; appName: string; returnTo: string; join: boolean} | null>(null);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [done,setDone] = useState(false);
  useEffect(()=>{
    const q=new URLSearchParams(location.search), org=q.get('org')??'',person=q.get('person')??'',client=q.get('from');
    const app=whitelabel.relyingApps.find(a=>a.client_id===client);
    const join=q.get('action')==='join', returnTo=q.get('return')??'';
    if(!app?.member_library_artifacts?.length || !address(org) || (!join&&!address(person)) || !app.redirect_uris.includes(returnTo)) {setError('This invitation request is invalid. Return to the app and try again.');return;}
    setRequest({org:org.toLowerCase() as Address,...(!join?{person:person.toLowerCase() as Address}:{}),label:(q.get('name')??person).slice(0,100),artifacts:app.member_library_artifacts,appName:app.name??app.client_id,returnTo,join});
  },[]);
  const approve=async()=>{
    if(!request||!session||!agentAddress)return;
    setBusy(true);setError('');
    try {
      if(request.join){
        await joinOrganization({member:agentAddress,org:request.org,displayName:personName??agentName??'Family member',session,credential:profile?.credential,named:!!agentName?.trim(),requireRecorded:true});
        // The native join is best-effort about some projections. Do not call it complete without a persisted member link.
        const r=await fetch('/connect/related-orgs',{headers:{authorization:`Bearer ${session.token}`}});
        const b=await r.json();
        const rows=b.orgs??b.agents??b.related??[];
        if(!r.ok||!Array.isArray(rows)||!rows.some((x:any)=>(x.agent??x.orgAgent??x.address)?.toLowerCase()===request.org))throw new Error('Your join was submitted, but Home has not confirmed the membership record. Return to the app and refresh before retrying.');
      } else {
        const sign=await signHashFor(resolveVia(profile?.credential,session.via),request.org,{token:session.token});
        const result=await inviteThroughHarness({org:request.org,invitee:request.person!,role:'adult',session,signHash:sign});
        if(!result.ok)throw new Error(result.error);
        if(!result.invitation)throw new Error('The agent did not return the invitation. No Library access was added.');
        const grant=toWire(await issueOrganizationLibraryMemberAccessDelegation(request.org,request.person!,request.artifacts,MCP_SERVER_ID,sign));
        const recorded=await recordInvitation({...result.invitation,memberAccessDelegation:grant},session.token);
        if(!recorded.ok)throw new Error('The membership invitation was issued, but shared-plan access could not be recorded: '+recorded.error);
      }
      setDone(true);
      window.opener?.postMessage({type:'ap-organization-invitation',org:request.org,person:request.person??agentAddress,action:request.join?'joined':'invited'},new URL(request.returnTo).origin);
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  return <section style={{maxWidth:480,margin:'6vh auto',padding:24}}>
    <p>Approving as {personName??agentName??agentAddress??'your Home'}</p>
    <h1>{request?.join?'Join this family?':'Approve family access?'}</h1>
    {request&&!done&&<>
      <p>{request.join?'Accept the invitation in':<>Invite <strong>{request.label}</strong> to</>} {request.appName}.</p>
      <p>Family: <code style={{overflowWrap:'anywhere'}}>{request.org}</code></p>
      <p>This shares the family profile, the list of documents in its Library, and permission to read and edit the shared family plan. Personal notes and treasury permissions are not included.</p>
      {!request.join&&<p>They still need to accept using their own Home. A friendship alone does not join the family.</p>}
      <button className="btn primary" disabled={busy||!session} onClick={()=>void approve()}>{busy?'Saving your approval…':request.join?'Accept family invitation':'Approve invitation and plan access'}</button>
      <button className="btn" disabled={busy} onClick={()=>window.close()}>Not now</button>
    </>}
    {error&&<p role="alert">{error}</p>}
    {done&&request&&<><p role="status">{request.join?'Membership recorded. Return to the app to load the family plan.':'Invitation and shared-plan permission recorded. The invitee must accept to join.'}</p><button className="btn primary" onClick={()=>window.close()}>Done — back to the app</button><p><a href={request.returnTo}>Open {request.appName}</a></p></>}
  </section>;
}

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
import { finishApprovalWindow } from '../../../src/lib/approval-window';
import { hasRecordedFamilyMembership, organizationInvitationReturn } from '../../../src/lib/organization-invitation';

const address = (s: string): s is Address => /^0x[0-9a-fA-F]{40}$/.test(s);
export default function OrganizationInvitationPage() {
  const { session, agentAddress, agentName, personName, profile } = useSession();
  const [request, setRequest] = useState<{org: Address; person?: Address; member?: Address; label: string; artifacts: string[]; appName: string; returnTo: string; join: boolean} | null>(null);
  const [busy,setBusy] = useState(false), [error,setError] = useState(''), [done,setDone] = useState(false);
  const [stayed,setStayed] = useState(false), [checking,setChecking] = useState(false), [progress,setProgress] = useState(''), [slow,setSlow] = useState(false);
  useEffect(()=>{
    const q=new URLSearchParams(location.search), org=q.get('org')??'',person=q.get('person')??'',client=q.get('from');
    const app=whitelabel.relyingApps.find(a=>a.client_id===client);
    const join=q.get('action')==='join', returnTo=q.get('return')??'', member=q.get('member');
    if(!app?.member_library_artifacts?.length || !address(org) || (!join&&!address(person)) || (member&&!address(member)) || !app.redirect_uris.includes(returnTo)) {setError('This invitation request is invalid. Return to the app and try again.');return;}
    setRequest({org:org.toLowerCase() as Address,...(!join?{person:person.toLowerCase() as Address}:{}),...(member?{member:member.toLowerCase() as Address}:{}),label:(q.get('name')??person).slice(0,100),artifacts:app.member_library_artifacts,appName:app.name??app.client_id,returnTo,join});
  },[]);
  const wrongHome = !!request?.join && !!request.member && !!agentAddress && request.member !== agentAddress.toLowerCase();
  const notify = () => {
    if (!request || !agentAddress) return;
    window.opener?.postMessage({type:'ap-organization-invitation',org:request.org,person:request.person??agentAddress,action:request.join?'joined':'invited'},new URL(request.returnTo).origin);
  };
  // Done: tell the app (a hint — it confirms by reading membership) and close this window by itself.
  useEffect(() => {
    if (!done || !request || !agentAddress) return;
    const told = finishApprovalWindow(window, {
      targetOrigin: new URL(request.returnTo).origin,
      message: {type:'ap-organization-invitation',org:request.org,person:request.person??agentAddress,action:request.join?'joined':'invited'},
      delayMs: 1500, onStillOpen: () => setStayed(true),
    });
    if (!told) setStayed(true);
  }, [done]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!request) return;
    setDone(false); setChecking(false); setError('');
    if (!request?.join || !session || !agentAddress || wrongHome) return;
    let current = true; setChecking(true);
    void fetch('/connect/related-orgs',{headers:{authorization:`Bearer ${session.token}`},signal:AbortSignal.timeout(30000)}).then(async r => {
      const body = await r.json();
      if (!r.ok) throw new Error(body.error ?? 'Membership could not be checked.');
      if (current && hasRecordedFamilyMembership(body,request.org)) setDone(true);
    }).catch(() => { if (current) setError('Home could not check existing membership. Return to the app to check acceptance before trying again.'); }).finally(() => { if(current)setChecking(false); });
    return () => { current = false; };
  }, [request, session?.token, agentAddress, wrongHome]);
  useEffect(() => { if(done)notify(); }, [done, request, agentAddress]);
  useEffect(() => { setSlow(false); if(!busy)return;const timer=setTimeout(()=>setSlow(true),20000);return()=>clearTimeout(timer); },[busy]);
  const approve=async()=>{
    if(!request||!session||!agentAddress||wrongHome||busy||checking||done)return;
    setBusy(true);setError('');
    try {
      if(request.join){
        await joinOrganization({member:agentAddress,org:request.org,displayName:personName??agentName??'Family member',session,credential:profile?.credential,named:!!agentName?.trim(),requireRecorded:true,onProgress:setProgress});
        setProgress('Checking your recorded family membership…');
        // The native join is best-effort about some projections. Do not call it complete without a persisted member link.
        const r=await fetch('/connect/related-orgs',{headers:{authorization:`Bearer ${session.token}`},signal:AbortSignal.timeout(30000)});
        const b=await r.json();
        if(!r.ok||!hasRecordedFamilyMembership(b,request.org))throw new Error('Your join was submitted, but Home has not confirmed active family membership. Return to the app and check acceptance before retrying.');
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
    }catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}
  };
  return <section style={{maxWidth:480,margin:'6vh auto',padding:24}}>
    <p>Approving as {personName??agentName??agentAddress??'your Home'}</p>
    <h1>{done?(request?.join?'You’re a member of this family':'Family invitation approved'):request?.join?'Join this family?':'Approve family access?'}</h1>
    {request&&!done&&<>
      <p>{request.join?'Accept the invitation in':<>Invite <strong>{request.label}</strong> to</>} {request.appName}.</p>
      <p>Family: <code style={{overflowWrap:'anywhere'}}>{request.org}</code></p>
      <p>This shares the family profile, the list of documents in its Library, and permission to read and edit the shared family plan. Personal notes and treasury permissions are not included.</p>
      {!request.join&&<p>They still need to accept using their own Home. A friendship alone does not join the family.</p>}
      {checking&&<p role="status">Checking whether you already belong to this family…</p>}
      {wrongHome&&<p role="alert">This Home is signed in as a different person from Family Field. Return to the app and connect both windows with the same account before accepting.</p>}
      {busy&&<p role="status">{progress||'Saving your approval…'}</p>}
      {slow&&busy&&<p>This is taking longer than usual. Keep this window open while Home finishes; you do not need to accept again.</p>}
      <button type="button" className="btn primary" disabled={busy||checking||wrongHome||!session} onClick={()=>void approve()}>{busy?'Saving your approval…':request.join?'Accept family invitation':'Approve invitation and plan access'}</button>
      <button className="btn" disabled={busy} onClick={()=>window.close()}>Not now</button>
    </>}
    {error&&<p role="alert">{error}</p>}
    {done&&request&&<><p role="status">{request.join?'Membership recorded. You can open the family plan; there is no need to accept again.':'Invitation and shared-plan permission recorded. The invitee must accept to join.'} {stayed?'You can close this window.':'Taking you back…'}</p><button type="button" className="btn primary" onClick={()=>{notify();if(window.opener&&!window.opener.closed){window.opener.focus();window.close();}setTimeout(()=>location.assign(organizationInvitationReturn(request.returnTo,request.org,request.join)),150);}}>Done — back to the app</button><p><a href={organizationInvitationReturn(request.returnTo,request.org,request.join)}>{request.join?'Open family plan':`Open ${request.appName}`}</a></p></>}
  </section>;
}

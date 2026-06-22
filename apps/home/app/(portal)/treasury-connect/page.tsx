// The connect-treasury ceremony moved INTO the treasuries view: it now opens as a popup off a specific
// treasury card ("Connect to hosts"), pre-filled from that treasury (spec 283/284 — see
// src/components/portal/ConnectTreasuryModal). This standalone route is retired; redirect to /treasuries so
// any old link still lands the member where the ceremony now lives.
import { redirect } from 'next/navigation';

export default function TreasuryConnectPage(): never {
  redirect('/treasuries');
}

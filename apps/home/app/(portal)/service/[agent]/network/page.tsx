'use client';
// Workspace → Discovery → Network. The SAME substrate the person's Network page shows, deliberately: a
// workspace has no backend of its own, it answers on this one.
import { NetworkPanel } from '../../../../../src/components/network/NetworkPanel';

export default function ServiceNetworkPage() {
  return <NetworkPanel />;
}

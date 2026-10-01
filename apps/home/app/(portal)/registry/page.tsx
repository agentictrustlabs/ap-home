'use client';
// Settings → Registry, for the person's own agent. This route used to be the whole knowledge base — every
// named agent with a Register button beside it — which is an operator's roster, not a settings page.
// Browsing every agent is the Discovery app's job.
import { AgentRegistryListing } from '../../../src/components/portal/discovery/AgentRegistryListing';
import { HomeManifestCard } from '../../../src/components/portal/HomeManifestCard';
import { DirectoryListingCard } from '../../../src/components/portal/DirectoryListingCard';

export default function RegistryPage() {
  return (
    <>
      <AgentRegistryListing kind="person" agent="" />
      {/* spec 422 §8 — how others FIND you (the Home's manifest, the community directory) is discovery, not a connection:
          moved here from Connected, where a non-technical reader met them between her calendar and her assistants. */}
      <div style={{ marginTop: 'var(--sp-5)' }}>
        <h2 className="ui-h2">How others find you</h2>
        <HomeManifestCard />
        <div style={{ marginTop: 'var(--sp-3)' }}><DirectoryListingCard /></div>
      </div>
    </>
  );
}

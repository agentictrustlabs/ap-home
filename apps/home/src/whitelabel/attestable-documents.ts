// The documents a member can affirm at this Home. Faith content lives here in whitelabel, never in a package.
//
// Adding a document: one entry. An `inline-text` entry carries its canonical bytes; a `signed-release` entry names
// the publisher gateway's agent card, the publisher's handle and the work's slug, and the Home reads the signed
// release from there (the Home never holds a second copy of the words). A new document never changes an existing
// one: `wea-statement-of-faith-v1` keeps its bytes, its `wea` storage key and its `wea_*` return params.
import type { AttestableDocument } from '../attestation-docs';
import { WEA_DOC_ID, WEA_TEXT } from '../wea-doc';

export const ATTESTABLE_DOCUMENTS: readonly AttestableDocument[] = [
  {
    id: WEA_DOC_ID,
    storageKey: 'wea',
    returnPrefix: 'wea',
    icon: '📜',
    title: 'WEA Statement of Faith',
    author: 'World Evangelical Alliance',
    summary: 'Sign once — shared with faith-aligned apps',
    affirmation: 'I affirm the WEA Statement of Faith as a personal expression of belief.',
    commitment: { kind: 'inline-text', text: WEA_TEXT },
  },
  {
    id: 'lausanne-covenant-1974',
    storageKey: 'lausanne-covenant-1974',
    returnPrefix: 'att',
    icon: '🕊️',
    title: 'The Lausanne Covenant',
    author: 'The Lausanne Movement (Lausanne, 1974)',
    sourceUrl: 'https://lausanne.org/statement/lausanne-covenant',
    summary: 'Affirm the 1974 Covenant — read from the Movement’s signed release',
    affirmation: 'I affirm the Lausanne Covenant as a personal expression of faith and resolve.',
    // Published by the Lausanne Movement’s publisher service on the Source Publishing gateway (faithnet, test
    // window). The handle is the service’s Home label; the slug derives from the work’s title.
    commitment: {
      kind: 'signed-release',
      card: 'https://publishing.faithnet.io/.well-known/agent-card.json',
      handle: 'lausanne-movement',
      slug: 'the-lausanne-covenant',
    },
  },
];

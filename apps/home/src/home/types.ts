// The home domain model — the member-facing ontology in code (see docs/portal-lexicon.md).
// "Home" is the member's own place in the missional community; from it they oversee, manage,
// and protect what they're entrusted with, and give apps permission to their resources.
import type { Address } from '@agenticprimitives/types';

/** A member's home: the account they own + the name the community knows them by. */
export interface Home {
  address: Address;
  /** Full registered name (e.g. rich-vt-1.impact). Use `label` for display. */
  name: string;
}

/** The display label of a name (drops the registry suffix): `joe.impact` → `joe`. The label is the
 *  FIRST dot-segment — parent-agnostic, so it works for `.impact`, the legacy `.demo.agent`, or a bare
 *  label. Using a fixed-suffix strip (the old `\.demo\.agent$`) silently passed `<label>.impact`
 *  through unchanged; the server then stripped the dot and registered `<label>impact.impact`. */
export function homeLabel(name: string): string {
  return name.split('.')[0] || name;
}

/** A kind of thing a member helps steward from their home. */
export type StewardKind = 'person' | 'organization' | 'treasury' | 'data-source';

/** Something the member helps steward (oversee / manage / protect). */
export interface Steward {
  kind: StewardKind;
  label: string;
  /** The stewardship verb — oversee | manage | protect (person has none). */
  verb?: string;
  blurb: string;
  status: 'live' | 'soon';
}

/** A scoped, revocable permission the home has given a missional-community app. */
export interface Permission {
  clientId: string;
  appName: string;
  appDomain: string;
  logo?: string;
  canDo: string[];
  cannotDo: string[];
  grantedAt: number;
  expiresAt?: number;
  /** spec 265 — YouVersion data types the person has granted this app to read (mirrors the authoritative
   *  server-side grant; the picker reads it for the checked state). */
  youversionScopes?: string[];
}

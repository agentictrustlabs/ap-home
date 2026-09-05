'use client';
// AN AGENT, IN PROSE — the registered name when one resolves, the truncated address until it does and
// when none ever will.
//
// This is the sentence a person reads before they sign something ("… needs permission to make payments as
// nathan.me"), and six hex characters are not a party you can recognise. The address stays in the title
// and is what everything downstream binds to: the address is the identity (ADR-0010) and the name is only
// what the chain says points at it, so this changes how an agent READS and never which agent it IS.
import type { Address } from '@agenticprimitives/types';
import { useRegisteredName } from '../../lib/reverse-name';

const short = (a: string): string => (a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export function AgentName({ address }: { address: string }) {
  const valid = /^0x[0-9a-fA-F]{40}$/.test(address);
  const { name } = useRegisteredName(valid ? (address as Address) : null);
  return <span title={address}>{name ?? short(address)}</span>;
}

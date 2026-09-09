// The card an outside agent publishes: one JSON-RPC 1.0 interface, no security scheme (a public clock).
export function clockCard() {
  const origin = process.env.NEXT_PUBLIC_HOME_ORIGIN?.replace(/\/$/, '') || 'https://faithnet.me';
  return {
    protocolVersion: '1.0',
    name: 'clock.external',
    description: 'An outside A2A 1.0 agent (spec 379 live twin): answers what time it is, in UTC. Not a member of any estate.',
    version: '1.0.0',
    supportedInterfaces: [{ url: `${origin}/external-agent`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    skills: [{ id: 'clock.tell', name: 'Tell the time', description: 'Answers what time it is, in UTC.', tags: ['time', 'clock'], examples: ['what time is it'] }],
    provider: { organization: 'clock.external (demo)', url: `${origin}/external-agent/card` },
  };
}

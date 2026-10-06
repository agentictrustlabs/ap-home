import { describe, expect, it } from 'vitest';
import { defaultCommonName, displayAppDomain, displayAppName, shortAppHost, toOrgLabel } from './org-chooser-label';

describe('toOrgLabel', () => {
  it('normalizes spaces and capitals to a web-safe handle', () => {
    expect(toOrgLabel('Field Workspace')).toBe('field-workspace');
  });
});

describe('shortAppHost', () => {
  it('keeps the first hostname label', () => {
    expect(shortAppHost('field-web.richardpedersen3.workers.dev')).toBe('field-web');
  });

  it('strips a scheme and trailing slash', () => {
    expect(shortAppHost('https://field-web.example.com/')).toBe('field-web');
  });
});

describe('displayAppName', () => {
  it('uses the registered name when present', () => {
    expect(displayAppName('Gather27', 'gather27-web.richardpedersen3.workers.dev')).toBe('Gather27');
  });

  it('humanizes a workers.dev host instead of showing the FQDN', () => {
    expect(displayAppName(undefined, 'gather27-web.richardpedersen3.workers.dev')).toBe('Gather27');
  });

  it('humanizes a hostname even when it was stored as the registered name', () => {
    expect(displayAppName('gather27-web.richardpedersen3.workers.dev', 'gather27-web.richardpedersen3.workers.dev')).toBe('Gather27');
  });
});

describe('displayAppDomain', () => {
  it('hides preview hosts', () => {
    expect(displayAppDomain('gather27-web.richardpedersen3.workers.dev')).toBe('');
    expect(displayAppDomain('localhost:5175')).toBe('');
  });

  it('keeps a public host', () => {
    expect(displayAppDomain('gather.example.org')).toBe('gather.example.org');
  });
});

describe('defaultCommonName', () => {
  it('keeps what the person typed at the app as the name people know', () => {
    expect(defaultCommonName('Global.Church')).toBe('Global.Church');
    expect(defaultCommonName('  Grace Community Church ')).toBe('Grace Community Church');
  });

  it('renders a pre-slugged org_base rather than offering the handle as the name', () => {
    expect(defaultCommonName('global-church')).toBe('Global Church');
  });

  it('is empty when the app sent nothing', () => {
    expect(defaultCommonName(undefined)).toBe('');
  });
});

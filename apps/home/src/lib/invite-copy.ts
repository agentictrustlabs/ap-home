/** Copy for an email-invite landing. An app invite names the app first; an org-only invite does not. */

export function inviteHeadline(orgName: string, appName?: string | null): string {
  return appName ? `You're invited to ${appName}` : `You're invited to join ${orgName}`;
}

export function inviteLead(orgName: string, appName?: string | null): string {
  if (appName) {
    return `Join ${orgName} on ${appName}. Accept and we'll set up your home, then take you to ${appName} signed in. Your keys stay yours; the org gets no custody.`;
  }
  return `You were invited by email — that's all we need. Accept and we'll set up your home automatically, no app to install. Your keys stay yours; the org gets no custody.`;
}

export function inviteAcceptLabel(orgName: string, appName?: string | null): string {
  return appName ? `Accept & join ${appName}` : `Accept & join ${orgName}`;
}

export function inviteEmailSubject(orgName: string, appName?: string | null): string {
  return appName ? `You're invited to ${appName} (${orgName})` : `You're invited to join ${orgName}`;
}

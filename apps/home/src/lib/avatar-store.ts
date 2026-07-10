'use client';
// Demo avatar persistence — localStorage until vault profile gains avatarDataUrl (P1).
// Keys: chat-avatar:person:{address} | chat-avatar:community:{orgAddress}

const PERSON_PREFIX = 'chat-avatar:person:';
const COMMUNITY_PREFIX = 'chat-avatar:community:';

function read(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, dataUrl: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (dataUrl) localStorage.setItem(key, dataUrl);
    else localStorage.removeItem(key);
    window.dispatchEvent(new CustomEvent('chat-avatar-changed', { detail: { key } }));
  } catch {
    /* quota exceeded — ignore */
  }
}

export function personAvatarKey(address: string): string {
  return `${PERSON_PREFIX}${address.toLowerCase()}`;
}

export function communityAvatarKey(orgAddress: string): string {
  return `${COMMUNITY_PREFIX}${orgAddress.toLowerCase()}`;
}

export function getPersonAvatar(address: string): string | null {
  return read(personAvatarKey(address));
}

export function setPersonAvatar(address: string, dataUrl: string | null): void {
  write(personAvatarKey(address), dataUrl);
}

export function getCommunityAvatar(orgAddress: string): string | null {
  return read(communityAvatarKey(orgAddress));
}

export function setCommunityAvatar(orgAddress: string, dataUrl: string | null): void {
  write(communityAvatarKey(orgAddress), dataUrl);
}

/** Resolve avatar for a channel member by display name → listing label lookup is caller's job. */
export function getAvatarByKey(key: string): string | null {
  return read(key);
}

/** Resize + compress an image file to a JPEG data URL for avatar storage. */
export async function fileToAvatarDataUrl(file: File, maxPx = 256): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.88);
}

/** Resize for inline message attachment (larger cap). */
export async function fileToMessageDataUrl(file: File, maxPx = 800): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxPx / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.85);
}

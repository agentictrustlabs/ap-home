'use client';

import { AvatarUpload } from '../chat/AvatarUpload';
import { personAvatarKey, setPersonAvatar } from '../../../lib/avatar-store';
import { useAvatar } from '../chat/use-avatar';

export function ProfileHeader({
  name,
  handle,
  address,
  editable,
}: {
  name: string;
  handle?: string;
  address?: string;
  editable?: boolean;
}) {
  const avatarKey = address ? personAvatarKey(address) : null;
  const imageUrl = useAvatar(avatarKey);

  return (
    <>
      <AvatarUpload
        name={name}
        imageUrl={imageUrl}
        size={72}
        editable={editable && !!address}
        onUpload={(url) => { if (address) setPersonAvatar(address, url); }}
      />
      <div className="settings-hub__header-meta">
        <h1 className="settings-hub__name">{name}</h1>
        {handle && <div className="settings-hub__handle">{handle}</div>}
      </div>
    </>
  );
}

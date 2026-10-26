'use client';

import { AvatarUpload } from '../chat/AvatarUpload';
import { useOwnPhoto, setOwnPhoto } from '../chat/use-avatar';

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
  const imageUrl = useOwnPhoto(address);

  return (
    <>
      <AvatarUpload
        name={name}
        imageUrl={imageUrl}
        size={72}
        editable={editable && !!address}
        onUpload={(url) => { if (address) void setOwnPhoto(address, url).catch(() => { /* not saved: the avatar keeps the photo it had */ }); }}
      />
      <div className="settings-hub__header-meta">
        <h1 className="settings-hub__name">{name}</h1>
        {handle && <div className="settings-hub__handle">{handle}</div>}
      </div>
    </>
  );
}

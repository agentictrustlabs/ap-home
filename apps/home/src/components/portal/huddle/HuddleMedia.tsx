'use client';
// THE MEDIA, PLAYED — spec 378. The core SDK carries tracks; it does not play them. Without the UI kit,
// every remote participant's audio track must be put on an <audio> element and a shared screen on a
// <video>, or two people publish and neither hears (seen live, 2026-09-08). These elements are the only
// place media touches the page: they read tracks from the SDK and render nothing else.
import React, { useEffect, useRef } from 'react';
import { useRealtimeKitSelector } from '@cloudflare/realtimekit-react';

type Tracked = {
  id: string; name: string;
  audioEnabled: boolean; audioTrack?: MediaStreamTrack;
  screenShareEnabled: boolean; screenShareTracks?: { audio?: MediaStreamTrack; video?: MediaStreamTrack };
  on: (ev: string, fn: (p: unknown) => void) => void; off: (ev: string, fn: (p: unknown) => void) => void;
};

/** One participant's audio: an <audio> whose stream follows the SDK's `audioUpdate`. */
function ParticipantAudio({ p }: { p: Tracked }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const attach = (track?: MediaStreamTrack, enabled?: boolean) => {
      if (enabled && track) { el.srcObject = new MediaStream([track]); void el.play().catch(() => undefined); }
      else { el.srcObject = null; }
    };
    attach(p.audioTrack, p.audioEnabled);
    const onAudio = (payload: unknown) => { const x = payload as { audioEnabled: boolean; audioTrack: MediaStreamTrack }; attach(x.audioTrack, x.audioEnabled); };
    p.on('audioUpdate', onAudio);
    return () => { p.off('audioUpdate', onAudio); el.srcObject = null; };
  }, [p]);
  return <audio ref={ref} autoPlay playsInline />;
}

/** Every remote participant's audio. Mounted once per huddle, inside the RealtimeKit provider. */
export function RemoteAudio() {
  const joined = useRealtimeKitSelector((m) => m.participants.joined.toArray()) as unknown as Tracked[];
  return <>{joined.map((p) => <ParticipantAudio key={p.id} p={p} />)}</>;
}

/** A shared screen (a remote participant's, or your own as a preview), on a <video>. */
function ScreenVideo({ p, mine }: { p: Tracked; mine?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const attach = (tracks?: { audio?: MediaStreamTrack; video?: MediaStreamTrack }, enabled?: boolean) => {
      const list = enabled ? [tracks?.video, ...(mine ? [] : [tracks?.audio])].filter((t): t is MediaStreamTrack => !!t) : [];
      el.srcObject = list.length ? new MediaStream(list) : null;
      if (list.length) void el.play().catch(() => undefined);
    };
    attach(p.screenShareTracks, p.screenShareEnabled);
    const onShare = (payload: unknown) => { const x = payload as { screenShareEnabled: boolean; screenShareTracks: { audio?: MediaStreamTrack; video?: MediaStreamTrack } }; attach(x.screenShareTracks, x.screenShareEnabled); };
    p.on('screenShareUpdate', onShare);
    return () => { p.off('screenShareUpdate', onShare); el.srcObject = null; };
  }, [p, mine]);
  return (
    <figure className="huddle-screen">
      <video ref={ref} autoPlay playsInline muted={!!mine} />
      <figcaption>{mine ? 'Your screen' : `${p.name}'s screen`}</figcaption>
    </figure>
  );
}

/** Whoever is sharing right now, yours first as a preview. */
export function SharedScreens() {
  const joined = useRealtimeKitSelector((m) => m.participants.joined.toArray()) as unknown as Tracked[];
  const self = useRealtimeKitSelector((m) => m.self) as unknown as Tracked;
  const sharing = joined.filter((p) => p.screenShareEnabled);
  if (!self.screenShareEnabled && sharing.length === 0) return null;
  return (
    <div className="huddle-screens">
      {self.screenShareEnabled && <ScreenVideo p={self} mine />}
      {sharing.map((p) => <ScreenVideo key={p.id} p={p} />)}
    </div>
  );
}

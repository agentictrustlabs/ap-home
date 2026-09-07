'use client';
// Spec 369 — the browser's two jobs: CAPTURE and PLAYBACK. Hearing is the agent's (`/harness/hear`), and so
// is deciding what is said (`reply.spoken`). This hook decides nothing and signs nothing.
//
// Capture is one utterance at a time: the recorder opens, stops on ~1.2 s of silence after speech (an
// AnalyserNode — no VAD library) or at 20 s, and hands the bytes back. Opening the mic cancels speech so the
// recorder never hears the agent. Voice on/off is a UI preference (localStorage) — never authority state.
import { useCallback, useEffect, useRef, useState } from 'react';

const PREF_KEY = 'ap:ask:voice';
const MAX_MS = 20_000;
const SILENCE_MS = 1_200;
const SILENCE_RMS = 0.012;

export function useVoice() {
  const [enabled, setEnabledState] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const stopRef = useRef<(() => void) | null>(null);
  const canListen = typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  useEffect(() => { try { setEnabledState(localStorage.getItem(PREF_KEY) === '1'); } catch { /* private mode */ } }, []);

  const stopSpeaking = useCallback(() => { if (canSpeak) window.speechSynthesis.cancel(); setSpeaking(false); }, [canSpeak]);
  const stopListening = useCallback(() => { stopRef.current?.(); }, []);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    try { localStorage.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* private mode */ }
    if (!v) { stopListening(); stopSpeaking(); }
  }, [stopListening, stopSpeaking]);

  /**
   * Record ONE utterance and hand back its bytes. `onAudio` fires once with a non-empty recording; a
   * recording with no speech in it fires nothing. Errors (no permission, no device) go to `onError`.
   */
  const startListening = useCallback(async (onAudio: (blob: Blob) => void, onError?: (message: string) => void) => {
    if (!canListen) return;
    stopSpeaking();
    stopListening();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e) {
      onError?.(e instanceof Error && e.name === 'NotAllowedError' ? 'the microphone is blocked for this site' : 'no microphone is available');
      return;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: BlobPart[] = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    // Silence detection: end the utterance ~1.2 s after the last speech, but only once speech was heard.
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let heardSpeech = false;
    let lastSpeech = Date.now();
    const startedAt = Date.now();
    let closed = false;
    const finish = () => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      stopRef.current = null;
      setListening(false); setLevel(0);
      try { if (rec.state !== 'inactive') rec.stop(); } catch { /* already stopped */ }
      for (const t of stream.getTracks()) t.stop();
      void ctx.close().catch(() => undefined);
    };
    const timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
      const rms = Math.sqrt(sum / buf.length);
      setLevel(Math.min(1, rms * 8));
      const now = Date.now();
      if (rms > SILENCE_RMS) { heardSpeech = true; lastSpeech = now; }
      if ((heardSpeech && now - lastSpeech > SILENCE_MS) || now - startedAt > MAX_MS) finish();
    }, 100);
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || mime || 'audio/webm' });
      if (heardSpeech && blob.size > 0) onAudio(blob);
    };
    stopRef.current = finish;
    setListening(true);
    rec.start(250);
  }, [canListen, stopSpeaking, stopListening]);

  const speak = useCallback((text: string, onEnd?: () => void) => {
    if (!canSpeak || !text.trim()) { onEnd?.(); return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = navigator.language || 'en-US';
    u.onstart = () => setSpeaking(true);
    u.onend = () => { setSpeaking(false); onEnd?.(); };
    u.onerror = () => { setSpeaking(false); onEnd?.(); };
    window.speechSynthesis.speak(u);
  }, [canSpeak]);

  // Leaving the surface silences it and closes the mic.
  useEffect(() => () => { stopRef.current?.(); if (canSpeak) window.speechSynthesis.cancel(); }, [canSpeak]);

  return { enabled, setEnabled, canListen, canSpeak, listening, speaking, level, startListening, stopListening, speak, stopSpeaking };
}

/** The recording as base64, for the hear request. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

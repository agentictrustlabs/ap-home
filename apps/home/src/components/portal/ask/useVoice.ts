'use client';
// Spec 369 — the browser's two jobs: CAPTURE and PLAYBACK. Hearing is the agent's (`/harness/hear`), and so
// is deciding what is said (`reply.spoken`). This hook decides nothing and signs nothing.
//
// Capture is one utterance at a time: the recorder opens, stops on ~1.2 s of silence after speech (an
// AnalyserNode — no VAD library) or at 20 s, and hands the bytes back. Opening the mic cancels speech so the
// recorder never hears the agent. Voice on/off is a UI preference (localStorage) — never authority state.
//
// Playback has to survive the browser's speech engine, which is where a dialog quietly dies:
//   - Chrome garbage-collects an utterance nobody holds a reference to, and its `onend` never fires — so the
//     "listen again after speaking" never happens. Every utterance is held until it ends.
//   - Chrome stops a long utterance mid-sentence (~15 s for non-local voices) without an `onend`. Text is
//     spoken as a queue of sentence-sized utterances.
//   - `cancel()` fires `onerror`/`onend` on the utterance it interrupts. A superseded utterance's callback
//     opening the mic would then cancel the utterance that superseded it — nothing said, mic open. A speak
//     that was cancelled runs no callback at all.
import { useCallback, useEffect, useRef, useState } from 'react';

const PREF_KEY = 'ap:ask:voice';
const MAX_MS = 20_000;
const SILENCE_MS = 1_200;
const SILENCE_RMS = 0.012;
const CHUNK_CHARS = 180;

/** Softer voices first, where the device offers them: the natural/neural voices on Windows and macOS, then
 *  the platform's usual female English voice. The engine's default is the fallback, never silence. */
const PREFERRED_VOICES = [/Aria.*Natural/i, /Jenny.*Natural/i, /Sonia.*Natural/i, /Libby.*Natural/i, /Samantha/i, /Ava/i, /Allison/i, /Karen/i, /Moira/i, /Zira/i, /Google US English/i, /Google UK English Female/i, /female/i];

export function pickVoice(voices: readonly SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const english = voices.filter((v) => /^en/i.test(v.lang));
  for (const re of PREFERRED_VOICES) {
    const hit = english.find((v) => re.test(v.name));
    if (hit) return hit;
  }
  return null;
}

/** Sentence-sized pieces, so no single utterance is long enough for the engine to abandon it. */
export function speechChunks(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (const piece of text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?;:])\s+/)) {
    if (!piece) continue;
    if (cur && cur.length + piece.length + 1 > CHUNK_CHARS) { out.push(cur); cur = piece; }
    else cur = cur ? `${cur} ${piece}` : piece;
  }
  if (cur) out.push(cur);
  return out;
}

export function useVoice() {
  const [enabled, setEnabledState] = useState(false);
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [level, setLevel] = useState(0);
  const stopRef = useRef<(() => void) | null>(null);
  // The utterances of the speak in progress — held so the engine cannot collect them — and a generation
  // counter that lets a cancelled speak know it was superseded.
  const uttersRef = useRef<SpeechSynthesisUtterance[]>([]);
  const speakGen = useRef(0);
  const endRef = useRef<(() => void) | null>(null);
  const voiceRef = useRef<SpeechSynthesisVoice | null>(null);
  const canListen = typeof window !== 'undefined' && typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;

  useEffect(() => { try { setEnabledState(localStorage.getItem(PREF_KEY) === '1'); } catch { /* private mode */ } }, []);

  // Voices arrive asynchronously in Chrome; pick when they do, and again if the list changes.
  useEffect(() => {
    if (!canSpeak) return;
    const choose = () => { voiceRef.current = pickVoice(window.speechSynthesis.getVoices()); };
    choose();
    window.speechSynthesis.addEventListener?.('voiceschanged', choose);
    return () => window.speechSynthesis.removeEventListener?.('voiceschanged', choose);
  }, [canSpeak]);

  const stopSpeaking = useCallback(() => {
    speakGen.current++;
    uttersRef.current = [];
    endRef.current = null;
    if (canSpeak) window.speechSynthesis.cancel();
    setSpeaking(false);
  }, [canSpeak]);
  const stopListening = useCallback(() => { stopRef.current?.(); }, []);

  /**
   * Unlock the speaker. iOS Safari plays synthesized speech only once `speak()` has been called from inside a
   * touch — everything spoken later from a network reply is silent until then. Called from the mic tap and
   * the Voice toggle, both gestures; the empty utterance says nothing and costs nothing elsewhere.
   */
  const prime = useCallback(() => {
    if (!canSpeak) return;
    try { const u = new SpeechSynthesisUtterance(''); u.volume = 0; window.speechSynthesis.speak(u); } catch { /* no engine */ }
  }, [canSpeak]);

  const setEnabled = useCallback((v: boolean) => {
    setEnabledState(v);
    if (v) prime();
    try { localStorage.setItem(PREF_KEY, v ? '1' : '0'); } catch { /* private mode */ }
    if (!v) { stopListening(); stopSpeaking(); }
  }, [stopListening, stopSpeaking, prime]);

  /**
   * Record ONE utterance and hand back its bytes. `onAudio` fires once with a non-empty recording; a
   * recording with no speech in it fires `onIdle` instead (the person said nothing — the dialog pauses,
   * it does not keep the mic open unattended). Errors (no permission, no device) go to `onError`.
   */
  const startListening = useCallback(async (onAudio: (blob: Blob) => void, onError?: (message: string) => void, onIdle?: () => void) => {
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
    // The context is resumed explicitly: a mic reopened by the agent finishing a sentence is not a user
    // gesture, and a context left suspended reads zeros — 20 s of "Listening…" that heard nothing.
    const ctx = new AudioContext();
    void ctx.resume().catch(() => undefined);
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
      else onIdle?.();
    };
    stopRef.current = finish;
    setListening(true);
    rec.start(250);
  }, [canListen, stopSpeaking, stopListening]);

  /**
   * Say `text`, then run `onEnd` — only if this speak ran to its end. A speak that was cancelled (the mic
   * opened, Voice switched off, a newer speak took over) runs nothing: its moment has passed.
   *
   * `append` adds to what is being said instead of cutting it off: a reply and the line that follows it
   * ("Done — … abc.org is in your agents now.") are one breath, and the LAST caller's `onEnd` is the one
   * that runs when the whole of it has been said.
   */
  const speak = useCallback((text: string, onEnd?: () => void, opts?: { append?: boolean }) => {
    if (!canSpeak || !text.trim()) { onEnd?.(); return; }
    const appending = !!opts?.append && uttersRef.current.length > 0 && (window.speechSynthesis.speaking || window.speechSynthesis.pending);
    if (!appending) { stopSpeaking(); speakGen.current++; }
    const gen = speakGen.current;
    endRef.current = onEnd ?? null;
    const utters = speechChunks(text).map((piece) => {
      const u = new SpeechSynthesisUtterance(piece);
      u.lang = voiceRef.current?.lang ?? navigator.language ?? 'en-US';
      // A voice the engine will not take (a stale object after `voiceschanged`, a test double) must not
      // cost the sentence: the engine's default voice says it instead.
      if (voiceRef.current) { try { u.voice = voiceRef.current; } catch { /* default voice */ } }
      u.rate = 1;
      u.pitch = 1;
      u.onstart = () => { if (speakGen.current === gen) setSpeaking(true); };
      u.onend = () => {
        if (speakGen.current !== gen) return; // superseded — not ours to continue
        if (u !== uttersRef.current[uttersRef.current.length - 1]) return; // more of this breath follows
        setSpeaking(false); uttersRef.current = [];
        const end = endRef.current; endRef.current = null;
        end?.();
      };
      // An engine error ends this speak; a cancel ('interrupted'/'canceled') was ours or a newer speak's.
      u.onerror = (e) => {
        if (speakGen.current !== gen) return;
        if (e.error === 'interrupted' || e.error === 'canceled') return;
        setSpeaking(false); uttersRef.current = [];
        const end = endRef.current; endRef.current = null;
        end?.();
      };
      return u;
    });
    uttersRef.current = appending ? [...uttersRef.current, ...utters] : utters;
    // Queued back to back: the engine plays them in order, and a cancel between them is ours.
    for (const u of utters) window.speechSynthesis.speak(u);
  }, [canSpeak, stopSpeaking]);

  // Leaving the surface silences it and closes the mic.
  useEffect(() => () => { stopRef.current?.(); if (canSpeak) window.speechSynthesis.cancel(); }, [canSpeak]);

  return { enabled, setEnabled, canListen, canSpeak, listening, speaking, level, startListening, stopListening, speak, stopSpeaking, prime };
}

/** The recording as base64, for the hear request. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

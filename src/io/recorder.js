// recorder.js — capture the canvas to a video file.
//
// The important choice here is `captureStream(0)` plus `requestFrame()` rather
// than `captureStream(fps)`. A frame-rate stream samples the canvas on a wall
// clock, so a scene that takes 200 ms to draw produces a stuttering video with
// duplicated frames. Requesting frames by hand means one rendered frame becomes
// exactly one video frame, and the result plays back smoothly however long it
// took to make. The animation clock is driven by the frame index for the same
// reason: the video is deterministic, not a recording of how fast your machine
// happened to be.

const VIDEO_TYPES = [
  { id: 'mp4', label: 'MP4 (H.264)', candidates: ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'], ext: 'mp4' },
  { id: 'webm-vp9', label: 'WebM (VP9)', candidates: ['video/webm;codecs=vp9', 'video/webm;codecs=vp09.00.10.08'], ext: 'webm' },
  { id: 'webm-vp8', label: 'WebM (VP8)', candidates: ['video/webm;codecs=vp8', 'video/webm'], ext: 'webm' },
];

/** The formats this browser will actually encode, best first. */
export function availableVideoFormats() {
  if (typeof MediaRecorder === 'undefined') return [];
  const out = [];
  for (const t of VIDEO_TYPES) {
    const mime = t.candidates.find((c) => {
      try { return MediaRecorder.isTypeSupported(c); } catch (e) { return false; }
    });
    if (mime) out.push({ id: t.id, label: t.label, mime, ext: t.ext });
  }
  return out;
}

/**
 * Pick a format. `preferred` is a format id, or 'auto'. MP4 support in
 * MediaRecorder is recent and not universal — Chrome has it, Firefox does not —
 * so asking for it can legitimately come back empty, and the caller should say
 * so rather than silently handing back a WebM with the wrong extension.
 */
export function chooseVideoFormat(preferred) {
  const have = availableVideoFormats();
  if (!have.length) return null;
  if (!preferred || preferred === 'auto') {
    return have.find((f) => f.id.startsWith('webm')) || have[0];
  }
  return have.find((f) => f.id === preferred) || null;
}

/**
 * Record `frames` frames. `drawFrame(i, t)` must render frame i synchronously,
 * with t running 0..1 across the whole clip. Resolves with a Blob.
 */
export async function recordFrames({ canvas, format, fps, frames, bitrate, drawFrame, onProgress, shouldCancel }) {
  const manual = typeof canvas.captureStream === 'function';
  if (!manual) throw new Error('this browser cannot capture a canvas stream');

  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0];
  const canRequest = track && typeof track.requestFrame === 'function';
  // Some builds expose requestFrame on the stream instead of the track.
  const requestFrame = canRequest
    ? () => track.requestFrame()
    : (typeof stream.requestFrame === 'function' ? () => stream.requestFrame() : null);
  if (!requestFrame) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error('this browser cannot step frames manually');
  }

  const chunks = [];
  const rec = new MediaRecorder(stream, {
    mimeType: format.mime,
    videoBitsPerSecond: bitrate,
  });
  rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };

  const finished = new Promise((resolve, reject) => {
    rec.onstop = () => resolve(new Blob(chunks, { type: format.mime }));
    rec.onerror = (e) => reject(e.error || new Error('recording failed'));
  });

  rec.start();
  try {
    for (let i = 0; i < frames; i++) {
      if (shouldCancel && shouldCancel()) break;
      drawFrame(i, frames > 1 ? i / frames : 0);
      requestFrame();
      if (onProgress) onProgress((i + 1) / frames);
      // Yield so the encoder can drain; without this the whole clip is queued
      // into one task and long clips run the tab out of memory.
      await new Promise((r) => setTimeout(r, Math.max(4, Math.round(1000 / fps / 4))));
    }
  } finally {
    if (rec.state !== 'inactive') rec.stop();
    stream.getTracks().forEach((t) => t.stop());
  }
  return finished;
}

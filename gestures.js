/**
 * gestures.js: pure math helpers for hand-gesture detection.
 *
 * No DOM, no camera, no side effects: every function takes plain numbers or
 * MediaPipe landmark arrays and returns a value. That keeps the gesture logic
 * easy to read, reason about and unit-test on its own.
 *
 * MediaPipe Hands returns 21 landmarks per hand, each { x, y, z } with x and y
 * normalised to 0..1 of the video frame. The indices used here:
 *
 *   0 wrist
 *   4 thumb tip
 *   5/6/8    index  MCP / PIP / tip
 *   9/10/12  middle MCP / PIP / tip
 *   13/14/16 ring   MCP / PIP / tip
 *   17/18/20 pinky  MCP / PIP / tip
 */

export const LM = {
  WRIST: 0,
  THUMB_TIP: 4,
  INDEX_PIP: 6,
  INDEX_TIP: 8,
  MIDDLE_MCP: 9,
  MIDDLE_PIP: 10,
  MIDDLE_TIP: 12,
  RING_PIP: 14,
  RING_TIP: 16,
  PINKY_PIP: 18,
  PINKY_TIP: 20,
};

/** Bones of the hand skeleton, as pairs of landmark indices (for drawing). */
export const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],         // thumb
  [0, 5], [5, 6], [6, 7], [7, 8],         // index
  [5, 9], [9, 10], [10, 11], [11, 12],    // middle
  [9, 13], [13, 14], [14, 15], [15, 16],  // ring
  [13, 17], [0, 17], [17, 18], [18, 19], [19, 20], // pinky + palm
];

/**
 * Distance between two landmarks in *pixels* of the source video.
 * Landmarks are normalised separately on x and y, so on a 640x480 frame a
 * step of 0.1 in x is longer than 0.1 in y. Scaling by the frame size first
 * gives distances that do not change when the hand rotates.
 */
export function landmarkDistance(a, b, frameW = 1, frameH = 1) {
  const dx = (a.x - b.x) * frameW;
  const dy = (a.y - b.y) * frameH;
  return Math.hypot(dx, dy);
}

/**
 * Hand size = wrist to middle-finger knuckle (MCP). It barely changes when the
 * fingers bend, so it is a good ruler: thresholds relative to it work the same
 * whether the hand is close to the camera or far away.
 */
export function handSize(lm, frameW, frameH) {
  return landmarkDistance(lm[LM.WRIST], lm[LM.MIDDLE_MCP], frameW, frameH);
}

/**
 * Pinch ratio = thumb-tip-to-index-tip distance / hand size.
 * About 0.1-0.25 when pinching and 0.6+ with the fingers apart.
 */
export function pinchRatio(lm, frameW, frameH) {
  const size = handSize(lm, frameW, frameH) || 1e-6;
  return landmarkDistance(lm[LM.THUMB_TIP], lm[LM.INDEX_TIP], frameW, frameH) / size;
}

/**
 * Raw (single-frame) fist test: every fingertip is closer to the wrist than
 * the PIP joint (middle knuckle) of the same finger, i.e. all four fingers are
 * curled into the palm. The thumb is left out on purpose: in a natural fist it
 * lies across the fingers, and its tip-to-wrist distance is not reliable.
 */
export function isFistRaw(lm, frameW, frameH) {
  const wrist = lm[LM.WRIST];
  const fingers = [
    [LM.INDEX_TIP, LM.INDEX_PIP],
    [LM.MIDDLE_TIP, LM.MIDDLE_PIP],
    [LM.RING_TIP, LM.RING_PIP],
    [LM.PINKY_TIP, LM.PINKY_PIP],
  ];
  return fingers.every(([tip, pip]) =>
    landmarkDistance(lm[tip], wrist, frameW, frameH) <
    landmarkDistance(lm[pip], wrist, frameW, frameH));
}

/** Linear interpolation: move `a` a fraction `t` of the way towards `b`. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Clamp `v` into [min, max]. */
export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/**
 * Frame-rate independent smoothing factor. A filter tuned as "lerp 0.3 per
 * frame at 60 fps" keeps the same feel at 30 or 120 fps if the factor is
 * derived from the real time step `dtMs`.
 */
export function smoothingFactor(perFrameAt60, dtMs) {
  return 1 - Math.pow(1 - perFrameAt60, dtMs / (1000 / 60));
}

/**
 * Debounced boolean: the output only flips after the raw input has said the
 * same thing for `frames` frames in a row. Two thresholds (hysteresis) are
 * handled by the caller passing a different raw test while "on" vs "off".
 */
export class Debounce {
  constructor(frames = 3) {
    this.frames = frames;
    this.value = false;
    this.streak = 0;
  }

  /** Feed one frame; returns { value, changed }. */
  update(raw) {
    if (raw === this.value) {
      this.streak = 0;
      return { value: this.value, changed: false };
    }
    this.streak += 1;
    if (this.streak >= this.frames) {
      this.value = raw;
      this.streak = 0;
      return { value: this.value, changed: true };
    }
    return { value: this.value, changed: false };
  }

  reset() {
    this.value = false;
    this.streak = 0;
  }
}

/**
 * Map a normalised landmark (0..1 of the video frame) to CSS pixels inside a
 * box that shows the video with `object-fit: cover` and a mirrored X axis
 * (selfie view). Returns { x, y } in the box's coordinate space.
 */
export function videoToBox(nx, ny, videoW, videoH, boxW, boxH, mirrored = true) {
  const scale = Math.max(boxW / videoW, boxH / videoH);
  const offX = (boxW - videoW * scale) / 2;
  const offY = (boxH - videoH * scale) / 2;
  const u = mirrored ? 1 - nx : nx;
  return { x: offX + u * videoW * scale, y: offY + ny * videoH * scale };
}

/** Euclidean distance between two equal-length numeric vectors. */
export function euclidean(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Element-wise mean of several equal-length vectors (Float32Array out). */
export function averageVectors(vectors) {
  const out = new Float32Array(vectors[0].length);
  for (const v of vectors) {
    for (let i = 0; i < out.length; i++) out[i] += v[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length;
  return out;
}

/**
 * How many fingers are held up (0-5).
 * A finger counts when its tip is clearly farther from the wrist than its
 * middle joint (PIP): straight fingers give a ratio around 1.4, curled ones
 * below 1. The thumb counts when its tip is far from the middle knuckle,
 * i.e. sticking out sideways rather than tucked across the palm.
 */
export function countFingers(lm, frameW, frameH) {
  const wrist = lm[LM.WRIST];
  const size = handSize(lm, frameW, frameH) || 1e-6;
  const fingers = [
    [LM.INDEX_TIP, LM.INDEX_PIP],
    [LM.MIDDLE_TIP, LM.MIDDLE_PIP],
    [LM.RING_TIP, LM.RING_PIP],
    [LM.PINKY_TIP, LM.PINKY_PIP],
  ];
  let count = 0;
  for (const [tip, pip] of fingers) {
    const ratio = landmarkDistance(lm[tip], wrist, frameW, frameH) /
                  (landmarkDistance(lm[pip], wrist, frameW, frameH) || 1e-6);
    if (ratio > 1.15) count++;
  }
  if (landmarkDistance(lm[LM.THUMB_TIP], lm[LM.MIDDLE_MCP], frameW, frameH) / size > 0.75) count++;
  return count;
}

/**
 * Types a PIN one digit at a time from finger counts.
 *
 * - Readings are smoothed: the most common count of the last few frames wins.
 * - A digit is accepted after the same count is held for `holdMs`.
 * - After a digit, the hand must change (another count, a closed hand or no
 *   hand) before the next one, so holding "3" does not type 3-3-3-3.
 *   To type the same digit twice: close the hand briefly in between.
 */
export class DigitEntry {
  constructor({ length = 6, holdMs = 1000, min = 1, max = 5, window = 7 } = {}) {
    Object.assign(this, { length, holdMs, min, max, window });
    this.digits = [];
    this.recent = [];
    this.candidate = null;
    this.since = 0;
    this.armed = true;
    this.lastDigit = null;
  }

  get done() {
    return this.digits.length >= this.length;
  }

  /** Smoothed reading: most frequent value in the recent window (null = no hand). */
  get reading() {
    const counts = new Map();
    for (const v of this.recent) counts.set(v, (counts.get(v) || 0) + 1);
    let best = null;
    let bestN = 0;
    for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }
    return best;
  }

  /** Hold progress of the current candidate digit, 0..1. */
  progress(now) {
    return this.candidate == null ? 0 : Math.min(1, (now - this.since) / this.holdMs);
  }

  /** Feed one frame (`count` = 0-5, or null without a hand). Returns the digit typed this frame, or null. */
  update(count, now) {
    if (this.done) return null;
    this.recent.push(count);
    if (this.recent.length > this.window) this.recent.shift();
    const reading = this.reading;

    if (!this.armed) {
      if (reading !== this.lastDigit) this.armed = true;
      else return null;
    }
    if (reading == null || reading < this.min || reading > this.max) {
      this.candidate = null;
      return null;
    }
    if (reading !== this.candidate) {
      this.candidate = reading;
      this.since = now;
      return null;
    }
    if (now - this.since < this.holdMs) return null;

    this.digits.push(reading);
    this.lastDigit = reading;
    this.armed = false;
    this.candidate = null;
    return reading;
  }
}

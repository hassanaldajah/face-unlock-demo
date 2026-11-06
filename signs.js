/**
 * signs.js: read a few hand signs from one frame of hand landmarks.
 *
 * This is a small rule-based reader, not a sign language translator. Real sign
 * languages use movement, both hands and the face, and need a model trained on
 * video. Here each sign is one still hand shape: which fingers are up, plus the
 * thumb direction. No DOM and no camera, so it can be tested on its own.
 */

import { LM, landmarkDistance, handSize, pinchRatio } from './gestures.js';

const THUMB_MCP = 2;

export const SIGNS = [
  { id: 'hello', emoji: '🖐️', word: 'Hello / Stop', ar: 'مرحبا / قف', meaning: 'An open palm: a greeting, or a request to stop.', tag: 'Common gesture' },
  { id: 'yes', emoji: '👍', word: 'Good / Yes', ar: 'ممتاز / نعم', meaning: 'Thumb up: approval or agreement.', tag: 'Common gesture' },
  { id: 'no', emoji: '👎', word: 'Bad / No', ar: 'سيئ / لا', meaning: 'Thumb down: disapproval or disagreement.', tag: 'Common gesture' },
  { id: 'ok', emoji: '👌', word: 'OK', ar: 'تمام', meaning: 'Thumb and index finger in a circle: everything is fine.', tag: 'Common gesture' },
  { id: 'peace', emoji: '✌️', word: 'Peace / Victory', ar: 'سلام / نصر', meaning: 'Two fingers up: peace, or a win.', tag: 'Common gesture' },
  { id: 'love', emoji: '🤟', word: 'I love you', ar: 'أحبك', meaning: 'Thumb, index and pinky up: the letters I, L and Y combined.', tag: 'ASL sign' },
  { id: 'rock', emoji: '🤘', word: 'Rock on', ar: 'روك', meaning: 'Index and pinky up: enjoying the music.', tag: 'Common gesture' },
  { id: 'call', emoji: '🤙', word: 'Call me / Y', ar: 'اتصل بي', meaning: 'Thumb and pinky out: "call me", and the letter Y in ASL.', tag: 'ASL letter' },
  { id: 'point', emoji: '☝️', word: 'One / Wait', ar: 'واحد / انتظر', meaning: 'One finger up: the number one, or "one moment".', tag: 'Common gesture' },
  { id: 'fist', emoji: '✊', word: 'Strength', ar: 'قوة', meaning: 'A closed fist: strength or solidarity.', tag: 'Common gesture' },
];

const BY_ID = new Map(SIGNS.map((s) => [s.id, s]));

/** Up (true), curled (false), or half bent (null): half bent is not a reliable reading. */
function fingerState(lm, tip, pip, w, h) {
  const wrist = lm[LM.WRIST];
  const ratio = landmarkDistance(lm[tip], wrist, w, h) / (landmarkDistance(lm[pip], wrist, w, h) || 1e-6);
  if (ratio > 1.12) return true;
  if (ratio < 1.05) return false;
  return null;
}

/** Which sign this hand shape is, or null. */
export function classifySign(lm, w, h) {
  const size = handSize(lm, w, h) || 1e-6;
  const index = fingerState(lm, LM.INDEX_TIP, LM.INDEX_PIP, w, h);
  const middle = fingerState(lm, LM.MIDDLE_TIP, LM.MIDDLE_PIP, w, h);
  const ring = fingerState(lm, LM.RING_TIP, LM.RING_PIP, w, h);
  const pinky = fingerState(lm, LM.PINKY_TIP, LM.PINKY_PIP, w, h);

  // Tested first: in "OK" the index finger is bent into a circle, so it may read as half bent
  if (middle && ring && pinky && pinchRatio(lm, w, h) < 0.35) return BY_ID.get('ok');

  if ([index, middle, ring, pinky].includes(null)) return null;

  const thumbOut = landmarkDistance(lm[LM.THUMB_TIP], lm[LM.MIDDLE_MCP], w, h) / size > 0.75;
  const shape = `${+index}${+middle}${+ring}${+pinky}`;

  switch (shape) {
    case '1111': return thumbOut ? BY_ID.get('hello') : null;
    case '1100': return thumbOut ? null : BY_ID.get('peace');
    case '1001': return BY_ID.get(thumbOut ? 'love' : 'rock');
    case '0001': return thumbOut ? BY_ID.get('call') : null;
    case '1000': return thumbOut ? null : BY_ID.get('point');
    case '0000': {
      const dy = (lm[THUMB_MCP].y - lm[LM.THUMB_TIP].y) * h / size; // positive = thumb tip above its base
      const dx = Math.abs(lm[THUMB_MCP].x - lm[LM.THUMB_TIP].x) * w / size;
      if (Math.abs(dy) > 0.35 && Math.abs(dy) > dx) return BY_ID.get(dy > 0 ? 'yes' : 'no');
      return BY_ID.get('fist');
    }
    default: return null;
  }
}

/**
 * Keeps the screen calm: a new reading only shows after it has been the most
 * common one of the last few frames for `holdMs`, so passing shapes never flash.
 */
export class SignReader {
  constructor({ holdMs = 350, window = 7 } = {}) {
    Object.assign(this, { holdMs, window });
    this.reset();
  }

  reset() {
    this.recent = [];
    this.candidate = null;
    this.since = 0;
    this.shown = null;
  }

  /** Feed one frame (a sign id or null). Returns the sign to show, or null. */
  update(id, now) {
    this.recent.push(id);
    if (this.recent.length > this.window) this.recent.shift();

    const counts = new Map();
    for (const v of this.recent) counts.set(v, (counts.get(v) || 0) + 1);
    let best = null;
    let bestN = 0;
    for (const [v, n] of counts) if (n > bestN) { best = v; bestN = n; }

    if (best !== this.candidate) {
      this.candidate = best;
      this.since = now;
    } else if (now - this.since >= this.holdMs) {
      this.shown = best;
    }
    return this.shown ? BY_ID.get(this.shown) : null;
  }
}

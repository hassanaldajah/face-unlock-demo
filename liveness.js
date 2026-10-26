/**
 * liveness.js: "is this a live person or a photo?" challenge logic.
 *
 * Face matching alone only answers "does this look like the enrolled face?".
 * A printed photo or a photo on a phone screen looks exactly like it, so the
 * match passes. A liveness check asks for something a flat picture cannot do
 * on demand: blink, turn the head, open the mouth. The challenges are picked
 * at random, so a pre-recorded video is unlikely to do the right thing at the
 * right time.
 *
 * Like gestures.js, everything here is pure math on landmark arrays, so it
 * can be read and tested without a camera.
 *
 * face-api returns 68 face landmarks (the iBUG 300-W layout), in pixels of
 * the *unmirrored* camera frame:
 *
 *   0-16  jaw line (0 = image-left end, 16 = image-right end)
 *   30    nose tip
 *   36-41 eye on the image left    42-47 eye on the image right
 *   48/54 mouth corners            62/66 inner lip, top / bottom middle
 */

export const FACE68 = {
  JAW_START: 0,
  JAW_END: 16,
  NOSE_TIP: 30,
  EYE_A: [36, 37, 38, 39, 40, 41],
  EYE_B: [42, 43, 44, 45, 46, 47],
  MOUTH_LEFT: 48,
  MOUTH_RIGHT: 54,
  LIP_INNER_TOP: 62,
  LIP_INNER_BOTTOM: 66,
};

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Eye aspect ratio (Soukupová & Čech, 2016): eye height / eye width.
 * About 0.25-0.35 with the eye open, drops towards 0.1 when it closes.
 * Points are p1..p6 going around the eye, p1 and p4 being the corners.
 */
export function eyeAspectRatio([p1, p2, p3, p4, p5, p6]) {
  return (dist(p2, p6) + dist(p3, p5)) / (2 * dist(p1, p4) || 1e-6);
}

/**
 * The three numbers the challenges look at, from one set of 68 landmarks.
 *
 *   ear   average eye aspect ratio of both eyes
 *   yaw   where the nose tip sits along the jaw line, 0..1. About 0.5 when
 *         facing the camera. It rises when the person turns to *their* left
 *         (their nose moves to the image right in the unmirrored frame).
 *         Projecting onto the jaw line (instead of using raw x) keeps it
 *         correct when the head is tilted sideways.
 *   mouth inner-lip gap / mouth width: ~0-0.1 closed, 0.4+ wide open
 */
export function faceMetrics(pts) {
  const ear = (eyeAspectRatio(FACE68.EYE_A.map((i) => pts[i])) +
               eyeAspectRatio(FACE68.EYE_B.map((i) => pts[i]))) / 2;

  const a = pts[FACE68.JAW_START];
  const b = pts[FACE68.JAW_END];
  const n = pts[FACE68.NOSE_TIP];
  const jx = b.x - a.x;
  const jy = b.y - a.y;
  const yaw = ((n.x - a.x) * jx + (n.y - a.y) * jy) / (jx * jx + jy * jy || 1e-6);

  const mouth = dist(pts[FACE68.LIP_INNER_TOP], pts[FACE68.LIP_INNER_BOTTOM]) /
                (dist(pts[FACE68.MOUTH_LEFT], pts[FACE68.MOUTH_RIGHT]) || 1e-6);

  return { ear, yaw, mouth };
}

/** Median of each metric over a few frames: a steady "neutral face" baseline. */
export function medianMetrics(list) {
  const median = (values) => {
    const s = [...values].sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  return {
    ear: median(list.map((m) => m.ear)),
    yaw: median(list.map((m) => m.yaw)),
    mouth: median(list.map((m) => m.mouth)),
  };
}

/**
 * Each challenge compares live metrics with the person's own baseline, so it
 * works for small and large eyes, round and long faces.
 *
 * `create(base)` returns a tracker; call `tracker(metrics)` once per frame and
 * it returns true when the challenge is done. Turns and the open mouth must
 * hold for 2 frames in a row, so one noisy frame cannot pass them.
 */
export const CHALLENGES = {
  blink: {
    label: 'Blink slowly',
    create(base) {
      let closedSeen = false;
      return ({ ear }) => {
        if (ear < base.ear * 0.68) closedSeen = true;          // eyes shut...
        return closedSeen && ear > base.ear * 0.85;             // ...and open again
      };
    },
  },
  left: {
    label: 'Turn your head to the left',
    create: (base) => holdFor(2, ({ yaw }) => yaw > base.yaw + 0.12),
  },
  right: {
    label: 'Turn your head to the right',
    create: (base) => holdFor(2, ({ yaw }) => yaw < base.yaw - 0.12),
  },
  mouth: {
    label: 'Open your mouth',
    create: (base) => holdFor(2, ({ mouth }) => mouth > Math.max(0.35, base.mouth + 0.25)),
  },
};

/** Wrap a per-frame test so it only passes after `frames` passing frames in a row. */
function holdFor(frames, test) {
  let streak = 0;
  return (metrics) => {
    streak = test(metrics) ? streak + 1 : 0;
    return streak >= frames;
  };
}

/** `count` different challenge names in random order. */
export function pickChallenges(count, random = Math.random) {
  const names = Object.keys(CHALLENGES);
  // Fisher-Yates shuffle
  for (let i = names.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [names[i], names[j]] = [names[j], names[i]];
  }
  return names.slice(0, count);
}

/**
 * app.js: Face + Gesture Unlock (educational demo / biometric security lab)
 *
 * Flow:  landing -> enroll -> face match -> liveness check -> slide to unlock (hand) -> unlocked
 *        -> encrypted vault (opened with a gesture PIN or passphrase)
 *
 * Security lab around it:
 *   - Red team: turn the liveness check off and a photo of you can unlock it.
 *   - Blue team: random liveness challenges, rate limiting with a lockout,
 *     and a SOC-style event log that can be exported as ECS JSON.
 *   - X-ray: the face embedding, the live distance and the threshold, visualised.
 *
 * Everything runs in this tab. The camera stream is never sent anywhere; the
 * only thing stored is one 128-number face descriptor in localStorage.
 *
 * Libraries (loaded from jsDelivr at pinned versions, model weights from ./models):
 *   - @vladmandic/face-api : face detection, 68 landmarks, 128-d face descriptor
 *   - @mediapipe/tasks-vision HandLandmarker : 21 hand landmarks per hand
 */

import {
  LM, HAND_CONNECTIONS, pinchRatio, isFistRaw, lerp, clamp, smoothingFactor,
  Debounce, videoToBox, euclidean, averageVectors, countFingers, DigitEntry,
} from './gestures.js';
import { FACE68, faceMetrics, medianMetrics, CHALLENGES, pickChallenges } from './liveness.js';
import { EventLog } from './eventlog.js';
import { createXray } from './xray.js';
import {
  KDF_ITERATIONS, deriveKey, encryptNotes, decryptNotes, tamperedCopy, saltOf, newSalt,
  secretStrength, vaultStore,
} from './vault.js';

// ---------------------------------------------------------------------------
// Configuration: every tunable number in one place
// ---------------------------------------------------------------------------

const CONFIG = {
  faceApiUrl: './vendor/face-api/face-api.esm.js',
  visionUrl: './vendor/tasks-vision/vision_bundle.mjs',
  visionWasmUrl: './vendor/tasks-vision/wasm',
  modelsUrl: './models',
  handModel: './models/hand_landmarker.task',

  // Face
  defaultThreshold: 0.5, // Euclidean distance below this = same person (adjustable in X-ray)
  matchHoldMs: 1000,     // must stay below the threshold this long
  faceIntervalMs: 350,   // how often to compare the live face
  enrollSamples: 5,
  enrollIntervalMs: 500, // 5 samples x 500 ms ≈ 2.5 s
  enrollTimeoutMs: 20000,
  enrollMaxSpread: 0.45, // a sample this far from the average = not the same face, retry

  // Liveness (anti-spoofing)
  livenessChallenges: 2,   // random challenges per unlock
  challengeTimeoutMs: 7000,
  livenessSlack: 0.15,     // head turns change the descriptor a bit: allow threshold + this
  livenessLostMs: 1500,    // face gone this long during the check = fail
  descriptorEvery: 3,      // during the check, compute the (slow) descriptor every 3rd frame

  // Rate limiting
  maxFailures: 5,          // failed attempts within the window...
  failureWindowMs: 60000,
  lockoutMs: 30000,        // ...lock the face step for this long
  mismatchAttemptMs: 1000, // a non-matching face seen this long = one failed attempt
  mismatchRepeatMs: 5000,  // ...and another one every 5 s it stays

  // Hand
  cursorLerp: 0.3,       // low-pass filter for the fingertip cursor (per frame at 60 fps)
  pinchOn: 0.35,         // pinch starts below 0.35 x hand size...
  pinchOff: 0.5,         // ...and ends above 0.5 (hysteresis stops flicker)
  pinchDebounceFrames: 3,
  fistAlpha: 0.25,       // smoothing of the per-frame fist test
  fistOn: 0.7,
  fistOff: 0.4,
  fistHoldMs: 1000,
  lostMs: 500,           // hand unseen this long = tracking lost
  grabPadding: 30,       // px around the handle that still counts as "on it"
  unlockAt: 0.92,        // release past 92 % of the track to unlock

  historyMs: 25000,      // distance samples kept for the X-ray chart
  storageKey: 'face-unlock-demo:v1',
  settingsKey: 'face-unlock-demo:settings',
};

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'), video: $('video'), overlay: $('overlay'),
  landing: $('landing'), startBtn: $('startBtn'), errorMsg: $('errorMsg'),
  slider: $('slider'), track: $('track'), fill: $('fill'), handle: $('handle'),
  success: $('success'), lockBtn: $('lockBtn'),
  challenge: $('challenge'), challengeStep: $('challengeStep'), challengeIcon: $('challengeIcon'),
  challengeText: $('challengeText'), challengeTimer: $('challengeTimer'),
  lockout: $('lockout'), lockoutCount: $('lockoutCount'),
  statusText: $('statusText'),
  meter: $('meter'), meterFill: $('meterFill'), meterThreshold: $('meterThreshold'),
  distanceText: $('distanceText'), thresholdText: $('thresholdText'),
  enrollProgress: $('enrollProgress'), enrollFill: $('enrollFill'), enrollText: $('enrollText'),
  enrollBtn: $('enrollBtn'), deleteBtn: $('deleteBtn'),
  steps: document.querySelectorAll('.step'), livenessStep: document.querySelector('.step[data-step="liveness"]'),
  livenessToggle: $('livenessToggle'), failCount: $('failCount'),
  xrayToggle: $('xrayToggle'), xrayCard: $('xrayCard'),
  statEar: $('statEar'), statYaw: $('statYaw'), statMouth: $('statMouth'),
  statDetect: $('statDetect'), statHands: $('statHands'),
  thresholdInput: $('thresholdInput'), thresholdValue: $('thresholdValue'),
  logList: $('logList'), logEmpty: $('logEmpty'), exportBtn: $('exportBtn'), clearLogBtn: $('clearLogBtn'),
  vaultCard: $('vaultCard'), pinpad: $('pinpad'), pinCount: $('pinCount'), pinDots: $('pinDots'), pinCancel: $('pinCancel'),
  vaultStatus: $('vaultStatus'), vaultSecretForm: $('vaultSecretForm'), vaultSecret: $('vaultSecret'),
  gesturePinBtn: $('gesturePinBtn'), vaultSubmit: $('vaultSubmit'), vaultStrength: $('vaultStrength'),
  vaultOpen: $('vaultOpen'), vaultNotes: $('vaultNotes'), vaultSave: $('vaultSave'), vaultLock: $('vaultLock'),
  vaultDelete: $('vaultDelete'), vaultRaw: $('vaultRaw'), tamperBtn: $('tamperBtn'), tamperResult: $('tamperResult'),
};
const ctx = els.overlay.getContext('2d');
const log = new EventLog(els.logList, els.logEmpty);
const xray = createXray({
  embedCanvas: $('embedCanvas'), embedTip: $('embedTip'), diffText: $('diffText'),
  chartCanvas: $('distChart'), chartTip: $('chartTip'),
});

// ---------------------------------------------------------------------------
// App state
// ---------------------------------------------------------------------------

/** 'landing' | 'loading' | 'enroll' | 'enrolling' | 'face' | 'liveness' | 'hand' | 'unlocked' */
let mode = 'landing';
let faceapi = null;          // face-api module, loaded on demand
let detectorOptions = null;
let handLandmarker = null;
let stream = null;
let enrolled = null;         // Float32Array(128) or null

// Face step
let faceLoopId = 0;          // bumping this cancels a running face loop
let faceFrame = 0;
let matchSince = null;       // time the distance first went below the threshold
let lastFace = null;         // { box, points, at, color, label } for drawing
let recentMetrics = [];      // eye / head / mouth metrics while matching = neutral baseline
let distanceHistory = [];    // { t, d } for the X-ray chart (d = null: no face)

// Liveness + rate limiting
let live = null;             // running liveness check, see startLiveness()
let failures = [];           // times of recent failed attempts
let lockedUntil = 0;
let mismatchSince = null;
let mismatchLoggedAt = null;

// Hand step
const hands = new Map();     // key ("Left"/"Right") -> per-hand state, see updateHands()
let grab = null;             // { key, offset } while a hand holds the slider handle
let sliderPos = 0;           // 0..1 along the track
let fistSince = null;
let lastVideoTime = -1;
let handCalls = [];          // hand-tracking timestamps, for the X-ray fps readout
let handStatAt = 0;

// ---------------------------------------------------------------------------
// Storage: one averaged descriptor in localStorage (in-memory fallback when
// storage is blocked, e.g. some browsers inside a third-party iframe)
// ---------------------------------------------------------------------------

const store = {
  memory: null,

  load() {
    try {
      const raw = localStorage.getItem(CONFIG.storageKey);
      if (!raw) return this.memory;
      const data = JSON.parse(raw);
      if (!Array.isArray(data.descriptor) || data.descriptor.length !== 128) return null;
      return Float32Array.from(data.descriptor);
    } catch {
      return this.memory;
    }
  },

  /** Returns true if saved to localStorage, false if kept in memory only. */
  save(descriptor) {
    this.memory = descriptor;
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify({
        version: 1,
        descriptor: Array.from(descriptor, (v) => +v.toFixed(6)),
        samples: CONFIG.enrollSamples,
        createdAt: new Date().toISOString(),
      }));
      return true;
    } catch {
      return false;
    }
  },

  clear() {
    this.memory = null;
    try { localStorage.removeItem(CONFIG.storageKey); } catch { /* storage blocked: nothing saved */ }
  },
};

/**
 * Settings. Secure by default: the liveness check and the threshold go back to
 * their safe values on every page load, so a red-team experiment never
 * outlives the visit. Only the X-ray view (a display preference) is remembered.
 */
const settings = { liveness: true, threshold: CONFIG.defaultThreshold, xray: false };
try { settings.xray = JSON.parse(localStorage.getItem(CONFIG.settingsKey) || '{}').xray === true; } catch { /* ignore */ }

function saveSettings() {
  try { localStorage.setItem(CONFIG.settingsKey, JSON.stringify({ xray: settings.xray })); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

function setStatus(text) {
  els.statusText.textContent = text;
}

function showError(text) {
  els.errorMsg.textContent = text;
  els.errorMsg.hidden = !text;
}

const STEP_ORDER = { face: 0, liveness: 1, hand: 2, unlocked: 3 };

/** Step indicator: Face -> Live -> Hand -> Unlocked (Live hidden when liveness is off). */
function updateSteps() {
  els.livenessStep.hidden = !settings.liveness;
  const current = STEP_ORDER[mode] ?? 0;
  const started = !['landing', 'loading'].includes(mode);
  for (const li of els.steps) {
    const i = STEP_ORDER[li.dataset.step];
    li.classList.toggle('active', started && i === current);
    li.classList.toggle('done', started && (i < current || mode === 'unlocked'));
  }
}

/** Switch the app to a new mode and update every piece of UI that depends on it. */
function setMode(next) {
  const prev = mode;
  mode = next;
  els.stage.dataset.state = next;
  updateSteps();

  // Panels and widgets
  els.landing.hidden = !['landing', 'loading'].includes(next);
  els.slider.hidden = next !== 'hand';
  els.success.hidden = next !== 'unlocked';
  els.challenge.hidden = next !== 'liveness';
  els.lockout.hidden = true;
  els.meter.hidden = !['face', 'liveness'].includes(next);
  els.enrollProgress.hidden = next !== 'enrolling';
  // Replacing the template is only allowed when none exists or after unlocking:
  // otherwise anyone could enroll their own face and walk in (enrollment hijack).
  els.enrollBtn.disabled = !['enroll', 'unlocked'].includes(next);
  els.enrollBtn.textContent = enrolled ? 'Re-enroll my face' : 'Enroll my face';
  els.deleteBtn.disabled = !enrolled || ['enrolling', 'loading'].includes(next);

  // Leaving the hand modes: forget hands and reset the slider
  if (!['hand', 'unlocked'].includes(next)) {
    hands.clear();
    grab = null;
  }
  if (next === 'face') {
    matchSince = null;
    recentMetrics = [];
  }
  if (next !== 'liveness') live = null;
  if (prev === 'unlocked' && next !== 'unlocked') closeVault();
  if (next === 'unlocked' && vault.msPerGuess == null) benchmarkKdf();
  if (next === 'hand') setSlider(0, false);
  if (next === 'unlocked') fistSince = null;

  // Default status line for each mode
  const messages = {
    enroll: 'No face enrolled yet. Look at the camera and press "Enroll my face".',
    face: 'Step 1: look at the camera to match your face.',
    liveness: 'Liveness check: follow the prompt on the camera.',
    hand: 'Face verified. Next: pinch the handle and slide it to the right.',
    unlocked: 'Unlocked. Hold a closed fist for 1 second to lock again.',
  };
  if (messages[next]) setStatus(messages[next]);
  renderVault();

  // The face loop runs in both 'face' and 'liveness'
  const faceModes = ['face', 'liveness'];
  if (faceModes.includes(next) && !faceModes.includes(prev)) startFaceLoop();
  if (!faceModes.includes(next)) faceLoopId++;
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

/** Turn getUserMedia errors into messages a normal person understands. */
function cameraErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow camera access for this site (lock icon in the address bar), then press "Start camera" again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera was found. Connect a webcam (or use a device with a front camera) and try again.';
    case 'NotReadableError':
    case 'AbortError':
      return 'The camera is busy or blocked by another app (video call, OBS…). Close it and try again.';
    case 'InsecureContext':
      return 'The camera only works on HTTPS or on localhost. Open the demo over https:// or from a local server.';
    default:
      return `Could not start the camera (${err?.message || err}).`;
  }
}

async function startCamera() {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    const err = new Error('insecure context');
    err.name = 'InsecureContext';
    throw err;
  }
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  els.video.srcObject = stream;
  // If the camera is unplugged or the permission is revoked mid-session
  stream.getVideoTracks()[0]?.addEventListener('ended', () => {
    stream = null;
    setMode('landing');
    showError('The camera stopped. Press "Start camera" to try again.');
  });
  await els.video.play();
  if (!els.video.videoWidth) {
    await new Promise((resolve) => els.video.addEventListener('loadedmetadata', resolve, { once: true }));
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

async function loadModels() {
  const [faceapiModule, vision] = await Promise.all([
    import(CONFIG.faceApiUrl),
    import(CONFIG.visionUrl),
  ]);
  faceapi = faceapiModule;

  // face-api runs on TensorFlow.js; WebGL is much faster than the CPU backend
  try { await faceapi.tf.setBackend('webgl'); } catch { /* falls back to the default */ }
  await faceapi.tf.ready();

  detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri(CONFIG.modelsUrl),
    faceapi.nets.faceLandmark68Net.loadFromUri(CONFIG.modelsUrl),
    faceapi.nets.faceRecognitionNet.loadFromUri(CONFIG.modelsUrl),
    createHandLandmarker(vision),
  ]);
  await warmUpFaceModels();
}

/**
 * The first run of each TensorFlow.js network compiles its WebGL shaders,
 * which can take a few seconds on a phone. Run all three once on a blank
 * image now, so enrollment and matching are fast from the first frame.
 */
async function warmUpFaceModels() {
  const blank = document.createElement('canvas');
  blank.width = blank.height = 160;
  await faceapi.detectSingleFace(blank, detectorOptions);
  await faceapi.detectFaceLandmarks(blank);
  await faceapi.computeFaceDescriptor(blank);
}

async function createHandLandmarker({ FilesetResolver, HandLandmarker }) {
  const fileset = await FilesetResolver.forVisionTasks(CONFIG.visionWasmUrl);
  const options = (delegate) => ({
    baseOptions: { modelAssetPath: CONFIG.handModel, delegate },
    runningMode: 'VIDEO',
    numHands: 2,
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  try {
    handLandmarker = await HandLandmarker.createFromOptions(fileset, options('GPU'));
  } catch (err) {
    console.warn('GPU hand tracking unavailable, using CPU:', err);
    handLandmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
  }
}

// ---------------------------------------------------------------------------
// Face: detection, enrollment, matching
// ---------------------------------------------------------------------------

/**
 * One detection on the current video frame -> { descriptor, box, points } or null.
 * The descriptor is the slowest part, so it can be skipped (descriptor = null).
 */
async function detectFace(withDescriptor = true) {
  let task = faceapi.detectSingleFace(els.video, detectorOptions).withFaceLandmarks();
  if (withDescriptor) task = task.withFaceDescriptor();
  const result = await task;
  if (!result) return null;
  return {
    descriptor: result.descriptor ?? null,
    box: result.detection.box,
    points: result.landmarks.positions,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function enroll() {
  setMode('enrolling');
  const samples = [];
  const deadline = performance.now() + CONFIG.enrollTimeoutMs;
  updateEnrollProgress(0);
  setStatus('Enrolling: look straight at the camera and keep still…');

  while (samples.length < CONFIG.enrollSamples && performance.now() < deadline) {
    const t0 = performance.now();
    const face = await detectFace();
    if (mode !== 'enrolling') return; // user left (e.g. camera stopped)
    if (face) {
      samples.push(face.descriptor);
      lastFace = { box: face.box, points: face.points, at: performance.now(), color: '#3ee8ff', label: `sample ${samples.length}` };
      updateEnrollProgress(samples.length);
    } else {
      setStatus('Enrolling: no face found. Look straight at the camera.');
    }
    await sleep(Math.max(0, CONFIG.enrollIntervalMs - (performance.now() - t0)));
  }

  if (samples.length < CONFIG.enrollSamples) {
    setMode(enrolled ? 'face' : 'enroll');
    setStatus('Enrollment failed: your face was not visible long enough. Try again with better light.');
    log.add('enroll', { level: 'warn', outcome: 'failure', message: 'Enrollment failed: face not visible long enough' });
    return;
  }

  // Averaging several samples smooths out noise from one bad frame
  const mean = averageVectors(samples);

  // If one sample is far from the average, two different people were probably
  // in view (or the face turned away). Do not save a mixed descriptor.
  const spread = Math.max(...samples.map((s) => euclidean(s, mean)));
  if (spread > CONFIG.enrollMaxSpread) {
    setMode(enrolled ? 'face' : 'enroll');
    setStatus('Enrollment failed: the samples did not agree. Make sure only you are in view and try again.');
    log.add('enroll', { level: 'warn', outcome: 'failure', message: `Enrollment rejected: samples disagree (spread ${spread.toFixed(2)})`, fields: { spread } });
    return;
  }

  enrolled = mean;
  const persisted = store.save(enrolled);
  log.add('enroll', {
    level: 'success', outcome: 'success',
    message: `Face template created from ${samples.length} samples (spread ${spread.toFixed(2)})${persisted ? '' : ', kept in memory only'}`,
    fields: { samples: samples.length, spread, persisted },
  });
  setMode('face');
  if (settings.xray) xray.drawEmbedding(enrolled, null);
  setStatus(persisted
    ? 'Face enrolled and saved in this browser. Now look at the camera to unlock.'
    : 'Face enrolled (this browser blocks storage, so it lasts until you close the tab). Look at the camera to unlock.');
}

function updateEnrollProgress(n) {
  els.enrollFill.style.width = `${(n / CONFIG.enrollSamples) * 100}%`;
  els.enrollText.textContent = `Sample ${n} / ${CONFIG.enrollSamples}`;
}

/**
 * The face loop. In 'face' mode it compares the live face every ~350 ms; in
 * 'liveness' mode it runs as fast as it can (a blink is over in ~300 ms) and
 * only computes the slow descriptor every few frames.
 */
function startFaceLoop() {
  const id = ++faceLoopId;
  matchSince = null;
  updateMeter(null);

  const tick = async () => {
    if (id !== faceLoopId || !['face', 'liveness'].includes(mode)) return;
    const t0 = performance.now();
    try {
      if (mode === 'face' && t0 < lockedUntil) {
        showLockout(t0);
      } else {
        if (!els.lockout.hidden) endLockout();
        const withDescriptor = mode === 'face' || ++faceFrame % CONFIG.descriptorEvery === 0;
        const face = await detectFace(withDescriptor);
        const now = performance.now();
        onFaceFrame(face, now, now - t0);
      }
    } catch (err) {
      console.error('Face detection failed:', err);
    }
    if (id === faceLoopId && ['face', 'liveness'].includes(mode)) {
      const wait = mode === 'liveness' ? 0 : CONFIG.faceIntervalMs - (performance.now() - t0);
      setTimeout(tick, Math.max(0, wait));
    }
  };
  tick();
}

/** Shared bookkeeping for every face frame, then hand it to the current step. */
function onFaceFrame(face, now, detectMs) {
  const metrics = face ? faceMetrics(face.points) : null;
  const distance = face?.descriptor ? euclidean(face.descriptor, enrolled) : null;

  // X-ray data
  if (!face || distance != null) {
    distanceHistory.push({ t: now, d: distance });
    while (distanceHistory.length && now - distanceHistory[0].t > CONFIG.historyMs) distanceHistory.shift();
  }
  updateFailCount(now);
  if (settings.xray) {
    els.statDetect.textContent = `${Math.round(detectMs)} ms`;
    els.statEar.textContent = metrics ? metrics.ear.toFixed(2) : '-';
    els.statYaw.textContent = metrics ? metrics.yaw.toFixed(2) : '-';
    els.statMouth.textContent = metrics ? metrics.mouth.toFixed(2) : '-';
    if (face?.descriptor) xray.drawEmbedding(enrolled, face.descriptor);
    xray.drawChart(distanceHistory, settings.threshold, now);
  }

  if (mode === 'face') handleFaceResult(face, now, metrics, distance);
  else if (mode === 'liveness') handleLivenessResult(face, now, metrics, distance);
}

function handleFaceResult(face, now, metrics, distance) {
  if (!face) {
    matchSince = null;
    mismatchSince = null;
    mismatchLoggedAt = null;
    lastFace = null;
    els.stage.dataset.state = 'face';
    updateMeter(null);
    setStatus('No face in view. Look at the camera.');
    return;
  }

  const isMatch = distance < settings.threshold;
  updateMeter(distance);
  lastFace = {
    box: face.box,
    points: face.points,
    at: now,
    color: isMatch ? '#34f5a0' : '#ff4d6d',
    label: distance.toFixed(2),
  };

  if (!isMatch) {
    matchSince = null;
    recentMetrics = [];
    els.stage.dataset.state = 'face';

    // A non-matching face held for 1 s is one failed attempt (and again every 5 s it stays)
    mismatchSince ??= now;
    const due = mismatchLoggedAt == null || now - mismatchLoggedAt >= CONFIG.mismatchRepeatMs;
    if (now - mismatchSince >= CONFIG.mismatchAttemptMs && due) {
      mismatchLoggedAt = now;
      registerFailure('face_mismatch',
        `Face did not match (distance ${distance.toFixed(3)}, threshold ${settings.threshold.toFixed(2)})`,
        { distance: round3(distance), threshold: settings.threshold });
      if (now < lockedUntil) return;
    }
    setStatus(`Face does not match the enrolled face (distance ${distance.toFixed(2)}).`);
    return;
  }

  mismatchSince = null;
  mismatchLoggedAt = null;
  recentMetrics.push(metrics);
  if (recentMetrics.length > 6) recentMetrics.shift();

  // Match: it has to stay a match for matchHoldMs in a row
  matchSince ??= now;
  const held = now - matchSince;
  els.stage.dataset.state = 'match';
  if (held < CONFIG.matchHoldMs) {
    setStatus(`Face matches. Hold still… ${(held / 1000).toFixed(1)} / 1.0 s`);
    return;
  }

  log.add('face_match', {
    level: 'success', outcome: 'success',
    message: `Face matched (distance ${distance.toFixed(3)}, threshold ${settings.threshold.toFixed(2)})`,
    fields: { distance: round3(distance), threshold: settings.threshold },
  });
  lastFace = null;
  if (settings.liveness) startLiveness(now);
  else setMode('hand');
}

/** Distance meter: the bar shows "closeness" (1 - distance), the marker sits at the threshold. */
function updateMeter(distance) {
  if (distance == null) {
    els.meterFill.style.width = '0%';
    els.distanceText.textContent = 'distance -';
    return;
  }
  els.meterFill.style.width = `${clamp(1 - distance, 0, 1) * 100}%`;
  els.meterFill.classList.toggle('ok', distance < settings.threshold);
  els.distanceText.textContent = `distance ${distance.toFixed(3)}`;
}

function updateThresholdUI() {
  const t = settings.threshold;
  els.thresholdValue.textContent = t.toFixed(2);
  els.thresholdText.textContent = `match < ${t.toFixed(2)}, held 1 s`;
  els.meterThreshold.style.left = `${(1 - t) * 100}%`;
  els.thresholdInput.value = t.toFixed(2);
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// ---------------------------------------------------------------------------
// Liveness: random challenges a photo cannot perform
// ---------------------------------------------------------------------------

/** SVG icons built as DOM nodes (no HTML strings => no innerHTML => no XSS risk). */
const SVG_NS = 'http://www.w3.org/2000/svg';
const svgIcon = (...pathData) => () => {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  for (const d of pathData) {
    const path = document.createElementNS(SVG_NS, d.startsWith('CIRCLE') ? 'circle' : 'path');
    if (d.startsWith('CIRCLE')) {
      const [, cx, cy, r] = d.split(' ');
      path.setAttribute('cx', cx); path.setAttribute('cy', cy); path.setAttribute('r', r);
    } else {
      path.setAttribute('d', d);
    }
    svg.append(path);
  }
  return svg;
};
const CHALLENGE_ICONS = {
  blink: svgIcon('M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z', 'CIRCLE 12 12 3'),
  left: svgIcon('M19 12H5M11 6l-6 6 6 6'),
  right: svgIcon('M5 12h14M13 6l6 6-6 6'),
  mouth: svgIcon('M5 10c2 5 12 5 14 0', 'M5 10c4 1.2 10 1.2 14 0'),
};

function startLiveness(now) {
  const names = pickChallenges(CONFIG.livenessChallenges);
  setMode('liveness');
  live = {
    names,
    index: 0,
    base: medianMetrics(recentMetrics), // the person's own neutral face
    tracker: null,
    startedAt: now,
    lastSeen: now,
    badFrames: 0,
  };
  nextChallenge(now);
  log.add('liveness_start', { message: `Liveness challenges issued: ${names.join(', ')}`, fields: { challenges: names } });
}

function nextChallenge(now) {
  const name = live.names[live.index];
  live.tracker = CHALLENGES[name].create(live.base);
  live.startedAt = now;
  els.challengeStep.textContent = `Liveness check ${live.index + 1} / ${live.names.length}`;
  els.challengeIcon.replaceChildren(CHALLENGE_ICONS[name]());
  els.challengeText.textContent = CHALLENGES[name].label;
  setStatus(`Liveness check: ${CHALLENGES[name].label.toLowerCase()}.`);
}

function handleLivenessResult(face, now, metrics, distance) {
  const name = live.names[live.index];

  if (now - live.startedAt > CONFIG.challengeTimeoutMs) {
    return failLiveness(`no "${CHALLENGES[name].label.toLowerCase()}" within ${CONFIG.challengeTimeoutMs / 1000} s`);
  }
  if (!face) {
    if (now - live.lastSeen > CONFIG.livenessLostMs) failLiveness('the face left the camera');
    return;
  }
  live.lastSeen = now;
  lastFace = { box: face.box, points: face.points, at: now, color: '#3ee8ff', label: '' };

  // Continuous identity check: the same person must stay in front of the camera
  if (distance != null) {
    updateMeter(distance);
    live.badFrames = distance > settings.threshold + CONFIG.livenessSlack ? live.badFrames + 1 : 0;
    if (live.badFrames >= 2) return failLiveness(`a different face appeared (distance ${distance.toFixed(2)})`);
  }

  if (!live.tracker(metrics)) return;

  log.add('liveness_step', {
    outcome: 'success', message: `Challenge passed: ${CHALLENGES[name].label.toLowerCase()}`,
    fields: { challenge: name },
  });
  live.index += 1;
  if (live.index < live.names.length) {
    nextChallenge(now);
    return;
  }
  log.add('liveness_pass', {
    level: 'success', outcome: 'success', message: 'Liveness check passed',
    fields: { challenges: live.names },
  });
  lastFace = null;
  setMode('hand');
}

function failLiveness(reason) {
  const challenge = live?.names[live.index];
  setMode('face');
  registerFailure('liveness_fail', `Liveness check failed: ${reason}`, { challenge, reason });
  if (performance.now() >= lockedUntil) {
    setStatus(`Liveness check failed: ${reason}. A photo or video cannot follow a random prompt. Look at the camera to try again.`);
  }
}

// ---------------------------------------------------------------------------
// Rate limiting: too many failures in a short time -> lockout
// ---------------------------------------------------------------------------

function registerFailure(action, message, fields) {
  log.add(action, { level: 'warn', outcome: 'failure', message, fields });
  const now = performance.now();
  failures = failures.filter((t) => now - t < CONFIG.failureWindowMs);
  failures.push(now);

  if (failures.length >= CONFIG.maxFailures) {
    lockedUntil = now + CONFIG.lockoutMs;
    failures = [];
    log.add('lockout', {
      level: 'alert', outcome: 'failure',
      message: `${CONFIG.maxFailures} failed attempts within ${CONFIG.failureWindowMs / 1000} s: face step locked for ${CONFIG.lockoutMs / 1000} s (possible spoofing or brute force)`,
      fields: { failed_attempts: CONFIG.maxFailures, lockout_seconds: CONFIG.lockoutMs / 1000 },
    });
    if (mode !== 'face') setMode('face');
    showLockout(now);
  }
  updateFailCount(now);
}

function updateFailCount(now = performance.now()) {
  const n = failures.filter((t) => now - t < CONFIG.failureWindowMs).length;
  const text = `${n}`;
  if (els.failCount.textContent !== text) els.failCount.textContent = text;
}

function showLockout(now) {
  const left = Math.ceil((lockedUntil - now) / 1000);
  els.lockout.hidden = false;
  els.stage.dataset.state = 'lockout';
  els.lockoutCount.textContent = left;
  lastFace = null;
  matchSince = null;
  updateMeter(null);
  setStatus(`Too many failed attempts. Face step locked for ${left} s.`);
}

function endLockout() {
  els.lockout.hidden = true;
  els.stage.dataset.state = 'face';
  log.add('lockout_end', { message: 'Lockout over: face step available again' });
  setStatus('Lockout over. Look at the camera to try again.');
}

// ---------------------------------------------------------------------------
// Hands: tracking, pinch, fist, slider
// ---------------------------------------------------------------------------

/** Read one MediaPipe result into the `hands` map (cursor, pinch, fist per hand). */
function updateHands(result, now) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const boxW = els.stage.clientWidth;
  const boxH = els.stage.clientHeight;
  const seen = new Set();

  result.landmarks.forEach((lm, i) => {
    // Key each hand by its handedness so it keeps its state between frames
    let key = result.handedness?.[i]?.[0]?.categoryName ?? `hand${i}`;
    if (seen.has(key)) key = `${key}${i}`;
    seen.add(key);

    let h = hands.get(key);
    if (!h) {
      h = { cursor: null, pinch: new Debounce(CONFIG.pinchDebounceFrames), fistLevel: 0, fist: false, lastSeen: now };
      hands.set(key, h);
    }

    // Cursor = index fingertip, mapped into the mirrored stage, then low-pass filtered
    const tip = videoToBox(lm[LM.INDEX_TIP].x, lm[LM.INDEX_TIP].y, vw, vh, boxW, boxH, true);
    if (!h.cursor) {
      h.cursor = tip;
    } else {
      const t = smoothingFactor(CONFIG.cursorLerp, now - h.lastSeen);
      h.cursor = { x: lerp(h.cursor.x, tip.x, t), y: lerp(h.cursor.y, tip.y, t) };
    }

    // Pinch (with hysteresis + 3-frame debounce)
    const ratio = pinchRatio(lm, vw, vh);
    const raw = h.pinch.value ? ratio < CONFIG.pinchOff : ratio < CONFIG.pinchOn;
    const { value, changed } = h.pinch.update(raw);
    h.pinchStarted = changed && value;

    // Fist (exponential smoothing of the per-frame test, with hysteresis)
    h.fistLevel = lerp(h.fistLevel, isFistRaw(lm, vw, vh) ? 1 : 0, CONFIG.fistAlpha);
    h.fist = h.fist ? h.fistLevel > CONFIG.fistOff : h.fistLevel > CONFIG.fistOn;

    h.landmarks = lm;
    h.lastSeen = now;
  });
}

/** Handle geometry in stage coordinates (CSS px). */
function sliderGeometry() {
  const stageRect = els.stage.getBoundingClientRect();
  const trackRect = els.track.getBoundingClientRect();
  const knob = els.handle.offsetWidth;
  const pad = els.handle.offsetLeft;
  const travel = Math.max(1, els.track.clientWidth - knob - pad * 2);
  const startX = trackRect.left - stageRect.left + pad + knob / 2; // handle centre at pos 0
  const centerY = trackRect.top - stageRect.top + trackRect.height / 2;
  return { knob, pad, travel, startX, centerY };
}

function setSlider(pos, spring) {
  sliderPos = pos;
  const { knob, pad, travel } = sliderGeometry();
  els.handle.classList.toggle('spring', spring);
  els.fill.classList.toggle('spring', spring);
  els.handle.style.transform = `translateX(${pos * travel}px)`;
  els.fill.style.width = pos > 0 ? `${pad + knob / 2 + pos * travel}px` : '0';
}

/** Let go of the handle: unlock if it reached the end, otherwise spring back. */
function releaseHandle(byPinch) {
  grab = null;
  els.handle.classList.remove('grabbed');
  if (byPinch && sliderPos >= CONFIG.unlockAt) {
    setSlider(1, false);
    log.add('unlock', settings.liveness
      ? { level: 'success', outcome: 'success', message: 'Unlocked: face + liveness + gesture', fields: { liveness: true } }
      : { level: 'warn', outcome: 'success', message: 'Unlocked WITHOUT a liveness check: a photo could have done this', fields: { liveness: false } });
    setMode('unlocked');
  } else {
    setSlider(0, true);
    if (mode === 'hand') {
      setStatus(byPinch
        ? 'Released too early. Pinch the handle and slide it all the way to the right.'
        : 'Hand lost. Pinch the handle again.');
    }
  }
}

/** Per-frame interaction logic for the slider (hand mode) and the fist (unlocked mode). */
function updateInteraction(now) {
  if (mode === 'hand') {
    const g = sliderGeometry();
    const handleX = g.startX + sliderPos * g.travel;

    if (!grab) {
      let hover = false;
      // Whichever hand pinches on the handle first takes it
      for (const [key, h] of hands) {
        const near = Math.hypot(h.cursor.x - handleX, h.cursor.y - g.centerY) < g.knob / 2 + CONFIG.grabPadding;
        hover ||= near;
        if (near && h.pinchStarted) {
          grab = { key, offset: h.cursor.x - handleX };
          els.handle.classList.add('grabbed');
          els.handle.classList.remove('spring');
          els.fill.classList.remove('spring');
          setStatus('Got it. Slide to the right and release at the end.');
          break;
        }
      }
      els.handle.classList.toggle('hover', hover && !grab);
    }

    if (grab) {
      const h = hands.get(grab.key);
      if (!h.pinch.value) {
        releaseHandle(true);
      } else {
        setSlider(clamp((h.cursor.x - grab.offset - g.startX) / g.travel, 0, 1), false);
      }
    }
  }

  if (mode === 'unlocked' && vault.pin) {
    updatePinEntry(now);
  } else if (mode === 'unlocked') {
    const anyFist = [...hands.values()].some((h) => h.fist && now - h.lastSeen < 150);
    if (anyFist) {
      fistSince ??= now;
      if (now - fistSince >= CONFIG.fistHoldMs) lock('fist');
    } else {
      fistSince = null;
    }
  }

  // Pinch-start events are one-shot: consume them
  for (const h of hands.values()) h.pinchStarted = false;
}

/** Drop hands that have not been seen for `lostMs`; release the slider if needed. */
function expireHands(now) {
  for (const [key, h] of hands) {
    if (now - h.lastSeen > CONFIG.lostMs) {
      hands.delete(key);
      if (grab?.key === key) releaseHandle(false);
    }
  }
}

function lock(method) {
  fistSince = null;
  log.add('lock', { message: `Locked again (${method === 'fist' ? 'fist gesture' : 'button'})`, fields: { method } });
  setMode('face');
  setStatus('Locked. Look at the camera to unlock again.');
}

// ---------------------------------------------------------------------------
// Vault: encrypted notes behind the lock (crypto lives in vault.js)
// ---------------------------------------------------------------------------

const vault = {
  record: vaultStore.load(), // what is stored: salt + IV + ciphertext, never the key
  key: null,                 // AES-GCM CryptoKey, only while the vault is open
  salt: null,
  dirty: false,              // notes changed since the last save
  busy: false,               // deriving a key (takes a moment on purpose)
  msPerGuess: null,          // measured cost of one key derivation on this device
  pin: null,                 // DigitEntry while typing a gesture PIN
  deleteArmedAt: -Infinity,
};

function renderVault() {
  const unlocked = mode === 'unlocked';
  const open = Boolean(vault.key);
  let status;
  if (!unlocked) {
    status = vault.record
      ? 'Locked. Unlock with face + gesture first, then enter your secret to decrypt.'
      : 'Locked. Unlock with face + gesture first to create your vault.';
  } else if (open) {
    status = 'Open. The key exists in memory only and is dropped when you lock.';
  } else if (vault.record) {
    status = 'Vault found. Enter your gesture PIN or passphrase to decrypt it.';
  } else {
    status = 'No vault yet. Choose a secret: a 6-digit gesture PIN (1 to 5 fingers per digit) or a passphrase.';
  }
  if (!vault.busy) els.vaultStatus.textContent = status;
  els.vaultSecretForm.hidden = !unlocked || open;
  els.vaultOpen.hidden = !open;
  els.vaultSubmit.textContent = vault.record ? 'Decrypt' : 'Create vault';
  els.vaultSubmit.disabled = vault.busy;
  els.gesturePinBtn.disabled = vault.busy || Boolean(vault.pin);
  els.vaultDelete.hidden = !(unlocked && vault.record);
  updateAttackerView();
}

/** "Attacker view": exactly what sits in localStorage (ciphertext shortened for display). */
function updateAttackerView() {
  const r = vault.record;
  els.vaultRaw.textContent = r
    ? JSON.stringify({ ...r, ct: r.ct.length > 96 ? `${r.ct.slice(0, 96)}…` : r.ct }, null, 2)
    : '(nothing stored yet)';
  els.tamperBtn.disabled = !vault.key;
  if (!vault.key) els.tamperResult.textContent = '';
}

/** Live strength estimate for the typed secret (nothing is sent or stored). */
function updateStrength() {
  const secret = els.vaultSecret.value;
  if (!secret) {
    els.vaultStrength.textContent = '';
    return;
  }
  const { bits, guesses } = secretStrength(secret);
  let text = `≈ ${Math.round(bits)} bits: ${formatCount(guesses)} possible secrets`;
  if (vault.msPerGuess) {
    text += `. Trying all of them on this device: ${formatDuration(guesses * vault.msPerGuess)} (a GPU cracker is far faster)`;
  }
  els.vaultStrength.textContent = secret.length < 6 ? `At least 6 characters. ${text}` : text;
}

const formatCount = (n) => (n < 1e9 ? Math.round(n).toLocaleString('en') : `about 10^${Math.round(Math.log10(n))}`);

function formatDuration(ms) {
  const s = ms / 1000;
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  if (s < 3.15e7 * 2) return `${Math.round(s / 86400)} days`;
  if (s < 3.15e13) return `${formatCount(s / 3.15e7)} years`;
  return 'millions of years';
}

/** Time one key derivation once, so the strength estimate uses real numbers. */
async function benchmarkKdf() {
  vault.msPerGuess = 0; // marks "running"
  const t0 = performance.now();
  await deriveKey('benchmark-only', newSalt());
  vault.msPerGuess = performance.now() - t0;
  updateStrength();
}

/** Create the vault (first time) or decrypt it. The secret itself is never stored or logged. */
async function submitSecret(secret, source) {
  if (vault.busy || mode !== 'unlocked') return;
  if (secret.length < 6) {
    els.vaultStatus.textContent = 'Use at least 6 digits or characters.';
    return;
  }
  vault.busy = true;
  renderVault();
  els.vaultStatus.textContent = `Deriving the key (${KDF_ITERATIONS.toLocaleString('en')} PBKDF2 rounds)…`;
  const bits = Math.round(secretStrength(secret).bits);
  let wrong = false;
  try {
    const t0 = performance.now();
    if (!vault.record) {
      const salt = newSalt();
      const key = await deriveKey(secret, salt);
      vault.msPerGuess = performance.now() - t0;
      const record = await encryptNotes(key, salt, '');
      vaultStore.save(record);
      Object.assign(vault, { record, key, salt, dirty: false });
      els.vaultNotes.value = '';
      log.add('vault_created', {
        level: 'success', outcome: 'success',
        message: `Vault created: AES-256-GCM, key from PBKDF2-SHA256 (${KDF_ITERATIONS.toLocaleString('en')} rounds), ${source}, ≈${bits} bits`,
        fields: { secret_type: source, entropy_bits: bits, kdf_iterations: KDF_ITERATIONS },
      });
    } else {
      const salt = saltOf(vault.record);
      const key = await deriveKey(secret, salt, vault.record.kdf.iterations);
      vault.msPerGuess = performance.now() - t0;
      const text = await decryptNotes(key, vault.record); // throws on a wrong secret
      Object.assign(vault, { key, salt, dirty: false });
      els.vaultNotes.value = text;
      log.add('vault_open', { level: 'success', outcome: 'success', message: `Vault decrypted with ${source}`, fields: { secret_type: source } });
    }
  } catch (err) {
    if (err?.name !== 'OperationError') console.error(err);
    wrong = true;
  } finally {
    vault.busy = false;
    els.vaultSecret.value = '';
    updateStrength();
    renderVault();
  }
  if (wrong) {
    registerFailure('vault_open_fail', 'Vault: wrong secret (AES-GCM authentication failed, nothing decrypted)', { secret_type: source });
    if (mode === 'unlocked') els.vaultStatus.textContent = 'Wrong secret: nothing was decrypted. Failures count towards the lockout.';
  }
}

/** Encrypt the current notes with a fresh IV and store them. */
async function saveVault() {
  if (!vault.key) return;
  const { key, salt } = vault;
  const text = els.vaultNotes.value;
  const record = await encryptNotes(key, salt, text, vault.record?.kdf.iterations ?? KDF_ITERATIONS);
  vault.record = record;
  vaultStore.save(record);
  vault.dirty = false;
  log.add('vault_saved', { outcome: 'success', message: `Notes encrypted and saved (${text.length} characters, new random IV)`, fields: { characters: text.length } });
  updateAttackerView();
}

/** Lock the vault: save pending changes, then drop the key and the plaintext. */
function closeVault() {
  if (vault.key) {
    if (vault.dirty) saveVault(); // captures key + text before they are cleared below
    log.add('vault_locked', { message: 'Vault locked: key and plaintext dropped from memory' });
  }
  vault.key = null;
  vault.salt = null;
  vault.dirty = false;
  els.vaultNotes.value = '';
  stopPinEntry();
  renderVault();
}

// ---- Gesture PIN: finger counts typed one digit at a time ----

function startPinEntry() {
  if (mode !== 'unlocked' || vault.busy) return;
  vault.pin = new DigitEntry({ length: 6, holdMs: 1000 });
  els.success.hidden = true;
  els.pinpad.hidden = false;
  renderPin(performance.now());
  renderVault();
  els.stage.scrollIntoView({ behavior: 'smooth', block: 'center' }); // the pad is drawn over the camera
  setStatus('Gesture PIN: show 1 to 5 fingers and hold still. Close your hand between two equal digits.');
}

function stopPinEntry() {
  vault.pin = null;
  els.pinpad.hidden = true;
  els.success.hidden = mode !== 'unlocked';
}

function updatePinEntry(now) {
  // Use the hand seen most recently
  let hand = null;
  for (const h of hands.values()) if (!hand || h.lastSeen > hand.lastSeen) hand = h;
  const count = hand && now - hand.lastSeen < 150
    ? countFingers(hand.landmarks, els.video.videoWidth, els.video.videoHeight)
    : null;
  vault.pin.update(count, now);
  renderPin(now);
  if (vault.pin.done) {
    const secret = vault.pin.digits.join('');
    stopPinEntry();
    renderVault();
    els.vaultCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    submitSecret(secret, 'gesture PIN');
  }
}

/** Pinpad: the live finger count, hold progress, and one dot per typed digit (values hidden). */
function renderPin(now) {
  const pin = vault.pin;
  const reading = pin.reading;
  const text = reading == null ? '–' : String(reading);
  if (els.pinCount.textContent !== text) els.pinCount.textContent = text;
  els.pinCount.style.setProperty('--p', pin.progress(now).toFixed(3));
  els.pinCount.classList.toggle('waiting', !pin.armed);
  [...els.pinDots.children].forEach((dot, i) => dot.classList.toggle('on', i < pin.digits.length));
}

// ---------------------------------------------------------------------------
// Drawing (one canvas over the video)
// ---------------------------------------------------------------------------

function resizeCanvas() {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = els.stage.clientWidth;
  const h = els.stage.clientHeight;
  if (els.overlay.width !== Math.round(w * dpr) || els.overlay.height !== Math.round(h * dpr)) {
    els.overlay.width = Math.round(w * dpr);
    els.overlay.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { w, h };
}

function drawFaceBox(w, h, now) {
  if (!lastFace || now - lastFace.at > 900) return;
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  const { box, color, label } = lastFace;
  // Two opposite corners; mirroring swaps left and right
  const a = videoToBox(box.x / vw, box.y / vh, vw, vh, w, h, true);
  const b = videoToBox((box.x + box.width) / vw, (box.y + box.height) / vh, vw, vh, w, h, true);
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  const bw = Math.abs(b.x - a.x);
  const bh = Math.abs(b.y - a.y);

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.shadowColor = color;
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(x, y, bw, bh, 10);
  ctx.stroke();
  ctx.shadowBlur = 0;
  ctx.fillStyle = color;
  ctx.font = '600 13px ui-monospace, Consolas, monospace';
  ctx.fillText(label, x + 4, Math.max(14, y - 8));
  ctx.restore();

  if (settings.xray && lastFace.points) drawFaceLandmarks(w, h, vw, vh);
}

/** X-ray: the 68 landmarks, with the eyes and mouth (what liveness measures) outlined. */
function drawFaceLandmarks(w, h, vw, vh) {
  const pts = lastFace.points.map((p) => videoToBox(p.x / vw, p.y / vh, vw, vh, w, h, true));
  ctx.save();
  ctx.fillStyle = 'rgba(216, 243, 255, 0.8)';
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#3ee8ff';
  ctx.lineWidth = 1.5;
  const outline = (idx) => {
    ctx.beginPath();
    idx.forEach((i, k) => (k ? ctx.lineTo(pts[i].x, pts[i].y) : ctx.moveTo(pts[i].x, pts[i].y)));
    ctx.closePath();
    ctx.stroke();
  };
  outline(FACE68.EYE_A);
  outline(FACE68.EYE_B);
  outline([60, 61, 62, 63, 64, 65, 66, 67]); // inner lips
  // Jaw line and nose tip: what the head-turn measure uses
  ctx.strokeStyle = 'rgba(180, 140, 255, 0.8)';
  ctx.beginPath();
  ctx.moveTo(pts[FACE68.JAW_START].x, pts[FACE68.JAW_START].y);
  ctx.lineTo(pts[FACE68.JAW_END].x, pts[FACE68.JAW_END].y);
  ctx.stroke();
  ctx.fillStyle = '#b48cff';
  ctx.beginPath();
  ctx.arc(pts[FACE68.NOSE_TIP].x, pts[FACE68.NOSE_TIP].y, 3.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawHands(w, h, now) {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;

  for (const [key, hand] of hands) {
    // Fade out a hand that is momentarily not detected
    const alpha = clamp(1 - (now - hand.lastSeen) / CONFIG.lostMs, 0, 1);
    const pts = hand.landmarks.map((p) => videoToBox(p.x, p.y, vw, vh, w, h, true));
    const isGrabbing = grab?.key === key;
    const color = hand.fist && mode === 'unlocked' ? '#34f5a0' : hand.pinch.value ? '#b48cff' : '#3ee8ff';

    ctx.save();
    ctx.globalAlpha = alpha;

    // Skeleton
    ctx.strokeStyle = 'rgba(216, 243, 255, 0.55)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [i, j] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[i].x, pts[i].y);
      ctx.lineTo(pts[j].x, pts[j].y);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(62, 232, 255, 0.9)';
    for (const p of pts) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    }

    // Cursor: glowing ring when open, smaller solid dot while pinching
    const c = hand.cursor;
    ctx.shadowColor = color;
    ctx.shadowBlur = 18;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (hand.pinch.value) {
      ctx.arc(c.x, c.y, isGrabbing ? 9 : 8, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.lineWidth = 3;
      ctx.arc(c.x, c.y, 14, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(c.x, c.y, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // Fist hold progress ring (unlocked mode)
    if (mode === 'unlocked' && hand.fist && fistSince != null) {
      const p = clamp((now - fistSince) / CONFIG.fistHoldMs, 0, 1);
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 24, -Math.PI / 2, -Math.PI / 2 + p * Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Main loop: hand tracking runs on every new video frame; face matching has
// its own slower loop (startFaceLoop) because it is much heavier.
// ---------------------------------------------------------------------------

function frame(now) {
  requestAnimationFrame(frame);
  const { w, h } = resizeCanvas();
  ctx.clearRect(0, 0, w, h);
  if (!stream) return;

  const handsActive = mode === 'hand' || mode === 'unlocked';
  if (handsActive && handLandmarker && els.video.readyState >= 2 && els.video.currentTime !== lastVideoTime) {
    lastVideoTime = els.video.currentTime;
    try {
      updateHands(handLandmarker.detectForVideo(els.video, now), now);
      handCalls.push(now);
    } catch (err) {
      console.error('Hand tracking failed:', err);
    }
  }

  if (handsActive) {
    expireHands(now);
    updateInteraction(now);
    drawHands(w, h, now);
  } else {
    drawFaceBox(w, h, now);
  }

  // Liveness countdown bar
  if (mode === 'liveness' && live) {
    const left = clamp(1 - (now - live.startedAt) / CONFIG.challengeTimeoutMs, 0, 1);
    els.challengeTimer.style.width = `${left * 100}%`;
  }

  // X-ray hand-tracking rate (updated twice a second)
  while (handCalls.length && now - handCalls[0] > 1000) handCalls.shift();
  if (settings.xray && now - handStatAt > 500) {
    handStatAt = now;
    els.statHands.textContent = handsActive ? `${handCalls.length} fps` : 'idle';
  }
}

// ---------------------------------------------------------------------------
// Buttons and toggles
// ---------------------------------------------------------------------------

els.startBtn.addEventListener('click', async () => {
  showError('');
  els.startBtn.disabled = true;
  setMode('loading');
  setStatus('Starting camera and loading models (about 15 MB the first time)…');
  const t0 = performance.now();
  try {
    // Ask for the camera and download the models at the same time
    // (tag camera errors so they get a camera message, not a "models" one)
    const camera = startCamera().catch((err) => { throw Object.assign(err, { isCamera: true }); });
    const models = faceapi ? Promise.resolve() : loadModels();
    await Promise.all([camera, models]);
  } catch (err) {
    console.error(err);
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    showError(err?.isCamera
      ? cameraErrorMessage(err)
      : 'Could not load the face / hand models. Reload the page and try again.');
    log.add(err?.isCamera ? 'camera_error' : 'model_error', { level: 'warn', outcome: 'failure', message: err?.name || String(err) });
    els.startBtn.disabled = false;
    els.startBtn.textContent = 'Try again';
    setMode('landing');
    setStatus('Camera not started.');
    return;
  }
  log.add('camera_started', {
    message: `Camera on (${els.video.videoWidth}x${els.video.videoHeight}), models ready in ${((performance.now() - t0) / 1000).toFixed(1)} s. Video stays in this tab.`,
  });
  els.startBtn.disabled = false;
  setMode(enrolled ? 'face' : 'enroll');
});

els.enrollBtn.addEventListener('click', () => {
  if (stream && faceapi) enroll();
});

els.deleteBtn.addEventListener('click', () => {
  store.clear();
  enrolled = null;
  // Kept available at all times (it is your data), but flagged when done while locked:
  // a real device would ask for authentication before removing the biometric.
  const whileLocked = !['unlocked', 'landing'].includes(mode);
  log.add('template_deleted', whileLocked
    ? { level: 'warn', message: 'Face template deleted while locked (a real device would require authentication first)' }
    : { message: 'Face template deleted from this browser' });
  setMode(stream ? 'enroll' : mode);
  if (settings.xray) xray.drawEmbedding(null, null);
  setStatus('Your face data was deleted from this browser.');
});

els.lockBtn.addEventListener('click', () => lock('button'));

// Red team switch: liveness on/off
els.livenessToggle.checked = settings.liveness;
els.livenessToggle.addEventListener('change', () => {
  settings.liveness = els.livenessToggle.checked;
  if (settings.liveness) {
    log.add('liveness_enabled', { message: 'Liveness check turned on: photos should now fail' });
  } else {
    log.add('liveness_disabled', { level: 'warn', message: 'Liveness check turned OFF: a photo can now unlock (red-team mode)' });
  }
  if (mode === 'liveness' && !settings.liveness) setMode('face');
  updateSteps();
});

// X-ray switch + threshold
function setXray(on) {
  settings.xray = on;
  els.xrayToggle.checked = on;
  els.xrayCard.hidden = !on;
  els.stage.classList.toggle('xray', on);
  if (on) {
    xray.drawEmbedding(enrolled, null);
    xray.drawChart(distanceHistory, settings.threshold, performance.now());
  }
}
els.xrayToggle.addEventListener('change', () => {
  setXray(els.xrayToggle.checked);
  saveSettings();
});

els.thresholdInput.addEventListener('input', () => {
  settings.threshold = Number(els.thresholdInput.value);
  updateThresholdUI();
  xray.drawChart(distanceHistory, settings.threshold, performance.now());
});
els.thresholdInput.addEventListener('change', () => {
  const t = settings.threshold;
  log.add('threshold_changed', {
    level: t > CONFIG.defaultThreshold ? 'warn' : 'info',
    message: `Match threshold set to ${t.toFixed(2)}${t > CONFIG.defaultThreshold ? ' (looser: more false accepts)' : t < CONFIG.defaultThreshold ? ' (stricter: more false rejects)' : ' (default)'}`,
    fields: { threshold: t },
  });
});

els.exportBtn.addEventListener('click', () => log.download());
els.clearLogBtn.addEventListener('click', () => log.clear());

// Vault
els.gesturePinBtn.addEventListener('click', startPinEntry);
els.pinCancel.addEventListener('click', () => {
  stopPinEntry();
  renderVault();
  setStatus('Gesture PIN cancelled.');
});
els.vaultSubmit.addEventListener('click', () => submitSecret(els.vaultSecret.value, /^[1-5]+$/.test(els.vaultSecret.value) ? 'typed PIN' : 'passphrase'));
els.vaultSecret.addEventListener('input', updateStrength);
els.vaultSecret.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') els.vaultSubmit.click();
});
els.vaultNotes.addEventListener('input', () => { vault.dirty = true; });
els.vaultSave.addEventListener('click', saveVault);
els.vaultLock.addEventListener('click', closeVault);
els.vaultDelete.addEventListener('click', () => {
  // Two clicks within 3 s: deleting is permanent (there is no recovery without the secret anyway)
  const now = performance.now();
  if (now - vault.deleteArmedAt > 3000) {
    vault.deleteArmedAt = now;
    els.vaultDelete.textContent = 'Click again to delete';
    setTimeout(() => { els.vaultDelete.textContent = 'Delete vault'; }, 3000);
    return;
  }
  vault.deleteArmedAt = -Infinity;
  els.vaultDelete.textContent = 'Delete vault';
  vaultStore.clear();
  Object.assign(vault, { record: null, key: null, salt: null, dirty: false });
  els.vaultNotes.value = '';
  log.add('vault_deleted', { level: 'warn', message: 'Vault deleted: ciphertext removed from this browser' });
  renderVault();
});
els.tamperBtn.addEventListener('click', async () => {
  if (!vault.key || !vault.record) return;
  try {
    await decryptNotes(vault.key, tamperedCopy(vault.record));
    els.tamperResult.textContent = 'Unexpected: the tampered copy decrypted.';
  } catch {
    els.tamperResult.textContent = 'Rejected. Flipping one bit of the ciphertext breaks the AES-GCM authentication tag, so nobody can silently edit your notes either.';
    log.add('vault_tamper_test', { outcome: 'success', message: 'Tampered ciphertext rejected by AES-GCM (integrity check works)' });
  }
});

window.addEventListener('resize', () => {
  if (!settings.xray) return;
  xray.drawEmbedding();
  xray.drawChart();
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

enrolled = store.load();
updateThresholdUI();
setMode('landing');
setXray(settings.xray);
log.add('session_start', { message: 'Page loaded. The camera is off until you press "Start camera".' });
if (enrolled) setStatus('A face is already enrolled in this browser. Press "Start camera" to unlock.');
requestAnimationFrame(frame);

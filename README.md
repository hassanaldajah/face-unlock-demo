# Face + Gesture Unlock: a biometric security lab

**Live demo:** https://face.al-hassan.dev

An educational, browser-only demo of a biometric "unlock". Your face is matched against a face you enrolled, a random liveness challenge checks you are not a photo, and then you pinch a slider handle with your hand in the air and drag it to the end.

Around it is a small **security lab**. You play the red team (fool it with a photo, brute-force it), watch the blue-team defences react (liveness check, rate limiting, lockout), and read every attempt in a SOC-style event log that exports as ECS JSON.

I built it as a cybersecurity student to learn browser-based computer vision and to show how biometric authentication is attacked and defended.

> **Educational demo.** Camera-based face matching can be fooled by photos and is not suitable for real security.

## How it works

```
Start camera -> Enroll -> 1. Face match -> 2. Liveness check -> 3. Pinch & slide -> Unlocked
                                            (random challenges)                     (fist = lock)
```

1. **Consent first.** Nothing touches the camera until you press **Start camera**.
2. **Enroll.** Five face samples are taken over about 2.5 seconds. Each sample is a 128-number *face descriptor* (an embedding) from face-api's recognition network. The five are averaged and saved to `localStorage`. If one sample is far from the average (two people in view, head turned), enrollment is rejected and nothing is saved.
3. **Face match.** About every 350 ms the live descriptor is compared with the enrolled one using Euclidean distance. A distance **below 0.5, held for 1 second**, counts as a match. The distance is shown live.
4. **Liveness check.** Two random challenges out of *blink*, *turn left*, *turn right* and *open your mouth*, 7 seconds each. They are measured from the 68 face landmarks against your own neutral face:
   - blink: eye aspect ratio (eye height / width) drops and recovers;
   - head turn: where the nose tip sits along the jaw line;
   - mouth: inner-lip gap / mouth width.

   The same face has to stay in view the whole time (the descriptor is re-checked every few frames).
5. **Slide to unlock.** MediaPipe tracks up to two hands (21 landmarks each). Your index fingertip becomes a cursor. Pinch over the handle to grab it, drag it along the track, and let go at the end. Let go early and it springs back.
6. **Unlocked.** Hold a closed fist for 1 second (or press **Lock again**) to lock and go back to step 1. **Delete my face data** clears `localStorage`.
7. **Vault.** Behind the lock sits a vault of encrypted notes, opened with a 6-digit **gesture PIN** (hold up 1 to 5 fingers per digit) or a typed passphrase.

## The vault: authentication vs encryption

The face check is *authentication*: it decides who may open the door. But it runs in the browser, so anyone who edits the JavaScript can walk past it. The vault is *encryption*: it protects the data itself, so getting past the door is not enough.

```
secret (gesture PIN or passphrase)
   --PBKDF2-SHA256, 600,000 rounds, random 16-byte salt-->  AES-256-GCM key (memory only)
notes --AES-GCM, fresh random 96-bit IV on every save-->  ciphertext + authentication tag
```

- `localStorage` only holds the salt, the IV and the ciphertext. The secret and the key are never stored or logged.
- The key is dropped from memory when you lock (fist, button or **Lock vault**).
- A wrong secret and a tampered ciphertext fail the same way: the GCM authentication tag does not verify. The **tamper test** flips one bit to show it.
- The **attacker view** shows exactly what someone who bypasses the lock would find.
- The face is not the key on purpose: a face descriptor is slightly different every time, while a key must be identical bit for bit, and the enrolled descriptor is readable in `localStorage` anyway.
- The strength meter is honest. A 6-digit gesture PIN has only 5^6 = 15,625 options, and the page measures how long trying them all takes on your device (under an hour on a laptop, far less on a GPU cracker). A long passphrase takes millions of years. **The secret's strength matters more than the algorithm's.**
- No recovery: forget the secret and the notes are gone. Wrong secrets count towards the lockout.

### Gesture controls

| Gesture | Action | How it is detected |
|---|---|---|
| **move** | move the cursor | index fingertip (landmark 8), mirrored to match the selfie view, smoothed with a low-pass filter (lerp 0.3 per frame) |
| **pinch** | grab the handle | thumb tip (4) to index tip (8) distance < 0.35 x hand size (wrist to middle knuckle), released above 0.5, with a 3-frame debounce |
| **fist** | lock again | all four fingertips closer to the wrist than their middle joints (PIP), smoothed over several frames, held for 1 s |

- Both hands work; whichever pinches on the handle first takes it.
- If the hand holding the handle is lost for more than 500 ms, the handle is released.
- The cursor is a glowing ring; it turns into a smaller solid dot while you pinch.

## Security lab

### Red team: try to fool it

1. **Photo attack.** Turn the **Liveness check** switch off and hold a photo of yourself (on your phone) up to the camera. Face matching alone lets it in, and the log flags the unlock as a warning.
2. **Same photo, liveness on.** Switch it back on. The photo cannot blink, turn or open its mouth on command, so it fails.
3. **Brute force.** Fail 5 times within a minute (someone else's face, or the photo) and watch the 30-second lockout and the alert in the log.

### Blue team: defences

| Defence | What it does | Real-world reference |
|---|---|---|
| Random liveness challenge | 2 random actions a flat photo cannot perform | Presentation attack detection, ISO/IEC 30107 |
| Continuous identity | The same face must stay in view during the challenge | Session binding |
| Rate limiting + lockout | 5 failures in 60 s lock the face step; each repeat lockout is 4x longer (30 s up to 15 min) | NIST SP 800-63B caps failed biometric attempts |
| Protected enrollment | Re-enrolling only after unlocking, so nobody can swap in their own face | Phones ask for the passcode before changing Face ID |
| Encryption at rest | Vault notes are AES-256-GCM encrypted with a key derived from your secret | Data protection keys (iOS / Android) |
| Audit trail | Every attempt logged, exportable as ECS-style JSON | SIEM ingestion (Elastic Common Schema) |
| Secure defaults | Liveness on and threshold 0.50 again on every page load | Secure by default |

### X-ray view

Turn on **X-ray view** to see what the matcher sees:

- the 68 face landmarks, with the eyes, mouth, jaw line and nose tip the liveness check measures;
- the face embedding as a heat strip (enrolled, live, difference);
- the match distance over the last 20 seconds against the threshold line;
- a **threshold slider** (0.30 to 0.70) to feel the trade-off between false rejects (too strict) and false accepts (too loose).

### Event log

Events: `session_start`, `camera_started`, `enroll`, `face_match`, `face_mismatch`, `liveness_start`, `liveness_step`, `liveness_pass`, `liveness_fail`, `lockout`, `lockout_end`, `unlock`, `lock`, `liveness_enabled` / `liveness_disabled`, `threshold_changed`, `template_deleted`.

**Export JSON** downloads them as ECS-style documents, for example:

```json
{
  "@timestamp": "2026-10-26T10:17:03.412Z",
  "event.kind": "event",
  "event.category": ["authentication"],
  "event.action": "liveness_fail",
  "event.outcome": "failure",
  "log.level": "warn",
  "message": "Liveness check failed: no \"turn your head to the left\" within 7 s",
  "face_unlock.challenge": "left",
  "observer.product": "face-unlock-demo"
}
```

The log lives in memory only and never contains images or face descriptors.

### Threat model

| Attack | In this demo | What real systems add |
|---|---|---|
| Photo of the owner | Blocked by the liveness challenge | Depth / infrared cameras |
| Video replay | Usually blocked (must do the right random action in 7 s) | Depth sensing, screen-reflection and texture analysis |
| Someone else's face, repeatedly | Rejected; lockout after 5 failures, longer each time | Counters in tamper-resistant storage, passcode fallback |
| Enroll over the owner's face | Re-enroll only after unlocking | Passcode required to change biometrics |
| Edit the JavaScript in DevTools | Passes the lock, but the vault stays encrypted | Matching inside secure hardware or on a server |
| Copy the vault, guess offline | 600,000 PBKDF2 rounds per guess; a gesture PIN still falls in under an hour, a passphrase does not | Hardware retry limits (phones can wipe keys after 10 wrong passcodes) |
| Reload to reset the lockout | The lockout survives a reload; clearing `localStorage` resets it (documented limit) | Counters in tamper-resistant storage |
| Steal the stored template | 128 numbers, not a photo; delete anytime | Encrypted templates in a secure enclave |

Anything that runs fully in the browser can be changed by the person using the browser. The demo shows the ideas; it is not the real thing.

## Tech

- Plain HTML, CSS and JavaScript (ES modules). No framework, no build step, no backend.
- [`@vladmandic/face-api`](https://github.com/vladmandic/face-api) 1.7.15: `tinyFaceDetector` + `faceLandmark68Net` + `faceRecognitionNet` (MIT).
- [`@mediapipe/tasks-vision`](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker) 0.10.35, the current MediaPipe **Hand Landmarker** (Apache 2.0). It uses the GPU and falls back to the CPU.
- Libraries are self-hosted in `vendor/` (SHA-256 hashes in `vendor/SHA256SUMS`). All model weights are self-hosted in [`models/`](models/).
- A strict Content-Security-Policy allows scripts only from this site.

```
index.html     page structure: stage, controls, security lab
style.css      dark "scanner" UI, responsive down to phones
app.js         camera, models, enrollment, matching, liveness, rate limiting, hands, drawing
gestures.js    pure math: pinch, fist, finger counting, gesture-PIN entry, smoothing, coordinate mapping
liveness.js    pure math: eye aspect ratio, head turn, mouth opening, random challenges
vault.js       Web Crypto: PBKDF2 key derivation, AES-GCM encrypt/decrypt, strength estimate
eventlog.js    SOC-style event log + ECS JSON export
xray.js        embedding heat strip + distance timeline
vendor/        self-hosted face-api and MediaPipe libraries + SHA256SUMS
models/        face-api weights (+ manifests) and MediaPipe hand_landmarker.task
```

## Run it locally

The camera only works on `https://` or on `localhost` / `127.0.0.1`, so open the folder through a local server (not as a `file://` page).

**VS Code Live Server:** open the folder, right-click `index.html`, choose **Open with Live Server**, then go to http://127.0.0.1:5500.

**Or from a terminal:**

```bash
npx serve .                # http://localhost:3000
# or
python -m http.server 5500 # http://127.0.0.1:5500
```

The first start downloads about 15 MB of models and libraries. After that the browser cache makes it fast.

## Privacy

- Everything runs **in your browser**. The video stream is never uploaded or recorded; there is no server code and no analytics.
- The only things stored are **one averaged 128-number face descriptor** in this browser's `localStorage` (key `face-unlock-demo:v1`), your **encrypted** vault if you create one (`face-unlock-demo:vault`), and whether you like the X-ray view on. Nothing is a photo, and nothing leaves your device.
- **Delete my face data** removes it. Clearing your browser's site data does the same.
- If the browser blocks storage (for example some browsers inside an iframe), the descriptor is kept in memory only and is gone when you close the tab.

## Limitations

- Without the liveness check, **a photo can unlock it**. With it, a photo fails, but a good video replay that happens to do the right actions, or a 3D mask, could still pass. Real systems use depth or infrared sensors.
- The 0.5 distance threshold is the common face-api default. Lookalikes or siblings can match, and bad lighting can stop a real match.
- Strong backlight, very dim rooms, sunglasses and big head turns make the face and hand trackers less reliable.
- Everything is client-side, so anyone can change the code in DevTools or clear `localStorage` to reset the lockout.
- Performance depends on the device; older phones may track hands at a low frame rate.

## Credits

- Face recognition: [vladmandic/face-api](https://github.com/vladmandic/face-api) (MIT), based on [justadudewhohacks/face-api.js](https://github.com/justadudewhohacks/face-api.js).
- Hand tracking: [Google MediaPipe](https://github.com/google-ai-edge/mediapipe) Hand Landmarker (Apache 2.0).
- Eye aspect ratio: Soukupová & Čech, *Real-Time Eye Blink Detection using Facial Landmarks* (2016).

Built by [Hassan Aldajah](https://al-hassan.dev) as a learning project.

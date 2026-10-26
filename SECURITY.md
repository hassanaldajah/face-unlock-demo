# Security policy

Face + Gesture Unlock is an **educational** browser demo. Camera-based face matching can be fooled
by photos and is not suitable for real security. Everything runs client-side: there is no server,
no account and no upload.

## Reporting a vulnerability

Please use GitHub's private reporting:
<https://github.com/hassanaldajah/face-unlock-demo/security/advisories/new>

Include the steps to reproduce and the browser you used. Please do not open a public issue for
a vulnerability. I aim to reply within 7 days.

## In scope

- Bypasses of the CSP or script injection (XSS) on face.al-hassan.dev
- Flaws in the vault encryption (PBKDF2-SHA256 + AES-256-GCM) or in key handling
- Ways to read the stored face template or vault from another origin

## Out of scope (documented limits of a client-side demo)

- Editing the JavaScript in DevTools to skip the face/hand checks (the vault stays encrypted)
- Clearing or editing localStorage to reset the lockout counter
- Fooling the matcher with a 3D mask or deepfake

## Dependencies (self-hosted in `vendor/`)

| Library | Version |
|---|---|
| @vladmandic/face-api | 1.7.15 |
| @mediapipe/tasks-vision | 0.10.35 |

SHA-256 hashes of every vendored file are in `vendor/SHA256SUMS`. Verify them with
`sha256sum -c vendor/SHA256SUMS` (run from the repository root).

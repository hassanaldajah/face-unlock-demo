/**
 * vault.js: encrypted notes behind the lock.
 *
 * The face check decides who may *open the door*; this file protects the
 * *data itself*. Even someone who bypasses the face check (for example by
 * editing app.js in DevTools) only finds ciphertext, because the key comes
 * from a secret that is never stored anywhere: your gesture PIN or passphrase.
 *
 *   secret --PBKDF2-SHA256, 600,000 rounds, random salt--> AES-256-GCM key
 *   notes  --AES-GCM, random 96-bit IV per save---------> ciphertext + auth tag
 *
 * localStorage only ever holds { salt, iv, ciphertext }. The key exists in
 * memory while the vault is open and is dropped when it locks.
 *
 * Why not use the face as the key? A face descriptor is slightly different
 * every time (light, angle), while a key must be bit-for-bit identical, and
 * the enrolled descriptor sits readable in localStorage anyway.
 *
 * Uses only the browser's built-in Web Crypto API (crypto.subtle).
 */

export const KDF_ITERATIONS = 600000; // OWASP's 2023 recommendation for PBKDF2-HMAC-SHA256
const STORAGE_KEY = 'face-unlock-demo:vault';
// Additional authenticated data: binds the ciphertext to this app and format version
const AAD = new TextEncoder().encode('face-unlock-demo:vault:v1');

const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** Turn a secret into a non-extractable AES-GCM key. Slow on purpose: every guess costs the same. */
export async function deriveKey(secret, salt, iterations = KDF_ITERATIONS) {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt text into a storable record (salt is kept from the vault's creation). */
export async function encryptNotes(key, salt, text, iterations = KDF_ITERATIONS) {
  const iv = crypto.getRandomValues(new Uint8Array(12)); // never reuse an IV with the same key
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, key, new TextEncoder().encode(text));
  return {
    v: 1,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations, salt: toB64(salt) },
    cipher: 'AES-256-GCM',
    iv: toB64(iv),
    ct: toB64(ct),
  };
}

/**
 * Decrypt a record. Throws if the key is wrong *or* the ciphertext was changed:
 * GCM's authentication tag cannot tell the two apart, and that is the point.
 */
export async function decryptNotes(key, record) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(record.iv), additionalData: AAD },
    key,
    fromB64(record.ct),
  );
  return new TextDecoder().decode(plain);
}

/** A copy of the record with one bit of the ciphertext flipped (integrity demo). */
export function tamperedCopy(record) {
  const ct = fromB64(record.ct);
  ct[Math.floor(ct.length / 2)] ^= 0x01;
  return { ...record, ct: toB64(ct) };
}

export const saltOf = (record) => fromB64(record.kdf.salt);
export const newSalt = () => crypto.getRandomValues(new Uint8Array(16));

/**
 * Rough strength of a secret: how many guesses an attacker with the stored
 * ciphertext needs in the worst case. A gesture PIN only uses the digits 1-5.
 */
export function secretStrength(secret) {
  let pool;
  if (/^[1-5]+$/.test(secret)) {
    pool = 5;
  } else {
    pool = 0;
    if (/[a-z]/.test(secret)) pool += 26;
    if (/[A-Z]/.test(secret)) pool += 26;
    if (/[0-9]/.test(secret)) pool += 10;
    if (/[^a-zA-Z0-9]/.test(secret)) pool += 33;
  }
  const bits = secret.length * Math.log2(Math.max(pool, 1));
  return { pool, bits, guesses: Math.pow(2, bits) };
}

export const vaultStore = {
  load() {
    try {
      const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      return data?.v === 1 && data.ct && data.iv && data.kdf?.salt ? data : null;
    } catch {
      return null;
    }
  },
  save(record) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(record)); return true; } catch { return false; }
  },
  clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ }
  },
};

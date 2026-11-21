import crypto from 'node:crypto';

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/** Hash a plaintext password with a random 16-byte salt using scrypt. */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

/** Verify a plaintext password against a stored scrypt hash in constant time. */
export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const [, salt, expectedHex] = parts;
  const derived = crypto.scryptSync(String(password), salt, 64, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  const expected = Buffer.from(expectedHex, 'hex');
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

/** Sign a JSON payload as a compact HMAC-SHA256 bearer/cookie token. */
export function signToken(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
  return `${body}.${sig}`;
}

/** Verify and decode an HMAC-SHA256 signed token; returns null if invalid or expired. */
export function verifyToken(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.indexOf('.');
  if (idx <= 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac('sha256', String(secret)).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

/** Derive a 32-byte key from MASTER_KEY and encrypt plaintext with AES-256-GCM. */
export function encryptSecret(plaintext, masterKey) {
  const key = crypto.createHash('sha256').update(String(masterKey)).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

/** Decrypt AES-256-GCM ciphertext produced by encryptSecret. */
export function decryptSecret(ciphertext, masterKey) {
  const [ivB64, tagB64, encB64] = String(ciphertext).split('.');
  const key = crypto.createHash('sha256').update(String(masterKey)).digest();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(encB64, 'base64url')), decipher.final()]).toString('utf8');
}

export function randomId(prefix = '') {
  const id = crypto.randomUUID();
  return prefix ? `${prefix}_${id}` : id;
}

export function newOrderNo(slug = 'ORD') {
  const code = String(slug).replace(/[^a-z0-9]/gi, '').slice(0, 4).toUpperCase() || 'ORD';
  const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
  const ts = Date.now().toString(36).slice(-4).toUpperCase();
  return `${code}-${ts}${rand}`;
}

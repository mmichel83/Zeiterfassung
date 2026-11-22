/*
 * Zeiterfassung – Mitteilungen aufs Handy (Web Push)
 *
 * Ohne Fremdpakete, nur mit node:crypto:
 *  - VAPID-Anmeldung (RFC 8292): JWT mit ES256 signiert
 *  - Verschlüsselung der Nachricht (RFC 8291, Content-Encoding aes128gcm)
 */
'use strict';
const crypto = require('node:crypto');

const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Erlaubte Push-Dienste (Apple, Google, Mozilla, Microsoft). Schützt davor, dass der Server beliebige Adressen aufruft. */
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'android.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];

function allowedEndpoint(endpoint) {
  let u;
  try {
    u = new URL(endpoint);
  } catch (_) {
    return false;
  }
  if (u.protocol !== 'https:' || u.port) return false;
  return PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
}

function generateVapidKeys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: b64u(raw), privateJwk: privateKey.export({ format: 'jwk' }) };
}

/** Authorization-Header für einen Push-Dienst */
function vapidHeader(endpoint, keys, subject, nowMs) {
  const aud = new URL(endpoint).origin;
  const header = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject }));
  const key = crypto.createPrivateKey({ key: keys.privateJwk, format: 'jwk' });
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${payload}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${payload}.${b64u(sig)}, k=${keys.publicKey}`;
}

/** Verschlüsselt den Inhalt für ein Abo (p256dh, auth aus dem Browser) */
function encrypt(plaintext, p256dh, auth) {
  const uaPublic = Buffer.from(p256dh, 'base64url');
  const authSecret = Buffer.from(auth, 'base64url');
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('Ungültige Abo-Schlüssel');
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const shared = ecdh.computeSecret(uaPublic);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(crypto.hkdfSync('sha256', shared, authSecret, keyInfo, 32));
  const salt = crypto.randomBytes(16);
  const cek = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), // 0x02 = letzter Block
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const head = Buffer.alloc(21);
  salt.copy(head, 0);
  head.writeUInt32BE(4096, 16);
  head[20] = asPublic.length;
  return Buffer.concat([head, asPublic, body]);
}

/**
 * Schickt eine Mitteilung an ein Abo.
 * @returns {Promise<number>} HTTP-Status des Push-Dienstes (404/410 = Abo ist weg)
 */
async function sendPush(sub, data, keys, subject, nowMs) {
  if (!allowedEndpoint(sub.endpoint)) return 410;
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '43200',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: vapidHeader(sub.endpoint, keys, subject, nowMs),
    },
    body: encrypt(JSON.stringify(data), sub.p256dh, sub.auth),
    signal: AbortSignal.timeout(10000),
  });
  return res.status;
}

module.exports = { allowedEndpoint, generateVapidKeys, vapidHeader, encrypt, sendPush };

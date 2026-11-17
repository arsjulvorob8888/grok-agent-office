'use strict';

// AES-256-GCM для URL и ключа вебхука. Наружу уходит только шифротекст.
// Ключ — WEBHOOK_SECRETS_KEY, 32 байта в base64. IV свой у каждой записи.

const crypto = require('crypto');

const NO_KEY = 'Не задан WEBHOOK_SECRETS_KEY, вебхук не сохранён';
const BAD_LENGTH = 'WEBHOOK_SECRETS_KEY должен быть 32 байта в base64';
const BAD_KEY = 'Ключ WEBHOOK_SECRETS_KEY не подходит, вебхук не прочитан';

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function secretsKey(env) {
  const raw = env && env.WEBHOOK_SECRETS_KEY;
  if (raw == null || String(raw).trim() === '') throw fail('NO_SECRETS_KEY', NO_KEY);
  const buf = Buffer.from(String(raw).trim(), 'base64');
  if (buf.length !== 32) throw fail('BAD_KEY_LENGTH', BAD_LENGTH);
  return buf;
}

function seal(id, payload, env) {
  const key = secretsKey(env);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(String(id), 'utf8'));
  const plain = Buffer.from(JSON.stringify({
    url: payload && typeof payload.url === 'string' ? payload.url : '',
    key: payload && typeof payload.key === 'string' ? payload.key : '',
  }), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

function open(id, record, env) {
  const key = secretsKey(env);
  try {
    if (!record || !record.iv || !record.tag || !record.ciphertext) throw fail('BAD_SECRETS_KEY', BAD_KEY);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(record.iv, 'base64'));
    decipher.setAAD(Buffer.from(String(id), 'utf8'));
    decipher.setAuthTag(Buffer.from(record.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]);
    const parsed = JSON.parse(plain.toString('utf8'));
    if (!parsed || typeof parsed.url !== 'string' || typeof parsed.key !== 'string') {
      throw fail('BAD_SECRETS_KEY', BAD_KEY);
    }
    return { url: parsed.url, key: parsed.key };
  } catch (err) {
    if (err && (err.code === 'NO_SECRETS_KEY' || err.code === 'BAD_KEY_LENGTH' || err.code === 'BAD_SECRETS_KEY')) throw err;
    throw fail('BAD_SECRETS_KEY', BAD_KEY);
  }
}

function publicDelivery(secret) {
  const url = secret && typeof secret.url === 'string' ? secret.url : '';
  const hookKey = secret && typeof secret.key === 'string' ? secret.key : '';
  return {
    url,
    keySet: hookKey.length > 0,
    keyTail: hookKey.length ? hookKey.slice(-4) : '',
  };
}

module.exports = { seal, open, publicDelivery, secretsKey };

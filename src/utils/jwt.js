'use strict';
/**
 * Minimal JWT (HS256) using Node's built-in crypto — no external dependency.
 * Interface mirrors jsonwebtoken (sign/verify) so it can be swapped 1:1 in prod.
 */
const crypto = require('node:crypto');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const EXP_SECONDS = 60 * 60 * 24; // 24h for demo; use 15m + refresh in prod

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

function sign(payload, exp = EXP_SECONDS) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + exp };
  const head = b64urlJson(header);
  const data = b64urlJson(body);
  const sig = b64url(crypto.createHmac('sha256', SECRET).update(`${head}.${data}`).digest());
  return `${head}.${data}.${sig}`;
}

function verify(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) throw new Error('Malformed token');
  const [head, data, sig] = parts;
  const expected = b64url(crypto.createHmac('sha256', SECRET).update(`${head}.${data}`).digest());
  const a = Buffer.from(sig); const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error('Bad signature');
  const body = JSON.parse(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
  if (body.exp && Math.floor(Date.now() / 1000) > body.exp) throw new Error('Token expired');
  return body;
}

module.exports = { sign, verify };

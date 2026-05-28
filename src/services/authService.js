'use strict';
/**
 * Auth service — registration and PIN login.
 * Uses Node's built-in scrypt for PIN hashing (no external bcrypt needed;
 * scrypt is a strong, salted KDF shipped in Node core). In production you may
 * swap to bcrypt — the interface here (hashPin/verifyPin) stays identical.
 */
const crypto = require('node:crypto');
const jwt = require('../utils/jwt');
const { sequelize } = require('../config/database');
const { User, Account, Savings, AuditLog } = require('../models');

function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPin(pin, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  // constant-time compare
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function genAccountNumber() {
  return '00' + Math.floor(100000000 + Math.random() * 899999999);
}

async function register(payload) {
  const { fullName, phone, email, pin, roundup_preference = 'auto', roundup_amount = null } = payload;

  if (!/^0[2-5][0-9]{8}$/.test(phone || '')) throw httpErr(400, 'Invalid Ghana phone number');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email || '')) throw httpErr(400, 'Invalid email');
  if (!/^\d{4}$/.test(String(pin || ''))) throw httpErr(400, 'PIN must be exactly 4 digits');
  if (!['auto', 'manual'].includes(roundup_preference)) throw httpErr(400, 'Invalid savings preference');
  if (roundup_preference === 'manual') {
    const amt = parseFloat(roundup_amount);
    if (isNaN(amt) || amt < 0.01 || amt > 1000) throw httpErr(400, 'Manual amount must be 0.01–1000');
  }

  return sequelize.transaction(async (t) => {
    const user = await User.create({
      full_name: fullName, phone, email,
      pin_hash: hashPin(pin),
      roundup_preference,
      roundup_amount: roundup_preference === 'manual' ? parseFloat(roundup_amount) : null,
    }, { transaction: t });

    // Every user gets a Current account + a Savings record on signup.
    await Account.create({
      user_id: user.id, type: 'current', name: 'Main Account',
      account_number: genAccountNumber(), balance: 0, is_private: true,
    }, { transaction: t });
    await Savings.create({ user_id: user.id }, { transaction: t });
    await AuditLog.create({ user_id: user.id, action: 'REGISTER' }, { transaction: t });

    return {
      userId: user.id,
      roundup_preference: user.roundup_preference,
      token: jwt.sign({ uid: user.id }),
    };
  });
}

async function login({ phone, pin }) {
  const user = await User.findOne({ where: { phone } });
  if (!user) throw httpErr(401, 'Invalid credentials');
  if (user.locked) throw httpErr(423, 'Account locked. Contact support.');

  if (!verifyPin(pin, user.pin_hash)) {
    user.failed_pin_attempts += 1;
    if (user.failed_pin_attempts >= 5) user.locked = true;
    await user.save();
    await AuditLog.create({ user_id: user.id, action: 'LOGIN_FAIL',
      metadata: { attempts: user.failed_pin_attempts } });
    throw httpErr(401, user.locked ? 'Account locked after 5 failed attempts' : 'Invalid credentials');
  }

  user.failed_pin_attempts = 0;
  await user.save();
  await AuditLog.create({ user_id: user.id, action: 'LOGIN_OK' });
  return { userId: user.id, token: jwt.sign({ uid: user.id }) };
}

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

module.exports = { register, login, hashPin, verifyPin, httpErr, genAccountNumber };

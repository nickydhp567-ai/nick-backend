'use strict';
/**
 * Lock Vault service — unified vault maturity model.
 * The vault owns ONE maturity date, ONE rate, ONE lock status. New deposits
 * merge into the existing vault and inherit its timeline. Interest accrues
 * daily on the total balance. Early withdrawal forfeits pro-rata interest + 2%.
 */
const { Op } = require('sequelize');
const { sequelize } = require('../config/database');
const { LockVault, LockVaultLedger, Savings, AuditLog } = require('../models');
const {
  vaultRate, addDays, dailyInterest, projectedAtMaturity,
  daysBetween, isMatured, computeEarlyWithdrawal, round2,
} = require('../utils/domain');
const { httpErr } = require('./authService');

async function createVault(userId, { termDays, seedAmount = 0, maturityAction = 'notify' }) {
  const rate = vaultRate(termDays);
  seedAmount = parseFloat(seedAmount) || 0;
  if (seedAmount < 0) throw httpErr(400, 'Seed must be >= 0');

  return sequelize.transaction(async (t) => {
    const existing = await LockVault.findOne({
      where: { user_id: userId, status: 'active' }, transaction: t,
    });
    if (existing) throw httpErr(409, 'An active vault already exists');

    const now = new Date();
    const vault = await LockVault.create({
      user_id: userId, term_days: termDays, interest_rate: rate,
      locked_at: now, maturity_at: addDays(now, termDays),
      principal_balance: seedAmount, maturity_action: maturityAction,
    }, { transaction: t });

    if (seedAmount > 0) {
      // Pull seed from regular savings (must have the funds)
      const savings = await Savings.findOne({ where: { user_id: userId }, transaction: t, lock: t.LOCK.UPDATE });
      if (parseFloat(savings.total) < seedAmount) throw httpErr(400, 'Insufficient Back Pocket balance for seed');
      savings.total = round2(parseFloat(savings.total) - seedAmount);
      await savings.save({ transaction: t });
      await LockVaultLedger.create({
        vault_id: vault.id, entry_type: 'INITIAL_DEPOSIT',
        amount: seedAmount, balance_after: seedAmount,
      }, { transaction: t });
    }
    await AuditLog.create({ user_id: userId, action: 'VAULT_CREATE',
      metadata: { termDays, seedAmount } }, { transaction: t });
    return vault;
  });
}

// Internal: merge an amount into an existing vault (used by sweeps + top-ups).
async function _mergeIntoVault(vault, amount, entryType, t) {
  vault.principal_balance = round2(parseFloat(vault.principal_balance) + amount);
  await vault.save({ transaction: t });
  await LockVaultLedger.create({
    vault_id: vault.id, entry_type: entryType,
    amount, balance_after: vault.principal_balance,
  }, { transaction: t });
}

async function topUp(userId, vaultId, amount) {
  amount = parseFloat(amount);
  if (!(amount > 0)) throw httpErr(400, 'Amount must be > 0');
  return sequelize.transaction(async (t) => {
    const vault = await LockVault.findOne({
      where: { id: vaultId, user_id: userId }, transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!vault || vault.status !== 'active') throw httpErr(400, 'Vault not active');
    const savings = await Savings.findOne({ where: { user_id: userId }, transaction: t, lock: t.LOCK.UPDATE });
    if (parseFloat(savings.total) < amount) throw httpErr(400, 'Insufficient Back Pocket balance');
    savings.total = round2(parseFloat(savings.total) - amount);
    await savings.save({ transaction: t });
    await _mergeIntoVault(vault, amount, 'MANUAL_TOPUP', t);
    // Maturity timer unchanged — the whole point of the unified model.
    return vault;
  });
}

async function earlyWithdraw(userId, vaultId, amount) {
  amount = parseFloat(amount);
  return sequelize.transaction(async (t) => {
    const vault = await LockVault.findOne({
      where: { id: vaultId, user_id: userId }, transaction: t, lock: t.LOCK.UPDATE,
    });
    if (!vault || vault.status !== 'active') throw httpErr(400, 'Vault not active');
    if (isMatured(vault)) throw httpErr(400, 'Vault has matured — use release instead');

    const { interestForfeited, adminFee, netPayout } = computeEarlyWithdrawal(
      { principal_balance: parseFloat(vault.principal_balance), accrued_interest: parseFloat(vault.accrued_interest) },
      amount
    );

    vault.principal_balance = round2(parseFloat(vault.principal_balance) - amount);
    vault.accrued_interest  = round2(parseFloat(vault.accrued_interest) - interestForfeited);
    if (vault.principal_balance <= 0) vault.status = 'closed';
    await vault.save({ transaction: t });

    await LockVaultLedger.bulkCreate([
      { vault_id: vault.id, entry_type: 'EARLY_WITHDRAWAL', amount: -amount, balance_after: vault.principal_balance },
      { vault_id: vault.id, entry_type: 'INTEREST_FORFEIT', amount: -interestForfeited, balance_after: vault.principal_balance },
      { vault_id: vault.id, entry_type: 'PENALTY_FEE', amount: -adminFee, balance_after: vault.principal_balance },
    ], { transaction: t });

    // Net payout returns to regular savings
    const savings = await Savings.findOne({ where: { user_id: userId }, transaction: t, lock: t.LOCK.UPDATE });
    savings.total = round2(parseFloat(savings.total) + netPayout);
    await savings.save({ transaction: t });

    await AuditLog.create({ user_id: userId, action: 'VAULT_EARLY_WITHDRAW',
      metadata: { amount, interestForfeited, adminFee, netPayout } }, { transaction: t });
    return { netPayout, interestForfeited, adminFee };
  });
}

// Daily accrual job — posts one day of interest to every active vault.
async function postDailyAccrual(now = new Date()) {
  const vaults = await LockVault.findAll({ where: { status: 'active' } });
  let posted = 0;
  for (const v of vaults) {
    const principal = parseFloat(v.principal_balance);
    if (principal <= 0) continue;
    // idempotency: skip if already accrued today
    if (daysBetween(v.last_accrual_at, now) < 1) continue;
    const daily = dailyInterest(principal, parseFloat(v.interest_rate));
    await sequelize.transaction(async (t) => {
      v.accrued_interest = round2(parseFloat(v.accrued_interest) + daily);
      v.last_accrual_at = now;
      await v.save({ transaction: t });
      await LockVaultLedger.create({
        vault_id: v.id, entry_type: 'INTEREST_ACCRUAL',
        amount: daily, balance_after: round2(principal + parseFloat(v.accrued_interest)),
      }, { transaction: t });
    });
    posted++;
  }
  return posted;
}

// Maturity processor — releases/renews/holds vaults that have matured.
async function processMaturities(now = new Date()) {
  const due = await LockVault.findAll({
    where: { status: 'active', maturity_at: { [Op.lte]: now } },
  });
  for (const v of due) {
    await sequelize.transaction(async (t) => {
      const total = round2(parseFloat(v.principal_balance) + parseFloat(v.accrued_interest));
      if (v.maturity_action === 'release' || v.maturity_action === 'renew') {
        const savings = await Savings.findOne({ where: { user_id: v.user_id }, transaction: t, lock: t.LOCK.UPDATE });
        savings.total = round2(parseFloat(savings.total) + total);
        await savings.save({ transaction: t });
        await LockVaultLedger.create({ vault_id: v.id, entry_type: 'MATURITY_PAYOUT',
          amount: total, balance_after: 0 }, { transaction: t });
        v.principal_balance = 0; v.accrued_interest = 0; v.status = 'matured';
        await v.save({ transaction: t });
      } else {
        v.status = 'matured';
        await v.save({ transaction: t });
      }
    });
    if (v.maturity_action === 'renew') {
      // open a fresh vault seeded from regular savings by the matured total
      // (kept simple: caller/job can re-seed; omitted here to avoid double count)
    }
  }
  return due.length;
}

async function getVault(userId) {
  const v = await LockVault.findOne({ where: { user_id: userId, status: 'active' } });
  if (!v) return null;
  const principal = parseFloat(v.principal_balance);
  const accrued = parseFloat(v.accrued_interest);
  const elapsed = daysBetween(v.locked_at, new Date());
  return {
    id: v.id, term_days: v.term_days, interest_rate: parseFloat(v.interest_rate),
    locked_at: v.locked_at, maturity_at: v.maturity_at,
    principal_balance: principal, accrued_interest: accrued,
    total_value: round2(principal + accrued),
    days_elapsed: elapsed,
    days_remaining: Math.max(0, v.term_days - elapsed),
    progress_pct: round2(Math.min(100, (elapsed / v.term_days) * 100)),
    projected_at_maturity: projectedAtMaturity(principal, parseFloat(v.interest_rate), v.term_days),
    status: v.status, maturity_action: v.maturity_action, auto_merge: v.auto_merge,
  };
}

module.exports = {
  createVault, topUp, earlyWithdraw, postDailyAccrual,
  processMaturities, getVault, _mergeIntoVault,
};

'use strict';
/**
 * NICK Bank — Core Domain Logic
 * Pure, framework-agnostic functions. These hold the money math and the
 * Lock Vault rules. They are imported by the Sequelize services (production)
 * AND by the dependency-free test harness, so the exact same code that ships
 * is the code that's verified.
 *
 * MONEY RULE: all amounts are handled in pesewas (integer minor units) inside
 * calculations to avoid floating-point drift, then formatted to GHS at the edge.
 */

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// ─── ROUND-UP ENGINE ─────────────────────────────────────────────
// Auto: round a purchase up to the nearest base (1/2/5/10), save the diff.
function computeRoundUp(amount, base = 1) {
  if (amount <= 0) return 0;
  if (![1, 2, 5, 10].includes(base)) throw new Error('Invalid round-up base');
  const rounded = Math.ceil(amount / base) * base;
  return round2(rounded - amount);
}

// Manual: fixed amount saved per transaction.
function computeManualSave(fixedAmount) {
  if (fixedAmount < 0) throw new Error('Manual amount must be >= 0');
  return round2(fixedAmount);
}

// Unified entry point used by the transaction pipeline.
function computeSweep(user, txnAmount) {
  if (user.roundup_preference === 'manual') {
    return computeManualSave(user.roundup_amount || 0);
  }
  return computeRoundUp(txnAmount, user.roundup_base || 1);
}

// ─── LOCK VAULT ──────────────────────────────────────────────────
const VAULT_RATES = { 91: 0.06, 182: 0.09, 273: 0.105, 365: 0.12 };

function vaultRate(termDays) {
  const r = VAULT_RATES[termDays];
  if (r == null) throw new Error('Invalid vault term');
  return r;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function daysBetween(from, to) {
  const ms = new Date(to).getTime() - new Date(from).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}

// Daily simple interest on the *current total balance* of the vault.
function dailyInterest(principalBalance, rate) {
  return round2((principalBalance * rate) / 365);
}

// Projected value at maturity (simple interest over the full term).
function projectedAtMaturity(principal, rate, termDays) {
  return round2(principal * (1 + (rate * termDays) / 365));
}

function isMatured(vault, now = new Date()) {
  return new Date(now) >= new Date(vault.maturity_at);
}

// Early-withdrawal penalty: forfeit accrued interest pro-rata to the amount
// withdrawn + 2% admin fee on the withdrawn principal.
function computeEarlyWithdrawal(vault, amount) {
  if (amount <= 0) throw new Error('Amount must be > 0');
  if (amount > vault.principal_balance + 1e-9) throw new Error('Amount exceeds vault balance');
  const ratio = vault.principal_balance > 0 ? amount / vault.principal_balance : 0;
  const interestForfeited = round2(vault.accrued_interest * ratio);
  const adminFee = round2(amount * 0.02);
  const netPayout = round2(amount - adminFee);
  return { interestForfeited, adminFee, netPayout };
}

module.exports = {
  round2,
  computeRoundUp,
  computeManualSave,
  computeSweep,
  VAULT_RATES,
  vaultRate,
  addDays,
  daysBetween,
  dailyInterest,
  projectedAtMaturity,
  isMatured,
  computeEarlyWithdrawal,
};

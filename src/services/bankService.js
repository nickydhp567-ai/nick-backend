'use strict';
/**
 * Banking service — accounts and atomic money movement.
 * Every balance change runs inside a DB transaction with a row lock on the
 * account, then writes an immutable ledger row. Deposits/withdrawals trigger
 * the Back Pocket sweep (round-up or manual) which is auto-merged into an
 * active Lock Vault if one exists, else into regular savings.
 */
const { sequelize } = require('../config/database');
const { User, Account, Transaction, Savings, AuditLog, LockVault } = require('../models');
const { computeSweep, round2 } = require('../utils/domain');
const { httpErr, genAccountNumber } = require('./authService');
const vaultService = require('./vaultService');

async function listAccounts(userId) {
  return Account.findAll({ where: { user_id: userId }, order: [['createdAt', 'ASC']] });
}

async function openAccount(userId, { type, name }) {
  if (!['current', 'savings', 'fixed', 'business'].includes(type)) throw httpErr(400, 'Invalid account type');
  return Account.create({
    user_id: userId, type, name: name || `${type[0].toUpperCase()}${type.slice(1)} Account`,
    account_number: genAccountNumber(), balance: 0,
    is_private: type === 'current',
  });
}

// Lock + reload an account inside a transaction
async function lockAccount(accountId, userId, t) {
  const acct = await Account.findOne({
    where: { id: accountId, user_id: userId },
    transaction: t, lock: t.LOCK.UPDATE,
  });
  if (!acct) throw httpErr(404, 'Account not found');
  return acct;
}

async function deposit(userId, { accountId, amount, description, applySweep = true }) {
  amount = parseFloat(amount);
  if (!(amount > 0)) throw httpErr(400, 'Amount must be > 0');

  return sequelize.transaction(async (t) => {
    const acct = await lockAccount(accountId, userId, t);
    acct.balance = round2(parseFloat(acct.balance) + amount);
    await acct.save({ transaction: t });
    const txn = await Transaction.create({
      account_id: acct.id, type: 'deposit', amount, balance_after: acct.balance,
      description: description || 'Deposit', reference: ref('DEP'),
    }, { transaction: t });

    let sweep = null;
    if (applySweep) sweep = await runSweep(userId, amount, t);

    await AuditLog.create({ user_id: userId, action: 'DEPOSIT',
      metadata: { accountId, amount } }, { transaction: t });
    return { transaction: txn, balance: acct.balance, sweep };
  });
}

async function withdraw(userId, { accountId, amount, description }) {
  amount = parseFloat(amount);
  if (!(amount > 0)) throw httpErr(400, 'Amount must be > 0');

  return sequelize.transaction(async (t) => {
    const acct = await lockAccount(accountId, userId, t);
    if (parseFloat(acct.balance) < amount) throw httpErr(400, 'Insufficient funds');
    acct.balance = round2(parseFloat(acct.balance) - amount);
    await acct.save({ transaction: t });
    const txn = await Transaction.create({
      account_id: acct.id, type: 'withdraw', amount, balance_after: acct.balance,
      description: description || 'Withdrawal', reference: ref('WDR'),
    }, { transaction: t });
    await AuditLog.create({ user_id: userId, action: 'WITHDRAW',
      metadata: { accountId, amount } }, { transaction: t });
    return { transaction: txn, balance: acct.balance };
  });
}

async function transfer(userId, { fromAccountId, toAccountId, amount, description }) {
  amount = parseFloat(amount);
  if (!(amount > 0)) throw httpErr(400, 'Amount must be > 0');
  if (fromAccountId === toAccountId) throw httpErr(400, 'Cannot transfer to same account');

  return sequelize.transaction(async (t) => {
    // Lock both accounts in a stable order to avoid deadlocks
    const [aId, bId] = [fromAccountId, toAccountId].sort();
    const locked = {};
    locked[aId] = await Account.findOne({ where: { id: aId }, transaction: t, lock: t.LOCK.UPDATE });
    locked[bId] = await Account.findOne({ where: { id: bId }, transaction: t, lock: t.LOCK.UPDATE });
    const from = locked[fromAccountId], to = locked[toAccountId];
    if (!from || from.user_id !== userId) throw httpErr(404, 'Source account not found');
    if (!to) throw httpErr(404, 'Destination account not found');
    if (parseFloat(from.balance) < amount) throw httpErr(400, 'Insufficient funds');

    from.balance = round2(parseFloat(from.balance) - amount);
    to.balance   = round2(parseFloat(to.balance) + amount);
    await from.save({ transaction: t });
    await to.save({ transaction: t });

    const r = ref('TRF');
    await Transaction.create({ account_id: from.id, type: 'transfer_out', amount,
      balance_after: from.balance, description: description || 'Transfer', reference: r }, { transaction: t });
    await Transaction.create({ account_id: to.id, type: 'transfer_in', amount,
      balance_after: to.balance, description: description || 'Transfer', reference: r }, { transaction: t });
    await AuditLog.create({ user_id: userId, action: 'TRANSFER',
      metadata: { fromAccountId, toAccountId, amount } }, { transaction: t });
    return { reference: r, fromBalance: from.balance, toBalance: to.balance };
  });
}

// ─── Back Pocket sweep ───
// Computes the round-up/manual save, then routes it: into an active Lock Vault
// (auto-merge) if one exists, otherwise into the regular Savings record.
async function runSweep(userId, txnAmount, t) {
  const user = await User.findByPk(userId, { transaction: t });
  const sweepAmount = computeSweep(user, txnAmount);
  if (!(sweepAmount > 0)) return null;

  const activeVault = await LockVault.findOne({
    where: { user_id: userId, status: 'active', auto_merge: true },
    transaction: t, lock: t.LOCK.UPDATE,
  });

  if (activeVault) {
    await vaultService._mergeIntoVault(activeVault, sweepAmount,
      user.roundup_preference === 'manual' ? 'STANDING_SWEEP' : 'ROUNDUP_SWEEP', t);
    return { amount: sweepAmount, destination: 'lock_vault', vaultId: activeVault.id };
  }

  const savings = await Savings.findOne({ where: { user_id: userId }, transaction: t, lock: t.LOCK.UPDATE });
  savings.total = round2(parseFloat(savings.total) + sweepAmount);
  savings.roundup_total = round2(parseFloat(savings.roundup_total) + sweepAmount);
  await savings.save({ transaction: t });
  return { amount: sweepAmount, destination: 'back_pocket' };
}

async function listTransactions(userId, accountId, limit = 10) {
  const acct = await Account.findOne({ where: { id: accountId, user_id: userId } });
  if (!acct) throw httpErr(404, 'Account not found');
  return Transaction.findAll({
    where: { account_id: accountId },
    order: [['createdAt', 'DESC']], limit,
  });
}

function ref(prefix) {
  return prefix + Date.now().toString().slice(-8) + Math.floor(Math.random() * 90 + 10);
}

module.exports = {
  listAccounts, openAccount, deposit, withdraw, transfer, runSweep, listTransactions,
};

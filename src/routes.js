'use strict';
const express = require('express');
const auth = require('./middleware/auth');
const authService = require('./services/authService');
const bank = require('./services/bankService');
const vault = require('./services/vaultService');
const { Savings } = require('./models');

const router = express.Router();
const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
  const status = e.status || 500;
  res.status(status).json({ error: { code: e.code || 'ERROR', message: e.message } });
});

// ─── AUTH ───
router.post('/auth/register', wrap(async (req, res) => {
  const result = await authService.register(req.body);
  res.status(201).json(result);
}));

router.post('/auth/login', wrap(async (req, res) => {
  const result = await authService.login(req.body);
  res.json(result);
}));

// ─── ACCOUNTS (protected) ───
router.get('/accounts', auth, wrap(async (req, res) => {
  res.json(await bank.listAccounts(req.userId));
}));
router.post('/accounts', auth, wrap(async (req, res) => {
  res.status(201).json(await bank.openAccount(req.userId, req.body));
}));

// ─── TRANSACTIONS (protected) ───
router.post('/transactions/deposit', auth, wrap(async (req, res) => {
  res.status(201).json(await bank.deposit(req.userId, req.body));
}));
router.post('/transactions/withdraw', auth, wrap(async (req, res) => {
  res.status(201).json(await bank.withdraw(req.userId, req.body));
}));
router.post('/transactions/transfer', auth, wrap(async (req, res) => {
  res.status(201).json(await bank.transfer(req.userId, req.body));
}));
router.get('/transactions', auth, wrap(async (req, res) => {
  res.json(await bank.listTransactions(req.userId, req.query.account, parseInt(req.query.limit) || 10));
}));

// ─── SAVINGS (protected) ───
router.get('/savings', auth, wrap(async (req, res) => {
  const s = await Savings.findOne({ where: { user_id: req.userId } });
  res.json(s);
}));

// ─── LOCK VAULT (protected) ───
router.post('/vault', auth, wrap(async (req, res) => {
  res.status(201).json(await vault.createVault(req.userId, req.body));
}));
router.get('/vault', auth, wrap(async (req, res) => {
  res.json(await vault.getVault(req.userId));
}));
router.post('/vault/:id/topup', auth, wrap(async (req, res) => {
  res.json(await vault.topUp(req.userId, req.params.id, req.body.amount));
}));
router.post('/vault/:id/withdraw', auth, wrap(async (req, res) => {
  res.json(await vault.earlyWithdraw(req.userId, req.params.id, req.body.amount));
}));

// ─── JOBS (admin/cron — protected in prod by a job secret) ───
router.post('/jobs/accrue', wrap(async (req, res) => {
  res.json({ posted: await vault.postDailyAccrual() });
}));
router.post('/jobs/maturities', wrap(async (req, res) => {
  res.json({ processed: await vault.processMaturities() });
}));

module.exports = router;

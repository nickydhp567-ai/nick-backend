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

// ─── STANDING ORDERS (protected) ───
router.get('/standing-orders', auth, wrap(async (req, res) => {
  const { StandingOrder } = require('./models');
  res.json(await StandingOrder.findAll({ where: { user_id: req.userId }, order: [['createdAt','DESC']] }));
}));
router.post('/standing-orders', auth, wrap(async (req, res) => {
  const { StandingOrder } = require('./models');
  const { name, amount, freq } = req.body;
  if (!amount || amount <= 0) throw Object.assign(new Error('Amount must be > 0'), { status: 400 });
  const so = await StandingOrder.create({ user_id: req.userId, name: name||'Order', amount, freq: freq||'monthly' });
  res.status(201).json(so);
}));
router.post('/standing-orders/:id/run', auth, wrap(async (req, res) => {
  const { StandingOrder, Savings } = require('./models');
  const { sequelize } = require('./config/database');
  const { round2 } = require('./utils/domain');
  const so = await StandingOrder.findOne({ where: { id: req.params.id, user_id: req.userId } });
  if (!so) throw Object.assign(new Error('Order not found'), { status: 404 });
  await sequelize.transaction(async (t) => {
    const savings = await Savings.findOne({ where: { user_id: req.userId }, transaction: t, lock: t.LOCK.UPDATE });
    savings.total = round2(parseFloat(savings.total) + parseFloat(so.amount));
    savings.standing_total = round2(parseFloat(savings.standing_total) + parseFloat(so.amount));
    await savings.save({ transaction: t });
    so.executed += 1; so.last_run = new Date();
    await so.save({ transaction: t });
  });
  res.json({ ok: true, executed: so.executed });
}));
router.delete('/standing-orders/:id', auth, wrap(async (req, res) => {
  const { StandingOrder } = require('./models');
  await StandingOrder.destroy({ where: { id: req.params.id, user_id: req.userId } });
  res.json({ ok: true });
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

router.get('/admin/users', async (req, res) => {
  try {
    const secret = process.env.ADMIN_SECRET || 'nickbank-admin-2026';
    if (req.headers['x-admin-secret'] !== secret) return res.status(401).json({ error: 'Unauthorized' });
    const { User, Account, Savings } = require('./models');
    const users = await User.findAll({ attributes: ['id','full_name','phone','email','roundup_preference','createdAt'], include: [{ model: Account, attributes: ['type','balance','account_number'] }, { model: Savings, attributes: ['total','roundup_total','standing_total'] }], order: [['createdAt','DESC']] });
    res.json({ count: users.length, users });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

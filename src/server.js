'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const routes = require('./routes');
const { connect, sequelize, usingPostgres } = require('./config/database');

const app = express();
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors({ origin: '*', methods: ['GET','POST','PUT','DELETE','OPTIONS'], allowedHeaders: ['Content-Type','Authorization'] }));
app.options('*', cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ ok: true, db: usingPostgres ? 'postgres' : 'sqlite' }));
app.use('/api/v1', routes);

// central error fallback
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: { code: err.code || 'ERROR', message: err.message } });
});

const PORT = process.env.PORT || 3000;

async function start() {
  await connect();
  await sequelize.sync(); // creates tables if absent (demo). Use migrations in prod.
  app.listen(PORT, () => {
    console.log(`NICK Bank API running on :${PORT}  (db: ${usingPostgres ? 'postgres' : 'sqlite'})`);
  });
}

if (require.main === module) start();

module.exports = { app, start };

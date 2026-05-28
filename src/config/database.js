'use strict';
/**
 * Database configuration.
 * Uses Postgres when DATABASE_URL is set; otherwise falls back to a local
 * SQLite file so the project runs with zero external setup for demos.
 */
const { Sequelize } = require('sequelize');

const userPostgres = !!process.env.DATABASE_URL;

const sequelize = userPostgres
  ? new Sequelize(process.env.DATABASE_URL, {
      dialect: 'postgres',
      logging: false,
      dialectOptions:
        process.env.PGSSL === 'true'
          ? { ssl: { require: true, rejectUnauthorized: false } }
          : {},
    })
  : new Sequelize({
      dialect: 'sqlite',
      storage: process.env.SQLITE_PATH || './nickbank.sqlite',
      logging: false,
    });

async function connect() {
  await sequelize.authenticate();
  return sequelize;
}

module.exports = { sequelize, connect, usingPostgres: userPostgres };

'use strict';
/**
 * Sequelize models for NICK Bank.
 * Money columns use DECIMAL(14,2). Relationships mirror the documented schema:
 *   User 1─N Account 1─N Transaction
 *   User 1─N StandingOrder
 *   User 1─1 Savings
 *   User 1─N LockVault 1─N LockVaultLedger
 *   User 1─N AuditLog
 */
const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../config/database');

class User extends Model {}
User.init({
  id:        { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  full_name: { type: DataTypes.STRING, allowNull: false },
  phone:     { type: DataTypes.STRING, allowNull: false, unique: true,
               validate: { is: /^0[2-5][0-9]{8}$/ } },
  email:     { type: DataTypes.STRING, allowNull: false, unique: true,
               validate: { isEmail: true } },
  pin_hash:  { type: DataTypes.STRING, allowNull: false },
  roundup_preference: { type: DataTypes.ENUM('auto', 'manual'), allowNull: false, defaultValue: 'auto' },
  roundup_amount:     { type: DataTypes.DECIMAL(10, 2), allowNull: true },
  roundup_base:       { type: DataTypes.INTEGER, allowNull: false, defaultValue: 1 },
  failed_pin_attempts:{ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  locked:             { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { sequelize, modelName: 'user', tableName: 'users' });

class Account extends Model {}
Account.init({
  id:      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id: { type: DataTypes.UUID, allowNull: false },
  type:    { type: DataTypes.ENUM('current', 'savings', 'fixed', 'business'), allowNull: false },
  name:    { type: DataTypes.STRING, allowNull: false },
  account_number: { type: DataTypes.STRING, allowNull: false, unique: true },
  balance: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
  is_private: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
}, { sequelize, modelName: 'account', tableName: 'accounts' });

class Transaction extends Model {}
Transaction.init({
  id:         { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  account_id: { type: DataTypes.UUID, allowNull: false },
  type:       { type: DataTypes.ENUM('deposit', 'withdraw', 'transfer_in', 'transfer_out', 'sweep', 'loan', 'repay'), allowNull: false },
  amount:     { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  balance_after: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  description:{ type: DataTypes.STRING },
  reference:  { type: DataTypes.STRING },
}, { sequelize, modelName: 'transaction', tableName: 'transactions' });

class Savings extends Model {}
Savings.init({
  id:      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id: { type: DataTypes.UUID, allowNull: false, unique: true },
  total:          { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
  roundup_total:  { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
  standing_total: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
}, { sequelize, modelName: 'saving', tableName: 'savings' });

class StandingOrder extends Model {}
StandingOrder.init({
  id:      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id: { type: DataTypes.UUID, allowNull: false },
  name:    { type: DataTypes.STRING, allowNull: false },
  amount:  { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  freq:    { type: DataTypes.ENUM('daily', 'weekly', 'monthly'), allowNull: false },
  active:  { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  executed:{ type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
  last_run:{ type: DataTypes.DATE },
}, { sequelize, modelName: 'standing_order', tableName: 'standing_orders' });

class LockVault extends Model {}
LockVault.init({
  id:      { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id: { type: DataTypes.UUID, allowNull: false },
  term_days:     { type: DataTypes.INTEGER, allowNull: false },
  interest_rate: { type: DataTypes.DECIMAL(5, 4), allowNull: false },
  locked_at:     { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  maturity_at:   { type: DataTypes.DATE, allowNull: false },
  principal_balance: { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
  accrued_interest:  { type: DataTypes.DECIMAL(14, 2), allowNull: false, defaultValue: 0 },
  last_accrual_at:   { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  status:          { type: DataTypes.ENUM('active', 'matured', 'closed'), allowNull: false, defaultValue: 'active' },
  maturity_action: { type: DataTypes.ENUM('notify', 'renew', 'release'), allowNull: false, defaultValue: 'notify' },
  auto_merge:      { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
}, { sequelize, modelName: 'lock_vault', tableName: 'lock_vaults' });

class LockVaultLedger extends Model {}
LockVaultLedger.init({
  id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  vault_id: { type: DataTypes.UUID, allowNull: false },
  entry_type: { type: DataTypes.STRING, allowNull: false },
  amount:     { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  balance_after: { type: DataTypes.DECIMAL(14, 2), allowNull: false },
  reference:  { type: DataTypes.STRING },
}, { sequelize, modelName: 'lock_vault_ledger', tableName: 'lock_vault_ledger' });

class AuditLog extends Model {}
AuditLog.init({
  id:       { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
  user_id:  { type: DataTypes.UUID },
  action:   { type: DataTypes.STRING, allowNull: false },
  metadata: { type: DataTypes.JSON },
}, { sequelize, modelName: 'audit_log', tableName: 'audit_logs' });

// ─── Associations ───
User.hasMany(Account,       { foreignKey: 'user_id' });
Account.belongsTo(User,     { foreignKey: 'user_id' });
Account.hasMany(Transaction,{ foreignKey: 'account_id' });
Transaction.belongsTo(Account, { foreignKey: 'account_id' });
User.hasOne(Savings,        { foreignKey: 'user_id' });
Savings.belongsTo(User,     { foreignKey: 'user_id' });
User.hasMany(StandingOrder, { foreignKey: 'user_id' });
StandingOrder.belongsTo(User,{ foreignKey: 'user_id' });
User.hasMany(LockVault,     { foreignKey: 'user_id' });
LockVault.belongsTo(User,   { foreignKey: 'user_id' });
LockVault.hasMany(LockVaultLedger, { foreignKey: 'vault_id' });
LockVaultLedger.belongsTo(LockVault, { foreignKey: 'vault_id' });
User.hasMany(AuditLog,      { foreignKey: 'user_id' });

module.exports = {
  User, Account, Transaction, Savings,
  StandingOrder, LockVault, LockVaultLedger, AuditLog,
};

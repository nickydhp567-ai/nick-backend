# NICK Bank — Backend API

Production-ready Node.js + Express + Sequelize backend for NICK Bank PLC:
pocket banking, automated Back Pocket savings, and the unified **Lock Vault**.

Runs on **PostgreSQL** in production and falls back to **SQLite** with zero setup
for local demos.

---

## Quick Start (zero-config SQLite demo)

```bash
cd nick-backend
npm install
cp .env.example .env          # defaults to SQLite — no database server needed
npm start
```

Server boots on `http://localhost:3000`. Tables are created automatically.

### Switch to PostgreSQL
Set `DATABASE_URL` in `.env`:
```
DATABASE_URL=postgres://user:password@localhost:5432/nick_bank
```
Restart. That's the only change — same code, same API.

---

## Verify the logic (no install required)

The core money math and Lock Vault rules are covered by a dependency-free suite:

```bash
node --test verify.js
```

All 18 checks should pass: round-up engine, vault rates, daily interest on the
total balance, unified maturity (deposits inherit one maturity date), early-
withdrawal penalty, and a full customer-journey integration.

---

## API Reference

Base URL: `http://localhost:3000/api/v1`

### Auth
| Method | Path | Body |
|--------|------|------|
| POST | `/auth/register` | `fullName, phone, email, pin, roundup_preference, roundup_amount?` |
| POST | `/auth/login` | `phone, pin` → `{ token }` |

All other routes require `Authorization: Bearer <token>`.

### Accounts
| Method | Path | Notes |
|--------|------|-------|
| GET | `/accounts` | list user accounts |
| POST | `/accounts` | `{ type, name }` |

### Transactions (atomic, with savings sweep)
| Method | Path | Body |
|--------|------|------|
| POST | `/transactions/deposit` | `{ accountId, amount, description }` |
| POST | `/transactions/withdraw` | `{ accountId, amount }` |
| POST | `/transactions/transfer` | `{ fromAccountId, toAccountId, amount }` |
| GET | `/transactions?account=<id>&limit=10` | mini statement |

### Savings & Lock Vault
| Method | Path | Body |
|--------|------|------|
| GET | `/savings` | Back Pocket totals |
| POST | `/vault` | `{ termDays, seedAmount, maturityAction }` |
| GET | `/vault` | active vault + computed fields (days left, projection…) |
| POST | `/vault/:id/topup` | `{ amount }` — inherits existing maturity |
| POST | `/vault/:id/withdraw` | `{ amount }` — early-withdrawal penalty applied |

### Jobs (wire to cron in production)
| Method | Path | Purpose |
|--------|------|---------|
| POST | `/jobs/accrue` | post one day of interest to all active vaults |
| POST | `/jobs/maturities` | release / renew / hold matured vaults |

---

## Example: end-to-end with curl

```bash
# Register
curl -s localhost:3000/api/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"fullName":"Nick Mensah","phone":"0244000000","email":"nick@example.com","pin":"1234","roundup_preference":"auto"}'

# → returns { userId, token }. Save the token:
TOKEN=<paste token>

# List accounts (a Current account is auto-created at signup)
curl -s localhost:3000/api/v1/accounts -H "Authorization: Bearer $TOKEN"

# Deposit 13.40 — triggers a 0.60 round-up sweep into Back Pocket
curl -s localhost:3000/api/v1/transactions/deposit -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"accountId":"<acc-id>","amount":13.40}'

# Create a 182-day Lock Vault seeded from Back Pocket
curl -s localhost:3000/api/v1/vault -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"termDays":182,"seedAmount":0,"maturityAction":"notify"}'
```

---

## Architecture

```
src/
├── config/database.js     Postgres/SQLite connection
├── models/index.js        Sequelize models + associations
├── services/
│   ├── authService.js     register/login, scrypt PIN hashing
│   ├── bankService.js     atomic deposit/withdraw/transfer + sweep
│   └── vaultService.js    unified Lock Vault, accrual, maturity
├── middleware/auth.js     JWT guard
├── utils/
│   ├── domain.js          pure money & vault math (the heart)
│   └── jwt.js             HS256 tokens (built-in crypto)
├── routes.js              REST endpoints
└── server.js              Express app + bootstrap
verify.js                  dependency-free test suite (18 checks)
```

### Design guarantees
- **Atomic money movement** — every balance change runs in a DB transaction with a row lock, then writes an immutable ledger row.
- **Unified vault maturity** — the vault owns one maturity date; deposits merge in and inherit it.
- **Interest on total balance** — daily simple interest, idempotent per day.
- **Penalty on early exit** — pro-rata interest forfeit + 2% admin fee.
- **No plaintext secrets** — PINs are scrypt-hashed; JWT-guarded API.

### Production notes
- Swap `sync()` for proper migrations (`sequelize-cli`).
- Move `JWT_SECRET` to a secrets manager; shorten token TTL + add refresh tokens.
- Protect `/jobs/*` behind a cron secret or internal network.
- Add `express-rate-limit` and `express-validator` (listed in spec).
```

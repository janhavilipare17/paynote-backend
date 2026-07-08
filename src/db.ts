import { Pool } from "pg";
import { PayNote } from "./types";

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Convert a Postgres row into the shared PayNote type.
function rowToPaynote(row: any): PayNote {
  const paynote: PayNote = {
    id: row.id,
    creatorAddress: row.creator_address,
    amount: row.amount,
    asset: row.asset,
    description: row.description,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    paymentLink: row.payment_link,
  };
  if (row.paid_amount && row.paid_asset) {
    paynote.paidAmount = row.paid_amount;
    paynote.paidAsset = row.paid_asset;
  }
  return paynote;
}

export async function getPaynote(id: string): Promise<PayNote | null> {
  const result = await pool.query("SELECT * FROM paynotes WHERE id = $1", [id]);
  if (result.rows.length === 0) return null;
  return rowToPaynote(result.rows[0]);
}

export async function getPaynotesByCreator(address: string): Promise<PayNote[]> {
  const result = await pool.query(
    "SELECT * FROM paynotes WHERE creator_address = $1",
    [address]
  );
  return result.rows.map(rowToPaynote);
}

// Insert or update a PayNote (used by sync, recheck, and creation).
export async function upsertPaynote(paynote: PayNote): Promise<void> {
  await pool.query(
    `INSERT INTO paynotes (id, creator_address, amount, asset, description, status, created_at, expires_at, paid_amount, paid_asset, payment_link)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (id) DO UPDATE SET
       creator_address = EXCLUDED.creator_address,
       amount = EXCLUDED.amount,
       asset = EXCLUDED.asset,
       description = EXCLUDED.description,
       status = EXCLUDED.status,
       created_at = EXCLUDED.created_at,
       expires_at = EXCLUDED.expires_at,
       paid_amount = EXCLUDED.paid_amount,
       paid_asset = EXCLUDED.paid_asset,
       payment_link = EXCLUDED.payment_link`,
    [
      paynote.id,
      paynote.creatorAddress,
      paynote.amount,
      paynote.asset,
      paynote.description,
      paynote.status,
      paynote.createdAt,
      paynote.expiresAt,
      paynote.paidAmount || null,
      paynote.paidAsset || null,
      paynote.paymentLink,
    ]
  );
}

// Watched-accounts table replaces the in-memory Set in paymentListener.ts,
// so the listener knows what it was already watching after a restart.
export async function isAccountWatched(address: string): Promise<boolean> {
  const result = await pool.query(
    "SELECT 1 FROM watched_accounts WHERE address = $1",
    [address]
  );
  return result.rows.length > 0;
}

export async function markAccountWatched(address: string): Promise<void> {
  await pool.query(
    "INSERT INTO watched_accounts (address) VALUES ($1) ON CONFLICT DO NOTHING",
    [address]
  );
}

export async function getAllWatchedAccounts(): Promise<string[]> {
  const result = await pool.query("SELECT address FROM watched_accounts");
  return result.rows.map((r: { address: string }) => r.address);
}

export async function getReputationScore(address: string): Promise<{
  address: string;
  paidCount: number;
  expiredCount: number;
  pendingCount: number;
  score: number;
}> {
  const result = await pool.query(
    `SELECT status, COUNT(*) as count
     FROM paynotes
     WHERE creator_address = $1
     GROUP BY status`,
    [address]
  );

  let paidCount = 0;
  let expiredCount = 0;
  let pendingCount = 0;

  for (const row of result.rows) {
    const count = parseInt(row.count, 10);
    if (row.status === "paid") paidCount = count;
    else if (row.status === "expired") expiredCount = count;
    else if (row.status === "pending") pendingCount = count;
  }

  const resolvedCount = paidCount + expiredCount;
  const score = resolvedCount === 0 ? 100 : Math.round((paidCount / resolvedCount) * 100);

  return { address, paidCount, expiredCount, pendingCount, score };
}
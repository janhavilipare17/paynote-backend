import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { PayNote, CreatePayNoteRequest } from "./types";
import { getPaynoteFromChain, markPaidOnChain } from "./contractClient";
import { getPaynote, getPaynotesByCreator, upsertPaynote } from "./db";
import { watchAccountForPayments, backfillRecentPayments, resumeWatchingAllAccounts } from "./paymentListener";
const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;



// Convert the raw on-chain PayNote shape into the shared frontend/backend
// PayNote type (see src/types.ts). The contract stores timestamps as unix
// seconds and amounts as i128 — we convert those into the strings/ISO
// dates the rest of the API already uses.
function mapChainPaynoteToApi(chain: any): PayNote {
  const id = String(chain.id);
  const status = String(chain.status).toLowerCase() as PayNote["status"];

  const paynote: PayNote = {
    id,
    creatorAddress: chain.creator,
    amount: chain.amount.toString(),
    asset: chain.asset,
    description: chain.description,
    status,
    createdAt: new Date(Number(chain.created_at) * 1000).toISOString(),
    expiresAt: new Date(Number(chain.expires_at) * 1000).toISOString(),
    paymentLink: `http://localhost:3000/pay/${id}`,
  };

  if (chain.paid_asset && chain.paid_asset !== "NONE") {
    paynote.paidAmount = chain.paid_amount.toString();
    paynote.paidAsset = chain.paid_asset;
  }

  return paynote;
}

// Sync a PayNote from the chain into our local cache. The frontend calls
// this right after creating a PayNote directly on-chain via Freighter, so
// our backend has a fast-readable copy instead of hitting Soroban RPC on
// every page load.
app.post("/api/paynotes/sync/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const chainId = Number(req.params.id);
    const chainPaynote = await getPaynoteFromChain(chainId);
    const paynote = mapChainPaynoteToApi(chainPaynote);
    await upsertPaynote(paynote);

    // Now that we know this PayNote's creator address, start listening for
    // a real payment to that account so we can auto mark_paid when it arrives.
    // This also backfills recent payment history, catching payments that
    // already happened before we started watching.
    await watchAccountForPayments(paynote.creatorAddress);

    res.json(paynote);
  } catch (err: any) {
    console.error("Sync failed:", err);
    res.status(500).json({ error: "Failed to sync PayNote from chain", details: err.message });
  }
});
// Manually trigger a check of recent payment history for a PayNote's
// creator — useful if a payment happened before the listener was watching
// (e.g. right after a server restart).
app.post("/api/paynotes/:id/recheck", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const paynote = await getPaynote(req.params.id);
    if (!paynote) {
      return res.status(404).json({ error: "PayNote not found in DB, sync it first" });
    }
    await backfillRecentPayments(paynote.creatorAddress);
    await watchAccountForPayments(paynote.creatorAddress);
    const refreshed = mapChainPaynoteToApi(await getPaynoteFromChain(Number(req.params.id)));
    await upsertPaynote(refreshed);
    res.json(refreshed);
  } catch (err: any) {
    console.error("Recheck failed:", err);
    res.status(500).json({ error: "Recheck failed", details: err.message });
  }
});

app.post("/api/paynotes", async (req: Request<{}, {}, CreatePayNoteRequest>, res: Response) => {
  const { creatorAddress, amount, asset, description, expiresAt } = req.body;

  if (!creatorAddress || !amount || !asset || !description || !expiresAt) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const id = "pn-" + Math.random().toString(36).slice(2, 10);

  const newPayNote: PayNote = {
    id,
    creatorAddress,
    amount,
    asset,
    description,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt,
    paymentLink: `http://localhost:3000/pay/${id}`,
  };

  await upsertPaynote(newPayNote);
  res.status(201).json(newPayNote);
});

// Fetch a single PayNote (for the payment page)
app.get("/api/paynotes/:id", async (req: Request<{ id: string }>, res: Response) => {
  const paynote = await getPaynote(req.params.id);
  if (!paynote) {
    return res.status(404).json({ error: "PayNote not found" });
  }
  res.json(paynote);
});

// List all PayNotes created by a given wallet address
app.get("/api/paynotes/user/:address", async (req: Request<{ address: string }>, res: Response) => {
  const list = await getPaynotesByCreator(req.params.address);
  res.json(list);
});

app.listen(PORT, async () => {
  console.log(`PayNote mock backend running at http://localhost:${PORT}`);
  await resumeWatchingAllAccounts();
});
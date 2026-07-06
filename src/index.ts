import express, { Request, Response } from "express";
import cors from "cors";
import { PayNote, CreatePayNoteRequest } from "./types";
import { getPaynoteFromChain, markPaidOnChain } from "./contractClient";
import { watchAccountForPayments, backfillRecentPayments } from "./paymentListener";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

// In-memory fake store — will be replaced by real DB + contract calls later.
// This lets the frontend build against real request/response shapes today.
const paynotes: Record<string, PayNote> = {
  "demo-1": {
    id: "demo-1",
    creatorAddress: "GABC1234EXAMPLEADDRESS",
    amount: "100",
    asset: "USDC",
    description: "Logo Design",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    paymentLink: "http://localhost:3000/pay/demo-1",
  },
};

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
    paynotes[paynote.id] = paynote;

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
    const paynote = paynotes[req.params.id];
    if (!paynote) {
      return res.status(404).json({ error: "PayNote not found in cache, sync it first" });
    }
    await backfillRecentPayments(paynote.creatorAddress);
    await watchAccountForPayments(paynote.creatorAddress);
    const refreshed = mapChainPaynoteToApi(await getPaynoteFromChain(Number(req.params.id)));
    paynotes[refreshed.id] = refreshed;
    res.json(refreshed);
  } catch (err: any) {
    console.error("Recheck failed:", err);
    res.status(500).json({ error: "Recheck failed", details: err.message });
  }
});

app.post("/api/paynotes", (req: Request<{}, {}, CreatePayNoteRequest>, res: Response) => {
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

  paynotes[id] = newPayNote;
  res.status(201).json(newPayNote);
});

// Fetch a single PayNote (for the payment page)
app.get("/api/paynotes/:id", (req: Request<{ id: string }>, res: Response) => {
  const paynote = paynotes[req.params.id];
  if (!paynote) {
    return res.status(404).json({ error: "PayNote not found" });
  }
  res.json(paynote);
});

// List all PayNotes created by a given wallet address
app.get("/api/paynotes/user/:address", (req: Request<{ address: string }>, res: Response) => {
  const list = Object.values(paynotes).filter(
    (p) => p.creatorAddress === req.params.address
  );
  res.json(list);
});

app.listen(PORT, () => {
  console.log(`PayNote mock backend running at http://localhost:${PORT}`);
});
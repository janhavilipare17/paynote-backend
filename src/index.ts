import "dotenv/config";
import express, { Request, Response } from "express";
import cors from "cors";
import { PayNote, CreatePayNoteRequest, mapChainPaynoteToApi } from "./types";
import { getPaynoteFromChain, markPaidOnChain } from "./contractClient";
import {
  getPaynote,
  getPaynoteByToken,
  getOrCreatePublicToken,
  getPaynotesByCreator,
  upsertPaynote,
  getReputationScore,
} from "./db";
import { watchAccountForPayments, backfillRecentPayments, resumeWatchingAllAccounts } from "./paymentListener";
const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

// Sync a PayNote from the chain into our local cache. The frontend calls
// this right after creating a PayNote directly on-chain via Freighter, so
// our backend has a fast-readable copy instead of hitting Soroban RPC on
// every page load.
app.post("/api/paynotes/sync/:id", async (req: Request<{ id: string }>, res: Response) => {
  try {
    const chainId = Number(req.params.id);
    const chainPaynote = await getPaynoteFromChain(chainId);
    const paynote = mapChainPaynoteToApi(chainPaynote);

    const token = await getOrCreatePublicToken(paynote.id);
    paynote.publicToken = token;
    paynote.paymentLink = `${process.env.FRONTEND_URL || "http://localhost:3000"}/pay/${token}`;

    await upsertPaynote(paynote);

    // Now that we know this PayNote's creator address, start listening for
    // a real payment to that account so we can auto mark_paid when it arrives.
    await watchAccountForPayments(paynote.creatorAddress);

    res.json(paynote);
  } catch (err: any) {
    console.error("Sync failed:", err);
    res.status(500).json({ error: "Failed to sync PayNote from chain", details: err.message });
  }
});

// Manually trigger a check of recent payment history — looked up by the
// public token, never the raw sequential chain id, so this endpoint can't
// be used to enumerate other people's PayNotes.
app.post("/api/paynotes/token/:token/recheck", async (req: Request<{ token: string }>, res: Response) => {
  try {
    const paynote = await getPaynoteByToken(req.params.token);
    if (!paynote) {
      return res.status(404).json({ error: "PayNote not found" });
    }
    await backfillRecentPayments(paynote.creatorAddress);
    await watchAccountForPayments(paynote.creatorAddress);

    const refreshed = mapChainPaynoteToApi(await getPaynoteFromChain(Number(paynote.id)));
    refreshed.publicToken = paynote.publicToken;
    refreshed.paymentLink = paynote.paymentLink;
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
  const token = await getOrCreatePublicToken(id);

  const newPayNote: PayNote = {
    id,
    creatorAddress,
    amount,
    asset,
    description,
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt,
    publicToken: token,
    paymentLink: `${process.env.FRONTEND_URL || "http://localhost:3000"}/pay/${token}`,
  };

  await upsertPaynote(newPayNote);
  res.status(201).json(newPayNote);
});

// Fetch a single PayNote by its public token (for the payment page).
// This replaces the old numeric-id lookup, which let anyone enumerate
// every PayNote by incrementing the URL.
app.get("/api/paynotes/token/:token", async (req: Request<{ token: string }>, res: Response) => {
  const paynote = await getPaynoteByToken(req.params.token);
  if (!paynote) {
    return res.status(404).json({ error: "PayNote not found" });
  }
  res.json(paynote);
});

// List all PayNotes created by a given wallet address (dashboard use only —
// the wallet address itself already acts as the access key here).
app.get("/api/paynotes/user/:address", async (req: Request<{ address: string }>, res: Response) => {
  const list = await getPaynotesByCreator(req.params.address);
  res.json(list);
});

app.get("/api/reputation/:address", async (req: Request<{ address: string }>, res: Response) => {
  try {
    const reputation = await getReputationScore(req.params.address);
    res.json(reputation);
  } catch (err: any) {
    console.error("Reputation lookup failed:", err);
    res.status(500).json({ error: "Failed to compute reputation", details: err.message });
  }
});

app.listen(PORT, async () => {
  console.log(`PayNote mock backend running at http://localhost:${PORT}`);
  await resumeWatchingAllAccounts();
});
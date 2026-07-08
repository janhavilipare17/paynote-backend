"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
require("dotenv/config");
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const contractClient_1 = require("./contractClient");
const db_1 = require("./db");
const paymentListener_1 = require("./paymentListener");
const app = (0, express_1.default)();
app.use((0, cors_1.default)());
app.use(express_1.default.json());
const PORT = 3001;
// Convert the raw on-chain PayNote shape into the shared frontend/backend
// PayNote type (see src/types.ts). The contract stores timestamps as unix
// seconds and amounts as i128 — we convert those into the strings/ISO
// dates the rest of the API already uses.
function mapChainPaynoteToApi(chain) {
    const id = String(chain.id);
    const status = String(chain.status).toLowerCase();
    const paynote = {
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
app.post("/api/paynotes/sync/:id", async (req, res) => {
    try {
        const chainId = Number(req.params.id);
        const chainPaynote = await (0, contractClient_1.getPaynoteFromChain)(chainId);
        const paynote = mapChainPaynoteToApi(chainPaynote);
        await (0, db_1.upsertPaynote)(paynote);
        // Now that we know this PayNote's creator address, start listening for
        // a real payment to that account so we can auto mark_paid when it arrives.
        // This also backfills recent payment history, catching payments that
        // already happened before we started watching.
        await (0, paymentListener_1.watchAccountForPayments)(paynote.creatorAddress);
        res.json(paynote);
    }
    catch (err) {
        console.error("Sync failed:", err);
        res.status(500).json({ error: "Failed to sync PayNote from chain", details: err.message });
    }
});
// Manually trigger a check of recent payment history for a PayNote's
// creator — useful if a payment happened before the listener was watching
// (e.g. right after a server restart).
app.post("/api/paynotes/:id/recheck", async (req, res) => {
    try {
        const paynote = await (0, db_1.getPaynote)(req.params.id);
        if (!paynote) {
            return res.status(404).json({ error: "PayNote not found in DB, sync it first" });
        }
        await (0, paymentListener_1.backfillRecentPayments)(paynote.creatorAddress);
        await (0, paymentListener_1.watchAccountForPayments)(paynote.creatorAddress);
        const refreshed = mapChainPaynoteToApi(await (0, contractClient_1.getPaynoteFromChain)(Number(req.params.id)));
        await (0, db_1.upsertPaynote)(refreshed);
        res.json(refreshed);
    }
    catch (err) {
        console.error("Recheck failed:", err);
        res.status(500).json({ error: "Recheck failed", details: err.message });
    }
});
app.post("/api/paynotes", async (req, res) => {
    const { creatorAddress, amount, asset, description, expiresAt } = req.body;
    if (!creatorAddress || !amount || !asset || !description || !expiresAt) {
        return res.status(400).json({ error: "Missing required fields" });
    }
    const id = "pn-" + Math.random().toString(36).slice(2, 10);
    const newPayNote = {
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
    await (0, db_1.upsertPaynote)(newPayNote);
    res.status(201).json(newPayNote);
});
// Fetch a single PayNote (for the payment page)
app.get("/api/paynotes/:id", async (req, res) => {
    const paynote = await (0, db_1.getPaynote)(req.params.id);
    if (!paynote) {
        return res.status(404).json({ error: "PayNote not found" });
    }
    res.json(paynote);
});
// List all PayNotes created by a given wallet address
app.get("/api/paynotes/user/:address", async (req, res) => {
    const list = await (0, db_1.getPaynotesByCreator)(req.params.address);
    res.json(list);
});
app.get("/api/reputation/:address", async (req, res) => {
    try {
        const reputation = await (0, db_1.getReputationScore)(req.params.address);
        res.json(reputation);
    }
    catch (err) {
        console.error("Reputation lookup failed:", err);
        res.status(500).json({ error: "Failed to compute reputation", details: err.message });
    }
});
app.listen(PORT, async () => {
    console.log(`PayNote mock backend running at http://localhost:${PORT}`);
    await (0, paymentListener_1.resumeWatchingAllAccounts)();
});

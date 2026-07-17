"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.backfillRecentPayments = backfillRecentPayments;
exports.watchAccountForPayments = watchAccountForPayments;
exports.resumeWatchingAllAccounts = resumeWatchingAllAccounts;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
const contractClient_1 = require("./contractClient");
const db_1 = require("./db");
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const horizonServer = new stellar_sdk_1.Horizon.Server(HORIZON_URL);
/**
 * Convention: whoever pays a PayNote must include the PayNote's numeric id
 * as a MEMO_TEXT on the payment transaction (e.g. memo "1" for PayNote id 1).
 * This is how we match an incoming payment to the correct PayNote — matching
 * by amount alone isn't reliable since a creator could have multiple pending
 * PayNotes for the same amount.
 */
function extractPaynoteIdFromMemo(memo) {
    if (!memo || memo.value === undefined || memo.value === null)
        return null;
    const raw = memo.value.toString().trim();
    const id = parseInt(raw, 10);
    return Number.isNaN(id) ? null : id;
}
/**
 * Check recent payment history for an account (most recent first) and
 * process any that match a pending PayNote. This closes the gap where a
 * payment happens BEFORE the live stream starts watching (e.g. right after
 * a server restart, or if sync/:id is called after the payment already
 * landed) — without this, cursor("now") would silently miss it forever.
 */
async function backfillRecentPayments(watchedAccount) {
    try {
        const page = await horizonServer
            .payments()
            .forAccount(watchedAccount)
            .order("desc")
            .limit(20)
            .join("transactions")
            .call();
        for (const record of page.records) {
            await handlePaymentRecord(record, watchedAccount);
        }
    }
    catch (err) {
        console.error(`Backfill check failed for ${watchedAccount}:`, err);
    }
}
/**
 * Start watching a creator's Stellar account for incoming payments.
 * Safe to call multiple times for the same account — it only opens one
 * stream per account.
 */
async function watchAccountForPayments(creatorAddress) {
    const alreadyWatched = await (0, db_1.isAccountWatched)(creatorAddress);
    if (alreadyWatched) {
        return; // already watching this account
    }
    await (0, db_1.markAccountWatched)(creatorAddress);
    console.log(`Starting payment listener for ${creatorAddress}`);
    // Catch anything that already happened before we started watching.
    await backfillRecentPayments(creatorAddress);
    horizonServer
        .payments()
        .forAccount(creatorAddress)
        .cursor("now") // only new payments from this point forward
        .join("transactions") // so we can read the memo without a second request
        .stream({
        onmessage: async (record) => {
            try {
                await handlePaymentRecord(record, creatorAddress);
            }
            catch (err) {
                console.error("Error handling payment record:", err);
            }
        },
        onerror: (err) => {
            console.error(`Payment stream error for ${creatorAddress}:`, err);
        },
    });
}
async function handlePaymentRecord(record, watchedAccount) {
    // Only care about operations that actually deliver funds TO the creator
    const relevantTypes = [
        "payment",
        "path_payment_strict_send",
        "path_payment_strict_receive",
    ];
    if (!relevantTypes.includes(record.type))
        return;
    if (record.to !== watchedAccount)
        return;
    const memo = record.transaction ? (await record.transaction()).memo : undefined;
    const paynoteId = extractPaynoteIdFromMemo({ value: memo });
    if (paynoteId === null) {
        console.log("Payment received with no matching PayNote memo, skipping.");
        return;
    }
    const chainPaynote = await (0, contractClient_1.getPaynoteFromChain)(paynoteId);
    if (chainPaynote.creator !== watchedAccount) {
        console.log(`PayNote ${paynoteId} does not belong to ${watchedAccount}, skipping.`);
        return;
    }
    if (String(chainPaynote.status) !== "Pending") {
        console.log(`PayNote ${paynoteId} is not pending (already ${chainPaynote.status}), skipping.`);
        return;
    }
    const paidAmount = Number(record.amount);
    const paidAsset = record.asset_type === "native" ? "XLM" : record.asset_code || "UNKNOWN";
    console.log(`Matched payment for PayNote ${paynoteId}: ${paidAmount} ${paidAsset}. Calling mark_paid...`);
    await (0, contractClient_1.markPaidOnChain)(paynoteId, paidAmount, paidAsset);
    const updatedChainPaynote = await (0, contractClient_1.getPaynoteFromChain)(paynoteId);
    const status = String(updatedChainPaynote.status).toLowerCase();
    await (0, db_1.upsertPaynote)({
        id: String(updatedChainPaynote.id),
        creatorAddress: updatedChainPaynote.creator,
        amount: updatedChainPaynote.amount.toString(),
        asset: updatedChainPaynote.asset,
        description: updatedChainPaynote.description,
        status: status,
        createdAt: new Date(Number(updatedChainPaynote.created_at) * 1000).toISOString(),
        expiresAt: new Date(Number(updatedChainPaynote.expires_at) * 1000).toISOString(),
        paidAmount: updatedChainPaynote.paid_amount?.toString(),
        paidAsset: updatedChainPaynote.paid_asset,
        paymentLink: `http://localhost:3000/pay/${updatedChainPaynote.id}`,
    });
    console.log(`PayNote ${paynoteId} marked as paid on-chain and synced to DB.`);
}
// Called once on server startup — re-opens Horizon streams for every
// account we were already watching before the last restart, since the
// in-memory stream itself doesn't survive a restart even though the DB
// record marking it "watched" does.
// Called once on server startup — re-opens Horizon streams for every
// account we were already watching before the last restart, since the
// in-memory stream itself doesn't survive a restart even though the DB
// record marking it "watched" does.
async function resumeWatchingAllAccounts() {
    const accounts = await (0, db_1.getAllWatchedAccounts)();
    console.log(`Resuming payment listeners for ${accounts.length} account(s)`);
    for (const address of accounts) {
        console.log(`Re-opening stream for ${address}`);
        horizonServer
            .payments()
            .forAccount(address)
            .cursor("now")
            .join("transactions")
            .stream({
            onmessage: async (record) => {
                try {
                    await handlePaymentRecord(record, address);
                }
                catch (err) {
                    console.error("Error handling payment record:", err);
                }
            },
            onerror: (err) => {
                console.error(`Payment stream error for ${address}:`, err);
            },
        });
    }
}

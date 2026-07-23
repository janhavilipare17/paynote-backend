import { Horizon } from "@stellar/stellar-sdk";
import { getPaynoteFromChain, markPaidOnChain } from "./contractClient";
import {
  isAccountWatched,
  markAccountWatched,
  getAllWatchedAccounts,
  getPaynote,
  upsertPaynote,
} from "./db";
import { mapChainPaynoteToApi } from "./types";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const horizonServer = new Horizon.Server(HORIZON_URL);

function extractPaynoteIdFromMemo(memo: any): number | null {
  if (!memo || memo.value === undefined || memo.value === null) return null;
  const raw = memo.value.toString().trim();
  const id = parseInt(raw, 10);
  return Number.isNaN(id) ? null : id;
}

export async function backfillRecentPayments(watchedAccount: string) {
  try {
    const page = await horizonServer
      .payments()
      .forAccount(watchedAccount)
      .order("desc")
      .limit(20)
      .join("transactions")
      .call();

    for (const record of page.records as any[]) {
      await handlePaymentRecord(record, watchedAccount);
    }
  } catch (err) {
    console.error(`Backfill check failed for ${watchedAccount}:`, err);
  }
}

export async function watchAccountForPayments(creatorAddress: string) {
  const alreadyWatched = await isAccountWatched(creatorAddress);
  if (alreadyWatched) {
    return;
  }
  await markAccountWatched(creatorAddress);

  console.log(`Starting payment listener for ${creatorAddress}`);
  await backfillRecentPayments(creatorAddress);

  horizonServer
    .payments()
    .forAccount(creatorAddress)
    .cursor("now")
    .join("transactions")
    .stream({
      onmessage: async (record: any) => {
        try {
          await handlePaymentRecord(record, creatorAddress);
        } catch (err) {
          console.error("Error handling payment record:", err);
        }
      },
      onerror: (err: any) => {
        console.error(`Payment stream error for ${creatorAddress}:`, err);
      },
    });
}

async function handlePaymentRecord(record: any, watchedAccount: string) {
  const relevantTypes = [
    "payment",
    "path_payment_strict_send",
    "path_payment_strict_receive",
  ];
  if (!relevantTypes.includes(record.type)) return;
  if (record.to !== watchedAccount) return;

  const memo = record.transaction ? (await record.transaction()).memo : undefined;
  const paynoteId = extractPaynoteIdFromMemo({ value: memo });

  if (paynoteId === null) {
    console.log("Payment received with no matching PayNote memo, skipping.");
    return;
  }

  const chainPaynote = await getPaynoteFromChain(paynoteId);

  if (chainPaynote.creator !== watchedAccount) {
    console.log(`PayNote ${paynoteId} does not belong to ${watchedAccount}, skipping.`);
    return;
  }

  if (String(chainPaynote.status) !== "Pending") {
    console.log(`PayNote ${paynoteId} is not pending (already ${chainPaynote.status}), skipping.`);
    return;
  }

  const paidAmount = Number(record.amount);
  const paidAsset =
    record.asset_type === "native" ? "XLM" : record.asset_code || "UNKNOWN";

  console.log(
    `Matched payment for PayNote ${paynoteId}: ${paidAmount} ${paidAsset}. Calling mark_paid...`
  );

  const updatedChainPaynote = await markPaidOnChain(paynoteId, paidAmount, paidAsset);
  const updated = mapChainPaynoteToApi(updatedChainPaynote);

  // Preserve the existing public_token and payment_link — this listener
  // never generates them, and upserting without them would wipe them out.
  const existing = await getPaynote(String(paynoteId));
  if (existing) {
    updated.publicToken = existing.publicToken;
    updated.paymentLink = existing.paymentLink;
  }

  await upsertPaynote(updated);

  console.log(`PayNote ${paynoteId} marked as paid on-chain and DB updated.`);
}

export async function resumeWatchingAllAccounts() {
  const accounts = await getAllWatchedAccounts();
  console.log(`Resuming payment listeners for ${accounts.length} account(s)`);
  for (const address of accounts) {
    console.log(`Re-opening stream for ${address}`);
    horizonServer
      .payments()
      .forAccount(address)
      .cursor("now")
      .join("transactions")
      .stream({
        onmessage: async (record: any) => {
          try {
            await handlePaymentRecord(record, address);
          } catch (err) {
            console.error("Error handling payment record:", err);
          }
        },
        onerror: (err: any) => {
          console.error(`Payment stream error for ${address}:`, err);
        },
      });
  }
}
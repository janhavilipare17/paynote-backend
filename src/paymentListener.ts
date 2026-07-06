import { Horizon } from "@stellar/stellar-sdk";
import { getPaynoteFromChain, markPaidOnChain } from "./contractClient";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const horizonServer = new Horizon.Server(HORIZON_URL);

// Tracks which creator accounts already have an active Horizon stream open,
// so we don't open duplicate streams for the same account.
const watchedAccounts = new Set<string>();

/**
 * Convention: whoever pays a PayNote must include the PayNote's numeric id
 * as a MEMO_TEXT on the payment transaction (e.g. memo "1" for PayNote id 1).
 * This is how we match an incoming payment to the correct PayNote — matching
 * by amount alone isn't reliable since a creator could have multiple pending
 * PayNotes for the same amount.
 */
function extractPaynoteIdFromMemo(memo: any): number | null {
  if (!memo || memo.value === undefined || memo.value === null) return null;
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
export async function backfillRecentPayments(watchedAccount: string) {
  try {
    const page = await horizonServer
      .payments()
      .forAccount(watchedAccount)
      .order("desc")
      .limit(20)
      .join("transactions")
      .call();

    console.log(`Backfill found ${page.records.length} records for ${watchedAccount}`);
for (const record of page.records as any[]) {
  console.log(`Record: type=${record.type} to=${record.to} amount=${record.amount}`);
  await handlePaymentRecord(record, watchedAccount);
}
  } catch (err) {
    console.error(`Backfill check failed for ${watchedAccount}:`, err);
  }
}

/**
 * Start watching a creator's Stellar account for incoming payments.
 * Safe to call multiple times for the same account — it only opens one
 * stream per account.
 */
export async function watchAccountForPayments(creatorAddress: string) {
  if (watchedAccounts.has(creatorAddress)) {
    return; // already watching this account
  }
  watchedAccounts.add(creatorAddress);

  console.log(`Starting payment listener for ${creatorAddress}`);

  // Catch anything that already happened before we started watching.
  await backfillRecentPayments(creatorAddress);

  horizonServer
    .payments()
    .forAccount(creatorAddress)
    .cursor("now") // only new payments from this point forward
    .join("transactions") // so we can read the memo without a second request
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
  // Only care about operations that actually deliver funds TO the creator
  const relevantTypes = [
    "payment",
    "path_payment_strict_send",
    "path_payment_strict_receive",
  ];
  if (!relevantTypes.includes(record.type)) return;
  console.log(`Skipped: type ${record.type} not in relevantTypes`);
  if (record.to !== watchedAccount) return;
  console.log(`Skipped: record.to (${record.to}) !== watchedAccount (${watchedAccount})`);

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

  await markPaidOnChain(paynoteId, paidAmount, paidAsset);

  console.log(`PayNote ${paynoteId} marked as paid on-chain.`);
}
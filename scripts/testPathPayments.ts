/**
 * One-time test script: sets up two custom testnet assets (TESTUSD, TESTEUR),
 * trustlines, a liquidity offer between them, then (once you've created a
 * PayNote requesting TESTUSD and synced it) sends a real path payment in
 * TESTEUR — proving the "pay in one asset, receiver gets another" feature
 * actually works end-to-end.
 *
 * Run with: npx ts-node scripts/testPathPayment.ts
 *
 * Requires these env vars to be set first:
 *   ISSUER_SECRET   - a funded testnet secret key (issues both test assets)
 *   CREATOR_SECRET  - the PayNote CREATOR's secret (paynote-deployer)
 *   PAYER_SECRET    - a funded testnet secret key that will send the payment
 *   BACKEND_URL     - e.g. https://paynote-backend.onrender.com
 *   PAYNOTE_ID      - (only needed for step 5) the id returned by create_paynote
 */
import {
  Keypair,
  Asset,
  TransactionBuilder,
  Operation,
  Networks,
  BASE_FEE,
  Horizon,
  Memo,
} from "@stellar/stellar-sdk";

const HORIZON_URL = "https://horizon-testnet.stellar.org";
const server = new Horizon.Server(HORIZON_URL);

const ISSUER_SECRET = process.env.ISSUER_SECRET || "";
const CREATOR_SECRET = process.env.CREATOR_SECRET || "";
const PAYER_SECRET = process.env.PAYER_SECRET || "";
const BACKEND_URL = process.env.BACKEND_URL || "https://paynote-backend.onrender.com";
const CONTRACT_ID = "CAYUDIMIOMD7YPPDS76VLUY5PZFTVFTEKQXV2M7CA374TAGX2U7WPW7R";

if (!ISSUER_SECRET || !CREATOR_SECRET || !PAYER_SECRET) {
  console.error("Missing ISSUER_SECRET, CREATOR_SECRET, or PAYER_SECRET env vars.");
  process.exit(1);
}

const issuerKeypair = Keypair.fromSecret(ISSUER_SECRET);
const creatorKeypair = Keypair.fromSecret(CREATOR_SECRET);
const payerKeypair = Keypair.fromSecret(PAYER_SECRET);

const TESTUSD = new Asset("TESTUSD", issuerKeypair.publicKey());
const TESTEUR = new Asset("TESTEUR", issuerKeypair.publicKey());

async function submit(tx: any, signers: Keypair[]) {
  signers.forEach((kp) => tx.sign(kp));
  return server.submitTransaction(tx);
}

async function run() {
  console.log("1. Creating trustlines...");

  const creatorAccount = await server.loadAccount(creatorKeypair.publicKey());
  const trustUsdTx = new TransactionBuilder(creatorAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: TESTUSD }))
    .setTimeout(30)
    .build();
  await submit(trustUsdTx, [creatorKeypair]);
  console.log("   Creator now trusts TESTUSD");

  const payerAccount = await server.loadAccount(payerKeypair.publicKey());
  const trustEurTx = new TransactionBuilder(payerAccount, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: TESTEUR }))
    .setTimeout(30)
    .build();
  await submit(trustEurTx, [payerKeypair]);
  console.log("   Payer now trusts TESTEUR");

  console.log("2. Issuer sending TESTEUR to payer...");
  const issuerAccount1 = await server.loadAccount(issuerKeypair.publicKey());
  const sendEurTx = new TransactionBuilder(issuerAccount1, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: payerKeypair.publicKey(),
        asset: TESTEUR,
        amount: "1000",
      })
    )
    .setTimeout(30)
    .build();
  await submit(sendEurTx, [issuerKeypair]);
  console.log("   Payer now holds 1000 TESTEUR");

  console.log("3. Issuer creating liquidity offer (sell TESTUSD for TESTEUR)...");
  const issuerAccount2 = await server.loadAccount(issuerKeypair.publicKey());
  const offerTx = new TransactionBuilder(issuerAccount2, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.manageSellOffer({
        selling: TESTUSD,
        buying: TESTEUR,
        amount: "1000",
        price: "1",
      })
    )
    .setTimeout(30)
    .build();
  await submit(offerTx, [issuerKeypair]);
  console.log("   Liquidity offer created");

  const paynoteId = process.env.PAYNOTE_ID;
  if (!paynoteId) {
    console.log(`
4. Setup complete. Now create a PayNote requesting 50 TESTUSD:

   stellar contract invoke \\
     --id ${CONTRACT_ID} \\
     --source paynote-deployer \\
     --network testnet \\
     -- \\
     create_paynote \\
     --creator ${creatorKeypair.publicKey()} \\
     --amount 50 \\
     --asset TESTUSD \\
     --description "Path payment test" \\
     --expires_at 9999999999

   Note the returned id, then sync it:
   curl.exe -X POST ${BACKEND_URL}/api/paynotes/sync/<id>

   Then re-run this script with PAYNOTE_ID=<id> set to send the path payment.
    `);
    return;
  }

  console.log("5. Sending path payment: payer sends TESTEUR, creator receives TESTUSD...");
  const payerAccount2 = await server.loadAccount(payerKeypair.publicKey());
  const pathPayTx = new TransactionBuilder(payerAccount2, {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.pathPaymentStrictSend({
        sendAsset: TESTEUR,
        sendAmount: "55",
        destination: creatorKeypair.publicKey(),
        destAsset: TESTUSD,
        destMin: "50",
        path: [],
      })
    )
    .addMemo(Memo.text(paynoteId))
    .setTimeout(30)
    .build();

  const result = await submit(pathPayTx, [payerKeypair]);
  console.log("   Path payment submitted:", result.hash);
  console.log("Now check your backend server logs for the mark_paid confirmation.");
}

run().catch((err) => {
  console.error("Script failed:", err.response?.data?.extras?.result_codes || err);
  process.exit(1);
});
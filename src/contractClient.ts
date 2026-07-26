import {
  rpc,
  Contract,
  Keypair,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  Address,
} from "@stellar/stellar-sdk";

// ---- Config ----
// Mainnet Soroban RPC endpoint
const RPC_URL = "https://mainnet.sorobanrpc.com";
const NETWORK_PASSPHRASE = Networks.PUBLIC;

// Your deployed contract ID (from `stellar contract deploy`)
const CONTRACT_ID = "CAUCCQFSBSCAS6F5KEA2UDCS3UHCUNQNSKZZOYN4RQXVIQ6XZ4D6M736";

// The backend's own signing key, used ONLY for calling mark_paid
// (mark_paid has no require_auth in the contract, so any account can call it —
// this is fine for now since it's your own trusted backend service).
// Set this via environment variable, never hardcode a real secret key.
const BACKEND_SECRET_KEY = (process.env.BACKEND_STELLAR_SECRET || "").trim();
console.log("SECRET_KEY_LENGTH:", BACKEND_SECRET_KEY.length, "STARTS_WITH:", BACKEND_SECRET_KEY.slice(0, 2));
const server = new rpc.Server(RPC_URL);
const contract = new Contract(CONTRACT_ID);

/**
 * Read a PayNote from the contract (read-only, no signing/fee needed).
 */
export async function getPaynoteFromChain(id: number) {
  if (!BACKEND_SECRET_KEY) {
    throw new Error("BACKEND_STELLAR_SECRET env var is not set");
  }
  const sourceKeypair = Keypair.fromSecret(BACKEND_SECRET_KEY);
  const sourceAccount = await server.getAccount(sourceKeypair.publicKey());

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call("get_paynote", nativeToScVal(id, { type: "u64" })))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  const result = rpc.Api.isSimulationSuccess(sim) ? sim.result?.retval : undefined;
  if (!result) {
    throw new Error("No result returned from simulation");
  }

  return scValToNative(result);
}

/**
 * Call mark_paid on the contract after the Horizon listener detects a
 * matching real payment. This submits a real signed transaction.
 */
export async function markPaidOnChain(
  id: number,
  paidAmount: number,
  paidAsset: string
) {
  if (!BACKEND_SECRET_KEY) {
    throw new Error("BACKEND_STELLAR_SECRET env var is not set");
  }
  const sourceKeypair = Keypair.fromSecret(BACKEND_SECRET_KEY);
  const sourceAccount = await server.getAccount(sourceKeypair.publicKey());

  let tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      contract.call(
        "mark_paid",
        nativeToScVal(id, { type: "u64" }),
        nativeToScVal(paidAmount, { type: "i128" }),
        nativeToScVal(paidAsset, { type: "symbol" })
      )
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(sourceKeypair);

  const sendResult = await server.sendTransaction(prepared);

  if (sendResult.status === "ERROR") {
    throw new Error(`Transaction failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  // Poll for confirmation
  let getResponse = await server.getTransaction(sendResult.hash);
  while (getResponse.status === "NOT_FOUND") {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    getResponse = await server.getTransaction(sendResult.hash);
  }

  if (getResponse.status !== "SUCCESS") {
    throw new Error(`Transaction did not succeed: ${getResponse.status}`);
  }

  return await getPaynoteFromChain(id);
}
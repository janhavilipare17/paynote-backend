"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getPaynoteFromChain = getPaynoteFromChain;
exports.markPaidOnChain = markPaidOnChain;
const stellar_sdk_1 = require("@stellar/stellar-sdk");
// ---- Config ----
// Testnet Soroban RPC endpoint
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = stellar_sdk_1.Networks.TESTNET;
// Your deployed contract ID (from `stellar contract deploy`)
const CONTRACT_ID = "CAYUDIMIOMD7YPPDS76VLUY5PZFTVFTEKQXV2M7CA374TAGX2U7WPW7R";
// The backend's own signing key, used ONLY for calling mark_paid
// (mark_paid has no require_auth in the contract, so any account can call it —
// this is fine for now since it's your own trusted backend service).
// Set this via environment variable, never hardcode a real secret key.
const BACKEND_SECRET_KEY = process.env.BACKEND_STELLAR_SECRET || "";
const server = new stellar_sdk_1.rpc.Server(RPC_URL);
const contract = new stellar_sdk_1.Contract(CONTRACT_ID);
/**
 * Read a PayNote from the contract (read-only, no signing/fee needed).
 */
async function getPaynoteFromChain(id) {
    if (!BACKEND_SECRET_KEY) {
        throw new Error("BACKEND_STELLAR_SECRET env var is not set");
    }
    const sourceKeypair = stellar_sdk_1.Keypair.fromSecret(BACKEND_SECRET_KEY);
    const sourceAccount = await server.getAccount(sourceKeypair.publicKey());
    const tx = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(contract.call("get_paynote", (0, stellar_sdk_1.nativeToScVal)(id, { type: "u64" })))
        .setTimeout(30)
        .build();
    const sim = await server.simulateTransaction(tx);
    if (stellar_sdk_1.rpc.Api.isSimulationError(sim)) {
        throw new Error(`Simulation failed: ${sim.error}`);
    }
    const result = stellar_sdk_1.rpc.Api.isSimulationSuccess(sim) ? sim.result?.retval : undefined;
    if (!result) {
        throw new Error("No result returned from simulation");
    }
    return (0, stellar_sdk_1.scValToNative)(result);
}
/**
 * Call mark_paid on the contract after the Horizon listener detects a
 * matching real payment. This submits a real signed transaction.
 */
async function markPaidOnChain(id, paidAmount, paidAsset) {
    if (!BACKEND_SECRET_KEY) {
        throw new Error("BACKEND_STELLAR_SECRET env var is not set");
    }
    const sourceKeypair = stellar_sdk_1.Keypair.fromSecret(BACKEND_SECRET_KEY);
    const sourceAccount = await server.getAccount(sourceKeypair.publicKey());
    let tx = new stellar_sdk_1.TransactionBuilder(sourceAccount, {
        fee: stellar_sdk_1.BASE_FEE,
        networkPassphrase: NETWORK_PASSPHRASE,
    })
        .addOperation(contract.call("mark_paid", (0, stellar_sdk_1.nativeToScVal)(id, { type: "u64" }), (0, stellar_sdk_1.nativeToScVal)(paidAmount, { type: "i128" }), (0, stellar_sdk_1.nativeToScVal)(paidAsset, { type: "symbol" })))
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

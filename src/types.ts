// This is the SHARED shape. Send this file (or its contents) to your frontend
// teammate so her TypeScript types match exactly what the API returns.

export type PayNoteStatus = "pending" | "paid" | "expired";

export interface PayNote {
  id: string;                 // unique PayNote ID
  creatorAddress: string;     // Stellar wallet address of the person requesting payment
  amount: string;             // requested amount, as string (avoid float precision issues)
  asset: string;              // e.g. "USDC"
  description: string;        // e.g. "Logo Design"
  status: PayNoteStatus;
  createdAt: string;          // ISO timestamp
  expiresAt: string;          // ISO timestamp
  paidAmount?: string;        // filled once paid, may differ from `amount` (path payments)
  paidAsset?: string;         // e.g. "EURC" if payer used a different asset
  paymentLink?: string;       // shareable link to the payment page
  publicToken?: string;       // opaque random token used in the public URL instead of the sequential chain id
}

export interface CreatePayNoteRequest {
  creatorAddress: string;
  amount: string;
  asset: string;
  description: string;
  expiresAt: string;
}

// Convert the raw on-chain PayNote shape into the shared frontend/backend
// PayNote type. The contract stores timestamps as unix seconds and amounts
// as i128 — we convert those into the strings/ISO dates the API uses.
// Note: publicToken/paymentLink are NOT set here — the caller is
// responsible for attaching those, since this function has no DB access.
export function mapChainPaynoteToApi(chain: any): PayNote {
  const id = String(chain.id);
  const status = String(chain.status).toLowerCase() as PayNoteStatus;

  const paynote: PayNote = {
    id,
    creatorAddress: chain.creator,
    amount: chain.amount.toString(),
    asset: chain.asset,
    description: chain.description,
    status,
    createdAt: new Date(Number(chain.created_at) * 1000).toISOString(),
    expiresAt: new Date(Number(chain.expires_at) * 1000).toISOString(),
  };

  if (chain.paid_asset && chain.paid_asset !== "NONE") {
    paynote.paidAmount = chain.paid_amount.toString();
    paynote.paidAsset = chain.paid_asset;
  }

  return paynote;
}
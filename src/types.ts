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
}

export interface CreatePayNoteRequest {
  creatorAddress: string;
  amount: string;
  asset: string;
  description: string;
  expiresAt: string;
}

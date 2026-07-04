import express, { Request, Response } from "express";
import cors from "cors";
import { PayNote, CreatePayNoteRequest } from "./types";

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

// In-memory fake store — will be replaced by real DB + contract calls later.
// This lets the frontend build against real request/response shapes today.
const paynotes: Record<string, PayNote> = {
  "demo-1": {
    id: "demo-1",
    creatorAddress: "GABC1234EXAMPLEADDRESS",
    amount: "100",
    asset: "USDC",
    description: "Logo Design",
    status: "pending",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    paymentLink: "http://localhost:3000/pay/demo-1",
  },
};

// Create a PayNote
app.post("/api/paynotes", (req: Request<{}, {}, CreatePayNoteRequest>, res: Response) => {
  const { creatorAddress, amount, asset, description, expiresAt } = req.body;

  if (!creatorAddress || !amount || !asset || !description || !expiresAt) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  const id = "pn-" + Math.random().toString(36).slice(2, 10);

  const newPayNote: PayNote = {
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

  paynotes[id] = newPayNote;
  res.status(201).json(newPayNote);
});

// Fetch a single PayNote (for the payment page)
app.get("/api/paynotes/:id", (req: Request<{ id: string }>, res: Response) => {
  const paynote = paynotes[req.params.id];
  if (!paynote) {
    return res.status(404).json({ error: "PayNote not found" });
  }
  res.json(paynote);
});

// List all PayNotes created by a given wallet address
app.get("/api/paynotes/user/:address", (req: Request<{ address: string }>, res: Response) => {
  const list = Object.values(paynotes).filter(
    (p) => p.creatorAddress === req.params.address
  );
  res.json(list);
});

app.listen(PORT, () => {
  console.log(`PayNote mock backend running at http://localhost:${PORT}`);
});

# PayNote Backend (Mock API — Week 1)

This is a **mock** backend: no database, no Stellar/Soroban calls yet. It exists
so the frontend can be built against the real, final API shape today, instead
of waiting for the contract + real backend to be finished.

Nothing here changes when the real logic is added later — same endpoints,
same response shape, just backed by a real DB + contract instead of an
in-memory object.

## Run it

```bash
npm install
npm run dev
```

Server runs at `http://localhost:3001`.

## Endpoints

### Create a PayNote
```
POST /api/paynotes
Body: { creatorAddress, amount, asset, description, expiresAt }
Returns: the full PayNote object (see src/types.ts)
```

### Get one PayNote (for the payment page)
```
GET /api/paynotes/:id
Returns: PayNote object, or 404 { error: "PayNote not found" }
```

### List a creator's PayNotes
```
GET /api/paynotes/user/:address
Returns: PayNote[]
```

## Shared type

See `src/types.ts` — this is the exact shape returned by every endpoint.
Frontend TypeScript interfaces should match this exactly. If a field needs
to change, message before changing it — don't change silently.

## What's next (not yet built)

- Real database (SQLite → Postgres)
- Soroban contract integration (create_paynote, get_paynote, mark_paid)
- Horizon payment listener to detect real payments and flip status
- Path payment support (pay in one asset, receiver gets another)
- Expiry checking (Pending → Expired after expiresAt passes)

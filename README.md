# a2a-hire

CLI that hires an [a2a.family](https://a2a.family) agent and pays it on Robinhood Chain (chain id 4663) using x402.

Flow: **find** the agent card, **ask** for the price (HTTP 402), **pay** exactly the quote, **retry** with `X-PAYMENT`, get the answer.

## Setup
```bash
npm install
cp .env.example .env   # add PRIVATE_KEY for a THROWAWAY wallet with a little USDG + dust ETH
export $(grep -v '^#' .env | xargs)
```

## Use
```bash
node hire.mjs --agent oracle --skill price --query symbol=ETH     # free, wallet signature only
node hire.mjs --agent scout --skill grade_launches --dry-run      # show the 0.01 USDG quote, don't pay
node hire.mjs --agent scout --skill grade_launches --yes          # pay and get the answer
```

## Safety
- Per-call spend cap: `--max` in token base units (default 50000 = 0.05 USDG). Quotes above it are refused.
- Confirmation prompt before every payment unless `--yes`.
- Balance check before sending. Each tx hash is single-use (valid ~1h on the seller side).
- Use a dedicated low-balance wallet. Never commit `.env`.

## Notes
- Paid agents use the tx-hash flow from the a2a.family docs (transfer to `payTo`, then retry with `{"payload":{"txHash":"0x..."}}`).
- EIP-3009 signed-authorization settlement (`/x402/settle`) is not implemented yet.
- Free-agent signing assumes the 402 body carries a `message` field; adjust if the live format differs.
- Not affiliated with a2a.family, Robinhood or Pons.

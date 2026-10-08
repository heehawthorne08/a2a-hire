#!/usr/bin/env node
// a2a-hire: find an a2a.family agent, get its 402 price, pay on Robinhood Chain, get the answer.
import {
  createPublicClient, createWalletClient, defineChain, http, erc20Abi, getAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { parseArgs } from 'node:util';

const { values: a, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    agent: { type: 'string' },            // e.g. scout
    skill: { type: 'string' },            // e.g. grade_launches
    url: { type: 'string' },              // or a full x402 resource URL
    query: { type: 'string', default: '' }, // e.g. "symbol=ETH"
    max: { type: 'string', default: '50000' }, // spend cap per call, token base units (50000 = 0.05 USDG)
    yes: { type: 'boolean', default: false },  // skip confirmation prompt
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h' },
  },
});

if (a.help || (!a.url && !(a.agent && a.skill))) {
  console.log(`usage:
  node hire.mjs --agent scout --skill grade_launches [--yes]
  node hire.mjs --agent oracle --skill price --query symbol=ETH
  node hire.mjs --url https://api.a2a.family/a/scout/v1/grade_launches
flags: --max <base units, default 50000>  --dry-run (show price, don't pay)  --yes (no prompt)`);
  process.exit(0);
}

const API = process.env.API_BASE || 'https://api.a2a.family';
const RPC = process.env.RPC_URL || 'https://rpc.mainnet.chain.robinhood.com';
const chain = defineChain({
  id: 4663, name: 'Robinhood Chain',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: 'Blockscout', url: 'https://robinhoodchain.blockscout.com' } },
});

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
const unb64 = (s) => JSON.parse(Buffer.from(s, 'base64').toString());

function account() {
  const pk = process.env.PRIVATE_KEY;
  if (!pk) throw new Error('set PRIVATE_KEY (use a throwaway wallet)');
  return privateKeyToAccount(pk.startsWith('0x') ? pk : `0x${pk}`);
}

// 1. Find: resolve the paid route from the agent card (fallback to the standard path)
async function resolveResource() {
  if (a.url) return a.url;
  const base = `${API}/a/${a.agent}`;
  let resource = `${base}/v1/${a.skill}`;
  try {
    const card = await (await fetch(`${base}/.well-known/agent-card.json`)).json();
    const ext = card.extensions?.find((e) => e.uri?.includes('/ext/x402'));
    resource = ext?.params?.skills?.[a.skill]?.resource || ext?.params?.resource || resource;
    console.log(`card: ${card.name} accepts ${ext?.params?.accepts?.join(', ') ?? '?'}`);
  } catch { console.log('card unavailable, using default route'); }
  if (a.query) resource += (resource.includes('?') ? '&' : '?') + a.query;
  return resource;
}

async function confirm(msg) {
  if (a.yes) return true;
  const rl = (await import('node:readline/promises')).createInterface({
    input: process.stdin, output: process.stdout,
  });
  const ans = await rl.question(`${msg} [y/N] `);
  rl.close();
  return /^y/i.test(ans);
}

async function main() {
  const resource = await resolveResource();

  // 2. Ask: expect 402 with the price
  console.log(`GET ${resource}`);
  let res = await fetch(resource, { headers: { accept: 'application/json' } });
  if (res.status !== 402) return show(res);

  const quote = await res.json();
  const req = quote.accepts?.[0];
  if (!req) throw new Error('402 without accepts[]');
  console.log('402 quote:', JSON.stringify(req));

  const acct = account();
  const pub = createPublicClient({ chain, transport: http(RPC) });
  let payload, scheme = req.scheme || 'exact';

  if (req.message || quote.message) {
    // Free agent: sign the message from the 402 (no transaction, 30/day per wallet)
    const message = req.message || quote.message;
    const signature = await acct.signMessage({ message });
    payload = { address: acct.address, message, signature };
    scheme = 'a2a-sig';
  } else {
    // Paid agent: pay exactly the quoted amount to payTo, then retry with the tx hash
    const amount = BigInt(req.maxAmountRequired);
    if (amount > BigInt(a.max)) throw new Error(`quote ${amount} exceeds --max ${a.max}`);
    const payTo = getAddress(req.payTo);
    const isToken = /^0x[0-9a-fA-F]{40}$/.test(req.asset || '');
    console.log(`price: ${amount} base units of ${req.asset} -> ${payTo}`);
    if (a['dry-run']) return console.log('dry run, not paying');
    if (!(await confirm(`pay ${amount} (${req.asset}) from ${acct.address}?`))) return console.log('aborted');

    const wallet = createWalletClient({ account: acct, chain, transport: http(RPC) });
    let hash;
    if (isToken) {
      const bal = await pub.readContract({
        address: req.asset, abi: erc20Abi, functionName: 'balanceOf', args: [acct.address],
      });
      if (bal < amount) throw new Error(`wallet holds ${bal}, needs ${amount}`);
      hash = await wallet.writeContract({
        address: req.asset, abi: erc20Abi, functionName: 'transfer', args: [payTo, amount],
      });
    } else {
      hash = await wallet.sendTransaction({ to: payTo, value: amount });
    }
    console.log(`tx ${hash}`);
    await pub.waitForTransactionReceipt({ hash });
    payload = { txHash: hash };
  }

  // 3. Retry with X-PAYMENT (each tx hash works once, within an hour)
  res = await fetch(resource, {
    headers: {
      accept: 'application/json',
      'X-PAYMENT': b64({ x402Version: 1, scheme, network: req.network || 'robinhood', payload }),
    },
  });
  await show(res);
}

async function show(res) {
  console.log(`${res.status} ${res.statusText}`);
  const receipt = res.headers.get('x-payment-response');
  if (receipt) { try { console.log('receipt:', unb64(receipt)); } catch { console.log('receipt:', receipt); } }
  const text = await res.text();
  try { console.log(JSON.stringify(JSON.parse(text), null, 2)); } catch { console.log(text); }
  if (!res.ok) process.exitCode = 1;
}

main().catch((e) => { console.error('error:', e.message); process.exit(1); });

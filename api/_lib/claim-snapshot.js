import { parseAddress } from './cardano-address.js';

export const MAX_ENTITLEMENTS = 20_000;
const KOIOS_PAGE_SIZE = 1000;
const KOIOS_MAX_PAGES = 60;
const KOIOS_REQUEST_TIMEOUT_MS = 25_000;
const KOIOS_BASES = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
};

export function koiosBase(network) {
  return KOIOS_BASES[network] || KOIOS_BASES.mainnet;
}

export class SnapshotError extends Error {}

/** Parses a decimal token amount into base units, e.g. ("1.5", 6) -> 1500000n. */
export function parseTokenAmount(value, decimals, fieldName = 'amount') {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new SnapshotError(`${fieldName} must be a positive number.`);
  }
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) {
    throw new SnapshotError(`${fieldName} has more than ${decimals} decimal places.`);
  }
  return BigInt(whole + fraction.padEnd(decimals, '0'));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchKoiosPage(url, fetchImpl) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(KOIOS_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      if (attempt === 2) throw new SnapshotError(`Koios request failed: ${error.message}`);
      await sleep(1000 * (attempt + 1));
      continue;
    }

    if (response.ok) {
      const rows = await response.json();
      if (!Array.isArray(rows)) throw new SnapshotError('Koios returned an unexpected response.');
      return rows;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await sleep(1000 * (attempt + 1));
      continue;
    }
    throw new SnapshotError(`Koios responded with HTTP ${response.status}.`);
  }
  throw new SnapshotError('Koios request failed.');
}

/**
 * Current holders of a policy (every asset under it) or of one specific asset.
 * Koios only serves current balances, so a "snapshot" is the state at the time
 * this runs.
 */
export async function fetchKoiosHolders({ policyId, assetNameHex, network }, fetchImpl = fetch) {
  const base = koiosBase(network);
  const specificAsset = typeof assetNameHex === 'string' && assetNameHex !== '';
  const endpoint = specificAsset ? 'asset_addresses' : 'policy_asset_addresses';
  const query = `_asset_policy=${policyId}${specificAsset ? `&_asset_name=${assetNameHex}` : ''}`;

  const rows = [];
  for (let page = 0; page < KOIOS_MAX_PAGES; page += 1) {
    const url = `${base}/${endpoint}?${query}&limit=${KOIOS_PAGE_SIZE}&offset=${page * KOIOS_PAGE_SIZE}`;
    const batch = await fetchKoiosPage(url, fetchImpl);
    for (const row of batch) {
      rows.push({ address: row?.payment_address, quantity: row?.quantity });
    }
    if (batch.length < KOIOS_PAGE_SIZE) return rows;
  }
  throw new SnapshotError('This token has too many holders to snapshot automatically. Upload a holder list instead.');
}

/**
 * Accepts the same shapes as the airdrop tool: strings, or objects carrying an
 * address (`address`, `payment_address`, `stake_address`) and optionally an
 * `amount`/`quantity`.
 */
export function parseHolderJson(input) {
  let value = input;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new SnapshotError('The holder list is not valid JSON.');
    }
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new SnapshotError('The holder list must be a non-empty JSON array.');
  }

  return value.map((entry, index) => {
    const isObject = entry && typeof entry === 'object';
    const address = String(isObject
      ? entry.address ?? entry.payment_address ?? entry.stake_address ?? ''
      : entry ?? '').trim();
    const quantity = isObject ? entry.amount ?? entry.quantity ?? null : null;
    if (!address) throw new SnapshotError(`Holder ${index + 1} has no address.`);
    return { address, quantity };
  });
}

function entitlementKey(address) {
  const parsed = parseAddress(address);
  if (!parsed) return null;
  if (parsed.paymentIsScript) return { skip: 'script' };
  if (parsed.stakeAddress) return { key: parsed.stakeAddress, keyType: 'stake' };
  if (parsed.paymentHash) return { key: address.trim(), keyType: 'address' };
  return null;
}

/**
 * Turns raw holder rows into one entitlement per person.
 *
 * Holders are grouped by stake address so several addresses of one wallet get
 * a single claim. Amounts are computed here, at snapshot time, and stored, so
 * later changes to the chain cannot change who can claim what.
 */
export function buildEntitlements({ rows, filters = {}, distribution, decimals, excludeAddresses = [] }) {
  const excluded = new Set();
  for (const address of [...(filters.exclude || []), ...excludeAddresses]) {
    const resolved = entitlementKey(address);
    if (resolved?.key) excluded.add(resolved.key);
    if (typeof address === 'string') excluded.add(address.trim());
  }

  const minBalance = filters.minBalance ? BigInt(filters.minBalance) : 0n;
  const excludeScripts = filters.excludeScripts !== false;
  const skipped = { invalid: 0, script: 0, excluded: 0, belowMinimum: 0, zeroAmount: 0 };
  const holders = new Map();

  for (const row of rows) {
    const resolved = entitlementKey(row.address);
    if (!resolved) {
      skipped.invalid += 1;
      continue;
    }
    if (resolved.skip === 'script') {
      if (excludeScripts) {
        skipped.script += 1;
        continue;
      }
      resolved.key = row.address.trim();
      resolved.keyType = 'address';
    }
    if (excluded.has(resolved.key)) {
      skipped.excluded += 1;
      continue;
    }

    let balance;
    if (distribution.mode === 'manual') {
      balance = parseTokenAmount(row.quantity, decimals, `Amount for ${row.address}`);
    } else {
      try {
        balance = BigInt(row.quantity ?? 1);
      } catch {
        balance = 0n;
      }
    }
    if (balance <= 0n) {
      skipped.invalid += 1;
      continue;
    }

    const existing = holders.get(resolved.key);
    if (existing) {
      existing.balance += balance;
    } else {
      holders.set(resolved.key, { key: resolved.key, keyType: resolved.keyType, balance });
    }
  }

  let eligible = [...holders.values()];
  if (distribution.mode !== 'manual' && minBalance > 0n) {
    const before = eligible.length;
    eligible = eligible.filter((holder) => holder.balance >= minBalance);
    skipped.belowMinimum = before - eligible.length;
  }

  const totalBalance = eligible.reduce((sum, holder) => sum + holder.balance, 0n);
  const entitlements = [];
  for (const holder of eligible) {
    let amount;
    if (distribution.mode === 'fixed') {
      amount = BigInt(distribution.amountPerHolder);
    } else if (distribution.mode === 'proportional') {
      amount = (BigInt(distribution.totalAmount) * holder.balance) / totalBalance;
    } else {
      amount = holder.balance;
    }
    if (amount <= 0n) {
      skipped.zeroAmount += 1;
      continue;
    }
    entitlements.push({
      key: holder.key,
      keyType: holder.keyType,
      balance: holder.balance.toString(),
      amount: amount.toString(),
    });
  }

  if (entitlements.length > MAX_ENTITLEMENTS) {
    throw new SnapshotError(`A campaign supports at most ${MAX_ENTITLEMENTS} claimants.`);
  }

  const totalAmount = entitlements.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  return {
    entitlements,
    skipped,
    totalBalance: totalBalance.toString(),
    totalAmount: totalAmount.toString(),
  };
}

import { koiosBase } from './claim-snapshot.js';

const REQUEST_TIMEOUT_MS = 20_000;

export class ChainError extends Error {}

async function koios(network, path, { method = 'GET', body, contentType = 'application/json', fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(`${koiosBase(network)}/${path}`, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': contentType } : {}) },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new ChainError(`Koios request failed: ${error.message}`);
  }

  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 300);
    throw new ChainError(`Koios responded with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return response.json();
}

export function fetchProtocolParams(network, fetchImpl) {
  return koios(network, 'cli_protocol_params', { fetchImpl });
}

export async function fetchAddressUtxos(address, network, fetchImpl) {
  const utxos = await koios(network, 'address_utxos', {
    method: 'POST',
    body: JSON.stringify({ _addresses: [address], _extended: true }),
    fetchImpl,
  });
  if (!Array.isArray(utxos)) throw new ChainError('Koios returned an unexpected UTxO response.');
  return utxos.filter((utxo) => !utxo.is_spent);
}

/** Number of confirmations per transaction hash (0 when Koios hasn't seen it on chain). */
export async function fetchConfirmations(txHashes, network, fetchImpl) {
  if (txHashes.length === 0) return new Map();
  const rows = await koios(network, 'tx_status', {
    method: 'POST',
    body: JSON.stringify({ _tx_hashes: txHashes }),
    fetchImpl,
  });
  return new Map(rows.map((row) => [row.tx_hash, Number(row.num_confirmations) || 0]));
}

export async function submitTransaction(txBytes, network, fetchImpl) {
  const hash = await koios(network, 'submittx', {
    method: 'POST',
    body: txBytes,
    contentType: 'application/cbor',
    fetchImpl,
  });
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash)) {
    throw new ChainError('The network did not accept the transaction.');
  }
  return hash.toLowerCase();
}

/** Lovelace and token totals for one asset across a set of Koios UTxOs. */
export function summarizeUtxos(utxos, { policyId, assetNameHex }) {
  let lovelace = 0n;
  let tokens = 0n;
  for (const utxo of utxos) {
    lovelace += BigInt(utxo.value || 0);
    for (const asset of utxo.asset_list || []) {
      if (asset.policy_id === policyId && (asset.asset_name || '') === assetNameHex) {
        tokens += BigInt(asset.quantity || 0);
      }
    }
  }
  return { lovelace, tokens };
}

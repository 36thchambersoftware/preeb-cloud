import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveHandle } from '../api/_lib/handle.js';
import {
  fetchRegistryLogo,
  imageSourcesFor,
  lookupTokenInfo,
  normalizeImageRef,
  parseCip68,
  resolveHolderToken,
  resolveToken,
} from '../api/_lib/token-info.js';

const POLICY = 'a'.repeat(56);
const text = (value) => ({ bytes: Buffer.from(value).toString('hex') });
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16, 1)]);

function koios(asset) {
  return async () => ({ ok: true, json: async () => (asset ? [asset] : []) });
}

const info = (asset) => lookupTokenInfo(POLICY, '706565', { network: 'mainnet', fetchImpl: koios(asset) });

test('decimals come from the CIP-68 datum before the registry', async () => {
  const result = await info({
    policy_id: POLICY,
    asset_name: '706565',
    asset_name_ascii: 'pee',
    cip68_metadata: { 333: { fields: [{ map: [
      { k: text('name'), v: text('Pee Token') },
      { k: text('ticker'), v: text('PEE') },
      { k: text('decimals'), v: { int: 4 } },
      { k: text('logo'), v: { list: [text('ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9'), text('AQhSm4AvNjzX6qa')] } },
    ] }] } },
    token_registry_metadata: { decimals: 6, ticker: 'OLD', logo: PNG.toString('base64') },
  });

  assert.equal(result.decimals, 4);
  assert.equal(result.decimalsSource, 'cip68');
  assert.equal(result.ticker, 'PEE');
  assert.deepEqual(result.images.map((image) => image.source), ['cip68', 'registry']);
  assert.equal(result.images[0].ref, 'ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa');
});

test('the registry supplies decimals and a logo when there is no CIP-68 datum', async () => {
  const result = await info({
    policy_id: POLICY,
    asset_name: '706565',
    asset_name_ascii: 'pee',
    token_registry_metadata: { decimals: 6, ticker: 'PEE', logo: PNG.toString('base64') },
  });
  assert.equal(result.decimals, 6);
  assert.equal(result.decimalsSource, 'registry');
  assert.deepEqual(result.images, [{
    ref: `registry:${POLICY}.706565`,
    source: 'registry',
    sources: [`/api/claim/token-image?policyId=${POLICY}&assetName=706565`],
  }]);
});

test('CIP-25 mint metadata supplies the image, and decimals default to 0', async () => {
  const result = await info({
    policy_id: POLICY,
    asset_name: '706565',
    asset_name_ascii: 'pee',
    fingerprint: 'asset1abcdefghijk',
    minting_tx_metadata: { 721: { [POLICY]: { pee: { image: ['ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9', 'AQhSm4AvNjzX6qa'] } } } },
  });
  assert.equal(result.decimals, 0);
  assert.equal(result.decimalsSource, 'default');
  assert.equal(result.images[0].source, 'cip25');
  assert.equal(result.images[0].ref, 'ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa');
  assert.equal(result.images[0].sources.length, 4);
});

test('unknown tokens return null and bad metadata cannot inject decimals or tickers', async () => {
  assert.equal(await info(null), null);

  const result = await info({
    policy_id: POLICY,
    asset_name: '706565',
    asset_name_ascii: '<script>',
    fingerprint: 'asset1abcdefghijk',
    token_registry_metadata: { decimals: 99, ticker: 'WAY-TOO-LONG-TICKER!' },
  });
  assert.equal(result.decimals, 0);
  assert.equal(result.ticker, 'asset1abcd');
});

test('image references are normalized and expanded into fallback sources', () => {
  assert.equal(normalizeImageRef('QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa'), 'ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa');
  assert.equal(normalizeImageRef('ipfs://ipfs/QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa'), 'ipfs://QmcSJZWbpueNeejdUsWRmT9MeJZX8d9AQhSm4AvNjzX6qa');
  assert.equal(normalizeImageRef('ar://' + 'a'.repeat(43)), 'ar://' + 'a'.repeat(43));
  assert.throws(() => normalizeImageRef('data:image/png;base64,AAAA'));
  assert.throws(() => normalizeImageRef('http://insecure.test/a.png'));
  assert.throws(() => normalizeImageRef('ipfs://not a cid'));

  assert.deepEqual(imageSourcesFor('ipfs://Qm1').map((url) => new URL(url).host), ['ipfs.filebase.io', 'gateway.pinata.cloud', 'ipfs.io', 'dweb.link']);
  assert.deepEqual(imageSourcesFor('https://example.com/a.png'), ['https://example.com/a.png']);
  assert.deepEqual(imageSourcesFor(null), []);
});

test('parseCip68 flattens the metadata map', () => {
  assert.deepEqual(parseCip68({ 222: { fields: [{ map: [{ k: text('name'), v: text('x') }, { k: text('og'), v: { int: 1 } }] }] } }), { name: 'x', og: 1 });
  assert.deepEqual(parseCip68(null), {});
});

test('only raster registry logos are served', async () => {
  const withLogo = (logo) => async () => ({ ok: true, json: async () => [{ token_registry_metadata: { logo } }] });
  const png = await fetchRegistryLogo(POLICY, '', { fetchImpl: withLogo(PNG.toString('base64')) });
  assert.equal(png.contentType, 'image/png');
  assert.equal(await fetchRegistryLogo(POLICY, '', { fetchImpl: withLogo(Buffer.from('<svg onload=alert(1)>').toString('base64')) }), null);
  assert.equal(await fetchRegistryLogo(POLICY, '', { fetchImpl: withLogo('') }), null);
});

// Fake Koios: asset_list answers from `assets`, asset_info from `infoFor`.
function chainFor(assets, infoFor = () => ({ policy_id: POLICY, asset_name_ascii: 'tok', token_registry_metadata: { decimals: 3, ticker: 'TOK', name: 'Token', url: 'https://token.example/' } })) {
  return async (url, options) => {
    if (url.includes('asset_list')) {
      return { ok: true, json: async () => assets.map((name) => ({ asset_name: Buffer.from(name).toString('hex'), asset_name_ascii: name })) };
    }
    const [[, assetName]] = JSON.parse(options.body)._asset_list;
    return { ok: true, json: async () => [infoFor(assetName)] };
  };
}

test('a policy with one token needs no asset name, and exposes the website', async () => {
  const result = await resolveToken(POLICY, null, { network: 'mainnet', fetchImpl: chainFor(['tok']) });
  assert.equal(result.assetNameHex, Buffer.from('tok').toString('hex'));
  assert.equal(result.website, 'https://token.example/');
  assert.equal(await resolveToken(POLICY, null, { network: 'mainnet', fetchImpl: chainFor([]) }), null);
});

test('a policy with several tokens asks the caller to choose', async () => {
  const result = await resolveToken(POLICY, null, { network: 'mainnet', fetchImpl: chainFor(['one', 'two']) });
  assert.equal(result.needsChoice, true);
  assert.deepEqual(result.assets.map((asset) => asset.name), ['one', 'two']);

  const chosen = await resolveToken(POLICY, Buffer.from('two').toString('hex'), { network: 'mainnet', fetchImpl: chainFor(['one', 'two']) });
  assert.equal(chosen.ticker, 'TOK');
});

test('the holder token is described by name, and collections count whole units', async () => {
  const single = await resolveHolderToken(POLICY, { network: 'mainnet', fetchImpl: chainFor(['tok']) });
  assert.equal(single.decimals, 3);
  assert.equal(single.multiAsset, false);

  const collection = await resolveHolderToken(POLICY, {
    network: 'mainnet',
    fetchImpl: chainFor(['Sock0001', 'Sock0002'], (name) => ({ policy_id: POLICY, asset_name_ascii: Buffer.from(name, 'hex').toString(), token_registry_metadata: {} })),
  });
  assert.equal(collection.name, 'Sock');
  assert.equal(collection.decimals, 0);
  assert.equal(collection.multiAsset, true);
});

test('ADA Handles resolve to $name, with failures and other networks returning null', async () => {
  const stake = 'stake1uxzszp3stm9du96xwdd75hjakcsjmkdtakxfgtksawmjf7g9usd5n';
  const ok = async () => ({ ok: true, status: 200, json: async () => ({ default_handle: 'ockz', handles: ['sockz'] }) });
  assert.equal(await resolveHandle(stake, { fetchImpl: ok, now: 1 }), '$ockz');
  assert.equal(await resolveHandle('stake1u8other', { fetchImpl: async () => { throw new Error('down'); }, now: 1 }), null);
  assert.equal(await resolveHandle(stake, { network: 'preprod', fetchImpl: ok }), null);
});

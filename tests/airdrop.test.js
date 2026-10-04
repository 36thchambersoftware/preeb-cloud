import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../airdrop.js', import.meta.url), 'utf8');

function createHarness({
  balance = 1_167_240_000n,
  payouts = [600],
  budget = '600',
  thankYou = '6',
  deposit = 0n,
  fallback = false,
  strategy = { LargestFirstMultiAsset: 3, LargestFirst: 0 },
  changeError = null,
} = {}) {
  const events = [];
  const outputs = [];
  let selected = 0n;
  let selectedStrategy;
  const fee = 200_000n;
  const coin = (value) => ({ to_str: () => String(value) });
  const utxo = {
    output: () => ({
      address: () => 'wallet',
      amount: () => ({ coin: () => coin(balance) }),
    }),
    input: () => 'input',
  };
  const body = { fee: () => coin(fee) };
  const builder = {
    set_auxiliary_data() {},
    set_certs() {},
    add_output(output) {
      events.push('output');
      outputs.push(BigInt(output.amount.coin().to_str()));
    },
    add_change_if_needed() {
      events.push('change');
      if (changeError) throw changeError;
      const required = outputs.reduce((total, value) => total + value, deposit) + fee;
      if (selected < required) throw new Error('Insufficient input in transaction');
    },
    build: () => body,
  };
  if (fallback) {
    builder.add_regular_input = () => {
      events.push('input');
      selected += balance;
    };
  } else {
    builder.add_inputs_from = (_utxos, value) => {
      events.push('selection');
      selectedStrategy = value;
      const required = outputs.reduce((total, output) => total + output, deposit) + fee;
      selected = balance >= required ? balance : 0n;
    };
  }
  const csl = {
    BigNum: { from_str: coin },
    Address: { from_bech32: (value) => value, from_bytes: () => 'wallet' },
    Value: { new: (value) => ({ coin: () => value }) },
    TransactionOutput: { new: (address, amount) => ({ address, amount }) },
    TransactionBuilder: { new: () => builder },
    TransactionUnspentOutput: { from_bytes: () => utxo },
    TransactionUnspentOutputs: {
      new: () => {
        const values = [];
        return {
          add: (value) => values.push(value),
          len: () => values.length,
          get: (index) => values[index],
        };
      },
    },
    CoinSelectionStrategyCIP2: strategy,
    TransactionWitnessSet: { new: () => ({}) },
    Transaction: { new: () => ({ to_bytes: () => new Uint8Array(200) }) },
  };
  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, { value: '', hidden: false, disabled: false });
      return elements.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const context = vm.createContext({
    document,
    TextEncoder,
    cslMock: csl,
    apiMock: { getChangeAddress: async () => '00' },
    deposit,
    preview: {
      recipientCount: payouts.length,
      paidAda: payouts.reduce((total, payout) => total + payout, 0),
      rows: payouts.map((payoutAda) => ({ status: 'Valid', address: 'recipient', payoutAda })),
    },
  });
  const setup = `
    latestPreviewResult = preview;
    loadCardanoSerializationLib = async () => cslMock;
    getWalletUtxosWithRefresh = async () => ({ api: apiMock, utxoHexes: ['00'] });
    fetchKoiosJson = async () => ({ max_tx_size: 16384 });
    buildTransactionConfig = () => ({ config: {}, maxTxSize: 16384, keyDeposit: 2000000 });
    buildPreebDelegationCertificates = async () => ({
      certificates: deposit ? {} : null, registrationDeposit: deposit,
    });
    buildAirdropMetadata = () => ({});
    setExecutionMessage = () => {};
    globalThis.prepare = prepareAirdropTransaction;
    globalThis.formatError = formatTransactionPreparationError;
    globalThis.prepared = () => latestPreparedBatch;
  })();`;
  vm.runInContext(source.slice(0, source.indexOf("  holderFileInput.addEventListener('change'")) + setup, context);
  elements.get('budget-ada').value = budget;
  elements.get('thank-you-ada').value = thankYou;
  return { context, events, outputs, selectedStrategy: () => selectedStrategy };
}

test('606 ADA airdrop builds with 1167.24 ADA after outputs precede selection', async () => {
  const harness = createHarness();
  await harness.context.prepare();
  assert.deepEqual(harness.outputs, [600_000_000n, 6_000_000n]);
  assert.deepEqual(harness.events, ['output', 'output', 'selection', 'change']);
  assert.equal(harness.context.prepared().feeLovelace, 200_000n);
});

test('selection includes remainder, thank-you payment and delegation deposit', async () => {
  const harness = createHarness({ payouts: [590], deposit: 2_000_000n });
  await harness.context.prepare();
  assert.deepEqual(harness.outputs, [590_000_000n, 16_000_000n]);
  assert.ok(harness.context.prepared());
});

test('preflight includes remainder rather than only recipient payouts', async () => {
  const harness = createHarness({ balance: 595_000_000n, payouts: [590], thankYou: '0' });
  await assert.rejects(harness.context.prepare(), /Required 600\.00.*available 595\.00/);
  assert.ok(!harness.events.includes('selection'));
});

test('preflight includes registration deposit', async () => {
  const harness = createHarness({ balance: 607_000_000n, deposit: 2_000_000n });
  await assert.rejects(harness.context.prepare(), /Required 608\.00.*available 607\.00/);
});

test('zero wallet balance is reported rather than an unknown balance', async () => {
  const harness = createHarness({ balance: 0n });
  await assert.rejects(harness.context.prepare(), /available 0\.00/);
});

test('fee shortage is reported as a balancing failure with library details', async () => {
  const harness = createHarness({ balance: 606_000_000n });
  await assert.rejects(harness.context.prepare(), /Unable to balance.*Insufficient input/);
});

test('token change shortage preserves the underlying failure', async () => {
  const harness = createHarness({ changeError: 'Insufficient ADA for multiasset change' });
  await assert.rejects(harness.context.prepare(), /minimum ADA.*Insufficient ADA for multiasset change/);
});

test('regular-input fallback builds after adding all outputs', async () => {
  const harness = createHarness({ fallback: true });
  await harness.context.prepare();
  assert.deepEqual(harness.events, ['output', 'output', 'input', 'change']);
});

test('zero-valued coin selection enum is not replaced by another strategy', async () => {
  const harness = createHarness({ strategy: { LargestFirstMultiAsset: 0, LargestFirst: 1 } });
  await harness.context.prepare();
  assert.equal(harness.selectedStrategy(), 0);
});

test('sub-minimum remainder is excluded when no PREEB output is added', async () => {
  const harness = createHarness({
    balance: 600_300_000n, payouts: [600], budget: '600.5', thankYou: '0',
  });
  await harness.context.prepare();
  assert.deepEqual(harness.outputs, [600_000_000n]);
});

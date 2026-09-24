(function () {
  'use strict';

  const REMAINDER_WALLET = 'addr1qxpxx5xgkqxm42sw2pzx68hjf3v8n6d3nhv7leyxgnre0n2rq7ll2fcjhuqdrtfdwufjmcx42mtgsgz299gmv74w3w5q6zeyv2';
  const REMAINDER_WALLET_NAME = '$preebot';
  const PREEB_POOL_ID_HEX = '2873902b027727676630f3c9c63830183049b7e09998bd7b90114e13';
  const LOVELACE_PER_ADA = 1_000_000n;
  const MIN_ADA_OUTPUT_LOVELACE = LOVELACE_PER_ADA;
  const MAX_AIRDROP_METADATA_BYTES = 160;
  const PREEB_AIRDROP_SIGNATURE = 'Airdrop courtesy of PREEB';
  const MAX_AIRDROP_NOTE_BYTES = MAX_AIRDROP_METADATA_BYTES - new TextEncoder().encode(PREEB_AIRDROP_SIGNATURE).length;
  const METADATA_TEXT_CHUNK_BYTES = 64;

  const holderFileInput = document.getElementById('holder-file');
  const holderJsonInput = document.getElementById('holder-json');
  const policyIdInput = document.getElementById('policy-id-input');
  const policyAddressesInput = document.getElementById('policy-addresses');
  const budgetInput = document.getElementById('budget-ada');
  const amountModeInput = document.getElementById('amount-mode');
  const thankYouInput = document.getElementById('thank-you-ada');
  const delegateToPreebInput = document.getElementById('delegate-to-preeb');
  const airdropNoteInput = document.getElementById('airdrop-note');
  const calculateBtn = document.getElementById('calculate-airdrop-btn');
  const resetBtn = document.getElementById('reset-airdrop-btn');
  const prepareBtn = document.getElementById('airdrop-prepare-btn');
  const signBtn = document.getElementById('airdrop-sign-btn');

  const uploadPanel = document.getElementById('airdrop-upload-panel');
  const policyPanel = document.getElementById('airdrop-policy-panel');
  const previewBody = document.getElementById('airdrop-preview-body');
  const previewSection = document.getElementById('airdrop-preview');
  const skippedList = document.getElementById('airdrop-skipped-list');
  const skippedListCount = document.getElementById('skipped-list-count');
  const skippedBody = document.getElementById('airdrop-skipped-body');
  const walletStatus = document.getElementById('airdrop-wallet-status');
  const executionMessage = document.getElementById('airdrop-execution-message');
  const executionSteps = document.querySelectorAll('.airdrop-step');
  const holderJsonStatus = document.getElementById('holder-json-status');

  let latestPreviewResult = null;
  let connectedWalletApi = null;
  let latestPreparedBatch = null;
  const KOIOS_POLICY_CACHE_KEY = 'preeb-koios-policy-cache';
  const koiosPolicyCache = new Map();

  const summaryRecipients = document.getElementById('summary-recipients');
  const summaryPaid = document.getElementById('summary-paid');
  const summaryFee = document.getElementById('summary-fee');
  const summarySkipped = document.getElementById('summary-skipped');

  function formatAda(value) {
    const numericValue = Number(value || 0);
    return `${numericValue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₳`;
  }

  function formatAddress(address) {
    if (address.length <= 30) return address;
    return `${address.slice(0, 18)}...${address.slice(-10)}`;
  }

  function normalizeRows(rawInput) {
    if (rawInput == null) return [];

    if (Array.isArray(rawInput)) {
      return rawInput.filter(Boolean);
    }

    if (typeof rawInput === 'object') {
      if (Array.isArray(rawInput.holders)) return rawInput.holders;
      if (Array.isArray(rawInput.recipients)) return rawInput.recipients;
      if (Array.isArray(rawInput.addresses)) return rawInput.addresses.map((item) => ({ address: item }));
    }

    return [];
  }

  function parseAddressEntry(entry, index = 0, sourceName = 'holders') {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`${sourceName} row ${index + 1} is not a valid object. Use { "address": "...", "amount": 1 } format.`);
    }

    const address = typeof entry.address === 'string' ? entry.address.trim() : '';
    if (!address) {
      throw new Error(`${sourceName} row ${index + 1} is missing a valid address.`);
    }

    const rawAmount = entry.amount ?? entry.quantity ?? entry.qty ?? entry.value;
    if (rawAmount === undefined || rawAmount === null || rawAmount === '') {
      throw new Error(`${sourceName} row ${index + 1} is missing a positive numeric amount. Use "amount" or "quantity" with a number greater than 0.`);
    }

    const amount = Number(rawAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      throw new Error(`${sourceName} row ${index + 1} has an invalid amount (${rawAmount}). Use a positive number greater than 0.`);
    }

    return {
      address,
      amount,
    };
  }

  function parseBudget(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  }

  function parseMinAmount() {
    return 1;
  }

  function parseThankYou() {
    return parseBudget(thankYouInput.value);
  }

  function getMode() {
    const active = document.querySelector('.airdrop-mode-switch__button.is-active');
    return active ? active.dataset.mode : 'upload';
  }

  function setMode(mode) {
    const buttons = document.querySelectorAll('.airdrop-mode-switch__button');
    buttons.forEach((button) => {
      const active = button.dataset.mode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    });

    const uploadVisible = mode === 'upload';
    uploadPanel.classList.toggle('is-visible', uploadVisible);
    uploadPanel.hidden = !uploadVisible;

    policyPanel.classList.toggle('is-visible', !uploadVisible);
    policyPanel.hidden = uploadVisible;
  }

  async function fetchKoiosJson(path, options = {}) {
    const normalizedPath = String(path || '').replace(/^\/+/, '');
    const response = await fetch(`/api/koios/${normalizedPath}`, {
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
      ...options,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Koios request failed (${response.status}): ${text || 'unknown error'}`);
    }

    return response.json();
  }

  async function loadCardanoSerializationLib() {
    const imported = await import('https://esm.sh/@emurgo/cardano-serialization-lib-asmjs@12.1.1?bundle');
    return imported?.default?.TransactionUnspentOutput ? imported.default : imported;
  }

  function lovelaceFromUtxo(csl, utxoHex) {
    const utxo = csl.TransactionUnspentOutput.from_bytes(hexToBytes(utxoHex));
    return BigInt(utxo.output().amount().coin().to_str());
  }

  function hexToBytes(hex) {
    const clean = String(hex || '').replace(/^0x/, '');
    const bytes = new Uint8Array(clean.length / 2);
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = parseInt(clean.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function truncateUtf8Text(value, maxBytes) {
    const encoder = new TextEncoder();
    let byteCount = 0;
    let result = '';

    for (const character of String(value || '')) {
      const characterBytes = encoder.encode(character).length;
      if (byteCount + characterBytes > maxBytes) break;
      result += character;
      byteCount += characterBytes;
    }

    return result;
  }

  function splitMetadataText(value) {
    const encoder = new TextEncoder();
    const chunks = [];
    let chunk = '';
    let chunkBytes = 0;

    for (const character of value) {
      const characterBytes = encoder.encode(character).length;
      if (chunkBytes + characterBytes > METADATA_TEXT_CHUNK_BYTES) {
        chunks.push(chunk);
        chunk = '';
        chunkBytes = 0;
      }
      chunk += character;
      chunkBytes += characterBytes;
    }

    if (chunk) chunks.push(chunk);
    return chunks;
  }

  function buildAirdropMetadata(csl) {
    const userNote = truncateUtf8Text(airdropNoteInput.value, MAX_AIRDROP_NOTE_BYTES);
    const messages = [
      ...(userNote ? splitMetadataText(userNote) : []),
      ...splitMetadataText(PREEB_AIRDROP_SIGNATURE),
    ];
    const metadata = csl.GeneralTransactionMetadata.new();
    const messageMap = csl.MetadataMap.new();
    const messageList = csl.MetadataList.new();

    messages.forEach((message) => {
      messageList.add(csl.TransactionMetadatum.new_text(message));
    });
    messageMap.insert(
      csl.TransactionMetadatum.new_text('msg'),
      csl.TransactionMetadatum.new_list(messageList)
    );
    metadata.insert(
      csl.BigNum.from_str('674'),
      csl.TransactionMetadatum.new_map(messageMap)
    );

    const auxiliaryData = csl.AuxiliaryData.new();
    auxiliaryData.set_metadata(metadata);
    return auxiliaryData;
  }

  function setExecutionMessage(message, isError = false) {
    executionMessage.textContent = message;
    executionMessage.classList.toggle('is-error', isError);
  }

  function setHolderJsonValidationState(isValid, message = '') {
    if (!holderJsonInput || !holderJsonStatus) return;

    holderJsonInput.classList.toggle('is-invalid', !isValid);
    holderJsonInput.classList.toggle('is-valid', isValid);
    holderJsonStatus.hidden = !message;
    holderJsonStatus.textContent = message;
    holderJsonStatus.classList.toggle('is-error', !isValid);
    holderJsonStatus.classList.toggle('is-success', isValid);
  }

  function updateExecutionSteps(activeStep) {
    const order = ['preview', 'build', 'sign'];
    const activeIndex = order.indexOf(activeStep);
    executionSteps.forEach((step) => {
      const stepIndex = order.indexOf(step.dataset.step);
      step.classList.toggle('is-complete', stepIndex < activeIndex || activeStep === 'complete');
      step.classList.toggle('is-active', step.dataset.step === activeStep);
    });
  }

  function getWalletOptions() {
    return window.PreebWallet?.getAvailableWallets?.() || [];
  }

  async function connectAirdropWallet() {
    const wallets = getWalletOptions();
    if (wallets.length === 0) {
      throw new Error('No supported CIP-30 wallet was detected.');
    }

    const selected = wallets[0];
    walletStatus.textContent = `Connecting to ${selected.label}...`;
    connectedWalletApi = await window.PreebWallet.enable(selected);
    walletStatus.textContent = `Connected: ${selected.label}`;
    return connectedWalletApi;
  }

  function isAccountChangeError(error) {
    return /account\s*changed|accountchange/i.test(String(error?.message || error));
  }

  function getErrorText(error) {
    if (!error) return '';
    if (typeof error === 'string') return error.trim();
    if (error instanceof Error && error.message) return error.message.trim();

    const candidates = [
      error.message,
      error.info,
      error.reason,
      error.error,
      error.details,
      error.code,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
      if (candidate && typeof candidate === 'object') {
        const nested = getErrorText(candidate);
        if (nested) return nested;
      }
    }

    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  function formatTransactionPreparationError(error, context = {}) {
    const text = getErrorText(error);
    const readableText = text ? text.replace(/\s+/g, ' ').trim() : '';
    const lower = readableText.toLowerCase();

    if (/insufficient|not enough|balance too low|utxo.*insufficient|lovelace.*insufficient|funds.*low|not enough ada/i.test(lower)) {
      const required = context.requiredLovelace != null ? formatAda(Number(context.requiredLovelace) / 1_000_000) : 'the required ADA';
      const available = context.availableLovelace != null ? formatAda(Number(context.availableLovelace) / 1_000_000) : 'the wallet balance';
      return `Not enough funds in the connected wallet to finish this airdrop. Required ${required}, available ${available}. The wallet also needs to cover the transaction fee and any optional delegation deposit.`;
    }

    if (/account.*changed|accountchange|stale account|wallet account changed/i.test(lower)) {
      return 'The wallet account changed while preparing the transaction. Reconnect the wallet and rebuild the transaction.';
    }

    if (/delegate|stake.*registration|registration.*stake|reward address|reward.*address/i.test(lower)) {
      return 'Delegation setup failed while preparing the transaction. Make sure the wallet can register/delegate to PREEB and try again.';
    }

    if (/too large|max tx size|transaction size|exceeds.*size|safe single-batch limit|split the list into two airdrops|recipient.*limit/i.test(lower)) {
      return 'The generated transaction is too large for a safe single-batch airdrop. Please split the recipient list into two separate airdrops and run them one after the other.';
    }

    if (/no supported cip-30 wallet|wallet.*detected|spendable utxos|does not expose spendable|not available in this browser/i.test(lower)) {
      return 'No compatible wallet is ready to build this transaction. Connect a supported CIP-30 wallet with spendable UTxOs and try again.';
    }

    if (readableText) {
      return `Unable to prepare the transaction: ${readableText}`;
    }

    return 'Unable to prepare the transaction. Check the wallet balance, available UTxOs, and transaction size, then rebuild.';
  }

  async function getWalletUtxosWithRefresh() {
    let api = await connectAirdropWallet();
    if (!api?.getUtxos) throw new Error('The connected wallet does not expose spendable UTxOs.');
    try {
      return { api, utxoHexes: await api.getUtxos() };
    } catch (error) {
      if (!isAccountChangeError(error)) throw error;
      walletStatus.textContent = 'Wallet account changed. Refreshing wallet connection...';
      api = await connectAirdropWallet();
      return { api, utxoHexes: await api.getUtxos() };
    }
  }

  function readProtocolNumber(protocol, ...keys) {
    for (const key of keys) {
      const value = Number(protocol?.[key]);
      if (Number.isFinite(value) && value > 0) return value;
    }
    return null;
  }

  function buildTransactionConfig(csl, protocol) {
    const txFeePerByte = readProtocolNumber(protocol, 'txFeePerByte', 'tx_fee_per_byte');
    const txFeeFixed = readProtocolNumber(protocol, 'txFeeFixed', 'tx_fee_fixed');
    const maxTxSize = readProtocolNumber(protocol, 'maxTxSize', 'max_tx_size') || 16384;
    const maxValueSize = readProtocolNumber(protocol, 'maxValueSize', 'max_value_size') || 5000;
    const poolDeposit = readProtocolNumber(protocol, 'stakePoolDeposit', 'stake_pool_deposit') || 0;
    const keyDeposit = readProtocolNumber(protocol, 'stakeAddressDeposit', 'stake_address_deposit') || 0;
    const coinsPerByte = readProtocolNumber(protocol, 'utxoCostPerByte', 'coinsPerUtxoByte', 'coins_per_utxo_byte');
    const coinsPerWord = readProtocolNumber(protocol, 'utxoCostPerWord', 'coinsPerUtxoWord', 'coins_per_utxo_word', 'lovelacePerUTxOWord');

    if (!txFeePerByte || !txFeeFixed) throw new Error('Koios returned incomplete transaction fee parameters.');

    let builder = csl.TransactionBuilderConfigBuilder.new()
      .fee_algo(csl.LinearFee.new(csl.BigNum.from_str(String(txFeePerByte)), csl.BigNum.from_str(String(txFeeFixed))))
      .pool_deposit(csl.BigNum.from_str(String(poolDeposit)))
      .key_deposit(csl.BigNum.from_str(String(keyDeposit)))
      .max_tx_size(maxTxSize)
      .max_value_size(maxValueSize);

    let setUtxoCost = false;
    if (typeof builder.coins_per_utxo_byte === 'function' && coinsPerByte) {
      builder = builder.coins_per_utxo_byte(csl.BigNum.from_str(String(Math.trunc(coinsPerByte))));
      setUtxoCost = true;
    }
    if (typeof builder.coins_per_utxo_word === 'function' && coinsPerWord) {
      builder = builder.coins_per_utxo_word(csl.BigNum.from_str(String(Math.trunc(coinsPerWord))));
      setUtxoCost = true;
    }
    if (!setUtxoCost) {
      throw new Error('Koios returned no compatible UTxO cost parameter.');
    }

    return { config: builder.build(), maxTxSize, keyDeposit };
  }

  function addAdaOutput(csl, txBuilder, address, lovelace) {
    if (lovelace <= 0n) return;
    if (lovelace < MIN_ADA_OUTPUT_LOVELACE) {
      return;
    }
    const output = csl.TransactionOutput.new(
      csl.Address.from_bech32(address),
      csl.Value.new(csl.BigNum.from_str(String(lovelace)))
    );
    txBuilder.add_output(output);
  }

  async function buildPreebDelegationCertificates(csl, api, keyDeposit) {
    if (!delegateToPreebInput.checked) return { certificates: null, registrationDeposit: 0n };
    if (!api.getRewardAddresses) throw new Error('The connected wallet does not expose a reward address for delegation.');

    const rewardAddresses = await api.getRewardAddresses();
    if (!Array.isArray(rewardAddresses) || rewardAddresses.length === 0) {
      throw new Error('The connected wallet did not return a reward address for delegation.');
    }

    const rewardAddress = csl.RewardAddress.from_address(
      csl.Address.from_bytes(hexToBytes(rewardAddresses[0]))
    );
    if (!rewardAddress) throw new Error('Unable to parse the wallet reward address for delegation.');

    const stakeAddress = rewardAddress.to_address().to_bech32();
    const accountRows = await fetchKoiosJson('account_info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    });
    const account = Array.isArray(accountRows) ? accountRows[0] : accountRows;
    const certificates = csl.Certificates.new();
    const stakeCredential = rewardAddress.payment_cred();
    const needsRegistration = !account || account.status !== 'registered';

    if (needsRegistration) {
      certificates.add(csl.Certificate.new_stake_registration(
        csl.StakeRegistration.new(stakeCredential)
      ));
    }

    certificates.add(csl.Certificate.new_stake_delegation(
      csl.StakeDelegation.new(
        stakeCredential,
        csl.Ed25519KeyHash.from_bytes(hexToBytes(PREEB_POOL_ID_HEX))
      )
    ));

    return {
      certificates,
      registrationDeposit: needsRegistration ? BigInt(Math.trunc(keyDeposit)) : 0n,
    };
  }

  async function signAndSubmitAirdrop() {
    if (!latestPreparedBatch || latestPreparedBatch.batches.length !== 1) {
      throw new Error('Signing is available only after a complete single-batch transaction has been built.');
    }

    const api = await connectAirdropWallet();
    if (!api?.signTx || !api?.submitTx) {
      throw new Error('The connected wallet does not support transaction signing and submission.');
    }

    if (latestPreparedBatch.changeAddressHex && api.getChangeAddress) {
      const currentChangeAddressHex = await api.getChangeAddress();
      if (currentChangeAddressHex !== latestPreparedBatch.changeAddressHex) {
        latestPreparedBatch = null;
        signBtn.hidden = true;
        signBtn.disabled = true;
        prepareBtn.hidden = false;
        prepareBtn.disabled = false;
        updateExecutionSteps('build');
        throw new Error('Wallet account changed. The preview is still loaded; rebuild the transaction for the new wallet.');
      }
    }

    updateExecutionSteps('sign');
    setExecutionMessage('Requesting wallet signature...');
    const signedWitnessHex = await api.signTx(latestPreparedBatch.txHex, true);
    const witnessSet = latestPreparedBatch.csl.TransactionWitnessSet.from_bytes(hexToBytes(signedWitnessHex));
    const signedTx = latestPreparedBatch.csl.Transaction.new(
      latestPreparedBatch.tx.body(),
      witnessSet,
      latestPreparedBatch.tx.auxiliary_data()
    );

    setExecutionMessage('Submitting transaction...');
    const txHash = await api.submitTx(bytesToHex(signedTx.to_bytes()));
    updateExecutionSteps('complete');
    setExecutionMessage(`Transaction submitted successfully: ${txHash}`);
    signBtn.disabled = true;
  }

  async function prepareAirdropTransaction() {
    if (!latestPreviewResult || latestPreviewResult.recipientCount === 0) {
      throw new Error('Calculate a preview with at least one valid recipient first.');
    }

    let csl = null;
    let availableLovelace = 0n;
    let requiredLovelace = 0n;

    try {
      csl = await loadCardanoSerializationLib();
      updateExecutionSteps('build');
      const walletUtxos = await getWalletUtxosWithRefresh();
      const api = walletUtxos.api;
      const utxoHexes = walletUtxos.utxoHexes;
      availableLovelace = (utxoHexes || []).reduce(
        (total, utxoHex) => total + lovelaceFromUtxo(csl, utxoHex),
        0n
      );
      const protocolRaw = await fetchKoiosJson('cli_protocol_params');
      const protocol = Array.isArray(protocolRaw) ? protocolRaw[0] : protocolRaw;
      const { config, maxTxSize, keyDeposit } = buildTransactionConfig(csl, protocol);
      const delegation = await buildPreebDelegationCertificates(csl, api, keyDeposit);
      const payoutLovelace = BigInt(Math.ceil(latestPreviewResult.paidAda * 1_000_000));
      const thankYouLovelace = BigInt(Math.floor(parseThankYou() * Number(LOVELACE_PER_ADA)));
      requiredLovelace = payoutLovelace + thankYouLovelace + delegation.registrationDeposit;

      if (availableLovelace < requiredLovelace) {
        throw new Error(`Insufficient wallet funds. Required ${formatAda(Number(requiredLovelace) / 1_000_000)}, available ${formatAda(Number(availableLovelace) / 1_000_000)}.`);
      }
      const validRows = latestPreviewResult.rows.filter((row) => row.status === 'Valid');
      const maxRecipientsPerBatch = getSafeSingleBatchRecipientLimit(protocol);

      if (validRows.length > maxRecipientsPerBatch) {
        throw new Error(
          `This airdrop has ${validRows.length} valid recipients, which exceeds the safe single-batch limit of ${maxRecipientsPerBatch}. ` +
          'Please split the list into two airdrops and run them separately.'
        );
      }

      const batches = [validRows];
      const firstBatch = batches[0];
      const txBuilder = csl.TransactionBuilder.new(config);
      if (delegation.certificates) txBuilder.set_certs(delegation.certificates);
      const auxiliaryData = buildAirdropMetadata(csl);
      txBuilder.set_auxiliary_data(auxiliaryData);
      const utxos = csl.TransactionUnspentOutputs.new();
      for (const utxoHex of utxoHexes) {
        const utxo = csl.TransactionUnspentOutput.from_bytes(hexToBytes(utxoHex));
        utxos.add(utxo);
      }

      if (txBuilder.add_inputs_from && csl.CoinSelectionStrategyCIP2) {
        const strategy =
          csl.CoinSelectionStrategyCIP2.LargestFirstMultiAsset ||
          csl.CoinSelectionStrategyCIP2.LargestFirst ||
          0;
        txBuilder.add_inputs_from(utxos, strategy);
      } else if (txBuilder.add_regular_input) {
        for (let index = 0; index < utxos.len(); index += 1) {
          const utxo = utxos.get(index);
          txBuilder.add_regular_input(utxo.output().address(), utxo.input(), utxo.output().amount());
        }
      } else {
        throw new Error('Loaded Cardano serialization library has no supported UTxO input-selection method.');
      }

      let firstBatchPayout = 0n;
      for (const row of firstBatch) {
        const payout = BigInt(Math.floor(row.payoutAda * Number(LOVELACE_PER_ADA)));
        firstBatchPayout += payout;
        addAdaOutput(csl, txBuilder, row.address, payout);
      }

      const isSingleBatch = batches.length === 1;
      const requestedLovelace = BigInt(Math.floor(parseBudget(budgetInput.value) * Number(LOVELACE_PER_ADA)));
      const remainderLovelace = isSingleBatch && requestedLovelace > firstBatchPayout
        ? requestedLovelace - firstBatchPayout
        : 0n;
      const preebOutputLovelace = thankYouLovelace + remainderLovelace;
      addAdaOutput(csl, txBuilder, REMAINDER_WALLET, preebOutputLovelace);

      const changeAddressHex = await api.getChangeAddress();
      txBuilder.add_change_if_needed(csl.Address.from_bytes(hexToBytes(changeAddressHex)));
      const txBody = txBuilder.build();
      const tx = csl.Transaction.new(txBody, csl.TransactionWitnessSet.new(), auxiliaryData);
      const txHex = bytesToHex(tx.to_bytes());
      const txSize = tx.to_bytes().length;
      if (txSize > maxTxSize) {
        throw new Error(`Built batch is ${txSize} bytes, above the Cardano max transaction size of ${maxTxSize} bytes.`);
      }

      latestPreparedBatch = {
        csl,
        tx,
        txHex,
        txSize,
        feeLovelace: BigInt(txBody.fee().to_str()),
        changeAddressHex,
        batches,
      };
      signBtn.hidden = batches.length !== 1;
      signBtn.disabled = batches.length !== 1;

      setExecutionMessage(
        `Wallet check passed: ${formatAda(Number(availableLovelace) / 1_000_000)} available. ` +
        `Built single-batch airdrop with ${firstBatch.length} recipients, ${txSize} / ${maxTxSize} bytes, ` +
        `network fee ${formatAda(Number(txBody.fee().to_str()) / 1_000_000)}. Sign and submit is ready.`
      );
      updateExecutionSteps('sign');
    } catch (error) {
      const friendlyMessage = formatTransactionPreparationError(error, {
        availableLovelace: availableLovelace || null,
        requiredLovelace: requiredLovelace || null,
      });
      throw new Error(friendlyMessage);
    }
  }

  function cloneNormalizedHolderRows(rows) {
    if (!Array.isArray(rows)) return [];

    return rows
      .filter((row) => row && typeof row === 'object')
      .map((row) => {
        const address = typeof row.address === 'string' ? row.address.trim() : '';
        const amount = Number(row.amount ?? row.quantity ?? row.qty ?? row.value ?? row.balance ?? 0);

        if (!address || !Number.isFinite(amount) || amount <= 0) {
          return null;
        }

        return {
          address,
          amount,
        };
      })
      .filter(Boolean);
  }

  function readKoiosPolicyCache() {
    try {
      const raw = window.localStorage?.getItem(KOIOS_POLICY_CACHE_KEY);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;

      Object.entries(parsed).forEach(([policyId, rows]) => {
        if (Array.isArray(rows)) {
          koiosPolicyCache.set(policyId, cloneNormalizedHolderRows(rows));
        }
      });
    } catch {
      // Ignore cache read failures and fall back to a fresh fetch.
    }
  }

  function writeKoiosPolicyCache() {
    try {
      const record = Object.fromEntries(
        [...koiosPolicyCache.entries()].map(([policyId, rows]) => [policyId, rows])
      );
      window.localStorage?.setItem(KOIOS_POLICY_CACHE_KEY, JSON.stringify(record));
    } catch {
      // Ignore storage write failures and keep the in-memory cache.
    }
  }

  function populateHolderJsonFromRows(rows) {
    if (!holderJsonInput) return;
    const normalizedRows = cloneNormalizedHolderRows(rows);
    holderJsonInput.value = JSON.stringify(normalizedRows, null, 2);
  }

  async function fetchPolicyHolderRows(policyId) {
    const normalizedPolicyId = String(policyId || '').trim().toLowerCase().replace(/^0x/, '');
    if (!normalizedPolicyId) return [];

    const policyOnlyId = normalizedPolicyId.length === 112
      ? normalizedPolicyId.slice(0, 56)
      : normalizedPolicyId;

    if (!/^[0-9a-f]{56}$/.test(policyOnlyId)) {
      throw new Error('Enter a 56-character policy ID or a 112-character asset identifier.');
    }

    if (koiosPolicyCache.has(policyOnlyId)) {
      return [...koiosPolicyCache.get(policyOnlyId)];
    }

    const candidatePaths = [
      `policy_holders?_asset_policy=${encodeURIComponent(policyOnlyId)}`,
    ];

    let lastError = null;

    for (const path of candidatePaths) {
      try {
        const rows = await fetchKoiosJson(path);
        if (!Array.isArray(rows)) continue;

        const parsed = cloneNormalizedHolderRows(
          rows.map((row) => {
            if (!row || typeof row !== 'object') return null;

            const address = typeof row.payment_address === 'string'
              ? row.payment_address.trim()
              : typeof row.address === 'string'
                ? row.address.trim()
                : typeof row.stake_address === 'string'
                  ? row.stake_address.trim()
                  : '';

            const quantity = Number(row.quantity ?? row.amount ?? row.balance ?? row.qty ?? row.total ?? 1);
            return {
              address,
              amount: quantity,
            };
          })
        );

        if (parsed.length > 0) {
          koiosPolicyCache.set(policyOnlyId, parsed.map((row) => ({ ...row })));
          writeKoiosPolicyCache();
          return [...koiosPolicyCache.get(policyOnlyId)];
        }
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    return [];
  }

  function formatJsonError(error, sourceLabel) {
    const rawMessage = error instanceof Error ? error.message : String(error || 'Unknown JSON error');
    return `${sourceLabel} is invalid JSON: ${rawMessage}. Fix the formatting and use an array of objects with a valid address and positive numeric amount.`;
  }

  function getSafeSingleBatchRecipientLimit(protocolLike = null) {
    const maxTxSize = Number(protocolLike?.max_tx_size ?? protocolLike?.maxTxSize ?? 16384) || 16384;
    const fixedBytes = 900;
    const bytesPerRecipient = 110;
    const nominalMaxRecipientsPerBatch = Math.max(1, Math.floor((maxTxSize - fixedBytes) / bytesPerRecipient));
    const safetyMargin = 0.9;
    return Math.max(1, Math.floor(nominalMaxRecipientsPerBatch * safetyMargin));
  }

  function assertSafeSingleBatchRecipientCount(rows, protocolLike = null) {
    const validRows = Array.isArray(rows) ? rows.filter((row) => row && typeof row.address === 'string' && row.address.trim()) : [];
    const maxRecipientsAllowed = getSafeSingleBatchRecipientLimit(protocolLike);

    if (validRows.length > maxRecipientsAllowed) {
      throw new Error(
        `This list has ${validRows.length} valid recipients, which exceeds the safe single-batch limit of ${maxRecipientsAllowed}. ` +
        'Please split the list into two airdrops and run them separately.'
      );
    }
  }

  function validateRows(rows, sourceLabel) {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new Error(`${sourceLabel} is empty or not an array of holder objects.`);
    }

    return rows.map((row, index) => parseAddressEntry(row, index, sourceLabel));
  }

  function parseHolderDataFromInputs() {
    const mode = getMode();

    if (mode === 'upload') {
      const raw = holderJsonInput.value.trim();
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          const rows = validateRows(normalizeRows(parsed), 'Holders JSON');
          assertSafeSingleBatchRecipientCount(rows);
          return rows;
        } catch (error) {
          if (error instanceof Error && /Holders JSON|missing a valid address|positive numeric amount|not a valid object|safe single-batch limit|Please split the list into two airdrops/.test(error.message)) {
            throw error;
          }
          throw new Error(formatJsonError(error, 'Holders JSON'));
        }
      }

      if (holderFileInput.files && holderFileInput.files[0]) {
        return new Promise((resolve, reject) => {
          const file = holderFileInput.files[0];
          const reader = new FileReader();

          reader.onload = () => {
            try {
              const parsed = JSON.parse(String(reader.result || ''));
              const rows = validateRows(normalizeRows(parsed), 'Uploaded holders JSON');
              assertSafeSingleBatchRecipientCount(rows);
              resolve(rows);
            } catch (error) {
              if (error instanceof Error && /Uploaded holders JSON|missing a valid address|positive numeric amount|not a valid object|safe single-batch limit|Please split the list into two airdrops/.test(error.message)) {
                reject(error);
                return;
              }
              reject(new Error(formatJsonError(error, 'Uploaded holders JSON')));
            }
          };

          reader.onerror = () => reject(new Error('The uploaded file could not be read.'));
          reader.readAsText(file);
        });
      }

      return [];
    }

    const policyId = (policyIdInput.value || '').trim();
    const rawPolicyInput = policyAddressesInput ? policyAddressesInput.value.trim() : '';

    if (rawPolicyInput) {
      try {
        const parsed = JSON.parse(rawPolicyInput);
        const rows = validateRows(normalizeRows(parsed), 'Pasted holder list');

        if (rows.length === 0) {
          throw new Error('No valid recipient rows were found in the pasted holder list. Please verify the JSON shape and try again.');
        }

        assertSafeSingleBatchRecipientCount(rows);
        populateHolderJsonFromRows(rows);
        return rows;
      } catch (error) {
        if (error instanceof Error && /Pasted holder list|missing a valid address|positive numeric amount|not a valid object|No valid recipient rows|safe single-batch limit|Please split the list into two airdrops/.test(error.message)) {
          throw error;
        }
        throw new Error(formatJsonError(error, 'Pasted holder list'));
      }
    }

    if (!policyId) {
      return [];
    }

    return fetchPolicyHolderRows(policyId).then((rows) => {
      if (rows.length === 0) {
        throw new Error('No current holders were returned for that policy ID. Verify the policy or asset identifier and try again.');
      }
      populateHolderJsonFromRows(rows);
      return rows;
    });
  }

  function validateManualAmountsAgainstBudget(rows, totalBudgetAda) {
    const candidateRows = Array.isArray(rows) ? rows : [];
    const entriesWithExplicitAmounts = candidateRows.filter((row) => {
      const value = row?.amount ?? row?.quantity ?? row?.qty ?? row?.value;
      return value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
    });

    if (entriesWithExplicitAmounts.length === 0) return totalBudgetAda;

    const manualTotalAda = entriesWithExplicitAmounts.reduce((sum, row) => {
      const value = Number(row.amount ?? row.quantity ?? row.qty ?? row.value ?? 0);
      return sum + (Number.isFinite(value) ? value : 0);
    }, 0);

    if (manualTotalAda > 0 && Math.abs(totalBudgetAda - manualTotalAda) > 0.000001) {
      throw new Error(
        `Manual amounts are authoritative. The total of the entered values is ${formatAda(manualTotalAda)} but the budget is ${formatAda(totalBudgetAda)}. ` +
        'Please make the budget match the manual total or remove the explicit amounts so the calculator can allocate from the budget.'
      );
    }

    return manualTotalAda > 0 ? manualTotalAda : totalBudgetAda;
  }

  function buildAirdropRows(rows, totalBudgetAda, feeAda, minimumAda, mode) {
    const validRows = rows
      .filter((row) => row && typeof row.address === 'string' && row.address.trim())
      .map((row) => {
        const weight = Number(row.amount ?? row.quantity ?? row.qty ?? row.value ?? 0);
        if (!Number.isFinite(weight) || weight <= 0) {
          throw new Error(`One or more holder rows have an invalid amount. The amount must be a positive number; the budget does not override your entered values.`);
        }
        return {
          address: row.address.trim(),
          weight,
        };
      });

    if (validRows.length === 0) {
      return {
        rows: [],
        recipientCount: 0,
        paidAda: 0,
        feeAda,
        skipped: 0,
        remainderAda: 0,
      };
    }

    const availableBudgetAda = totalBudgetAda;
    let paidAda = 0;
    let skipped = 0;
    let remainderAda = 0;

    const totalWeight = validRows.reduce((sum, item) => sum + (item.weight > 0 ? item.weight : 1), 0);
    const computedRows = validRows.map((row) => {
      const weight = row.weight > 0 ? row.weight : 1;
      const share = mode === 'weighted'
        ? (weight / totalWeight) * availableBudgetAda
        : availableBudgetAda / validRows.length;

      const payoutAda = share < minimumAda ? 0 : Math.max(0, share);
      if (payoutAda < minimumAda) {
        skipped += 1;
        return { ...row, payoutAda: 0, calculatedAda: share, status: 'Skipped' };
      }

      paidAda += payoutAda;
      return { ...row, payoutAda, status: 'Valid' };
    });

    computedRows.sort((left, right) => right.payoutAda - left.payoutAda || right.weight - left.weight);
    const totalPayout = computedRows.reduce((sum, row) => sum + row.payoutAda, 0);
    remainderAda = Math.max(0, totalBudgetAda - totalPayout);

    return {
      rows: computedRows,
      recipientCount: computedRows.filter((row) => row.payoutAda >= minimumAda).length,
      paidAda: totalPayout,
      feeAda,
      skipped,
      remainderAda,
    };
  }

  function updateSummary(result) {
    if (!result) {
      summaryRecipients.textContent = '0';
      summaryPaid.textContent = '0 ₳';
      summaryFee.textContent = '0 ₳';
      summarySkipped.textContent = '0';
      return;
    }

    summaryRecipients.textContent = String(result.recipientCount || 0);
    summaryPaid.textContent = formatAda(result.paidAda || 0);
    summaryFee.textContent = formatAda(result.feeAda || 0);
    summarySkipped.textContent = String(result.skipped || 0);
  }

  function renderPreview(rows) {
    const validRows = (rows || []).filter((row) => row.status === 'Valid');
    const skippedRows = (rows || []).filter((row) => row.status === 'Skipped');

    if (validRows.length === 0) {
      previewBody.innerHTML = '<tr><td colspan="4" class="empty-state">No data yet — calculate a preview to populate the list.</td></tr>';
    } else {
      previewBody.innerHTML = validRows.map((row) => renderPreviewRow(row)).join('');
    }

    skippedListCount.textContent = String(skippedRows.length);
    skippedList.hidden = skippedRows.length === 0;
    skippedBody.innerHTML = skippedRows.map((row) => renderPreviewRow(row)).join('');
  }

  function renderPreviewRow(row) {
      const statusClass = row.status === 'Valid' ? 'status-badge--valid' : 'status-badge--skipped';
      const displayedAmount = row.status === 'Skipped' ? row.calculatedAda : row.payoutAda;
      const awardText = displayedAmount > 0 ? formatAda(displayedAmount) : '0.00 ₳';
      return `
        <tr>
          <td title="${row.address}">${formatAddress(row.address)}</td>
          <td>${Number(row.weight || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
          <td>${awardText}</td>
          <td><span class="status-badge ${statusClass}">${row.status}</span></td>
        </tr>
      `;
  }

  function clearSkippedList() {
    skippedList.hidden = true;
    skippedListCount.textContent = '0';
    skippedBody.innerHTML = '';
  }

  function invalidatePreparedTransaction(message) {
    if (!latestPreparedBatch) return;
    latestPreparedBatch = null;
    signBtn.hidden = true;
    signBtn.disabled = true;
    prepareBtn.hidden = !latestPreviewResult || latestPreviewResult.recipientCount === 0;
    prepareBtn.disabled = prepareBtn.hidden;
    updateExecutionSteps('build');
    setExecutionMessage(message);
  }

  function renderLoadingState() {
    previewBody.innerHTML = '<tr><td colspan="4" class="empty-state">Loading current holders from Koios. This can take up to a minute for large policies...</td></tr>';
    clearSkippedList();
  }

  function targetPreview() {
    previewSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    previewSection.focus({ preventScroll: true });
  }

  function calculateAirdrop() {
    if (calculateBtn.disabled) return;

    targetPreview();
    updateExecutionSteps('preview');
    latestPreparedBatch = null;
    prepareBtn.hidden = true;
    signBtn.disabled = true;
    signBtn.hidden = true;

    const budgetAda = parseBudget(budgetInput.value);
    const feeAda = parseThankYou();
    const minimumAda = parseMinAmount();
    const mode = amountModeInput.value === 'weighted' ? 'weighted' : 'equal';

    calculateBtn.disabled = true;
    calculateBtn.textContent = 'Loading holders...';
    renderLoadingState();

    const parseRows = parseHolderDataFromInputs();
    const rowsPromise = parseRows instanceof Promise ? parseRows : Promise.resolve(parseRows);

    rowsPromise
      .then((rows) => {
        const manualBudget = validateManualAmountsAgainstBudget(rows, budgetAda);
        const result = buildAirdropRows(rows, manualBudget, feeAda, minimumAda, mode);
        latestPreviewResult = result;
        latestPreparedBatch = null;
        signBtn.disabled = true;
        signBtn.hidden = true;
        prepareBtn.hidden = result.recipientCount === 0;
        prepareBtn.disabled = result.recipientCount === 0;
        setExecutionMessage(
          result.recipientCount > 0
            ? 'Preview ready. Check the wallet and build the transaction batch.'
            : 'No qualifying recipients are available to build.'
        );
        updateExecutionSteps(result.recipientCount > 0 ? 'build' : 'preview');
        updateSummary(result);
        renderPreview(result.rows);
      })
      .catch((error) => {
        latestPreviewResult = null;
        latestPreparedBatch = null;
        prepareBtn.hidden = true;
        prepareBtn.disabled = true;
        signBtn.disabled = true;
        updateExecutionSteps('preview');
        setExecutionMessage(error.message || 'Unable to calculate the airdrop preview.', true);
        previewBody.innerHTML = `<tr><td colspan="4" class="empty-state">${error.message || 'Unable to calculate the airdrop preview.'}</td></tr>`;
      })
      .finally(() => {
        calculateBtn.disabled = false;
        calculateBtn.textContent = 'Calculate preview';
      });
  }

  function resetAirdropForm() {
    holderFileInput.value = '';
    holderJsonInput.value = '';
    policyIdInput.value = '';
    if (policyAddressesInput) policyAddressesInput.value = '';
    budgetInput.value = '100';
    thankYouInput.value = '0';
    delegateToPreebInput.checked = false;
    airdropNoteInput.value = '';
    amountModeInput.value = 'weighted';
    latestPreviewResult = null;
    latestPreparedBatch = null;
    prepareBtn.hidden = true;
    prepareBtn.disabled = true;
    signBtn.disabled = true;
    signBtn.hidden = true;
    updateExecutionSteps('preview');
    setMode('upload');
    summaryRecipients.textContent = '0';
    summaryPaid.textContent = '0 ₳';
    summaryFee.textContent = '0 ₳';
    summarySkipped.textContent = '0';
    renderPreview([]);
  }

  holderFileInput.addEventListener('change', () => {
    if (holderFileInput.files && holderFileInput.files[0]) {
      holderJsonInput.value = '';
    }
  });

  holderJsonInput.addEventListener('input', async () => {
    const raw = holderJsonInput.value.trim();
    if (!raw) {
      setHolderJsonValidationState(false, '');
      setExecutionMessage('Calculate a preview to unlock the wallet check.');
      return;
    }

    try {
      const parsed = JSON.parse(raw);
      const rows = validateRows(normalizeRows(parsed), 'Holders JSON');
      assertSafeSingleBatchRecipientCount(rows);
      setHolderJsonValidationState(true, 'JSON looks valid. Ready to calculate the preview.');
      setExecutionMessage('JSON looks valid. Ready to calculate the preview.');
    } catch (error) {
      const message = error instanceof Error && /(safe single-batch limit|Please split the list into two airdrops)/.test(error.message)
        ? error.message
        : formatJsonError(error, 'Holders JSON');
      setHolderJsonValidationState(false, message);
      setExecutionMessage(message, true);
    }
  });

  if (policyIdInput) {
    let policyLookupTimer = null;

    policyIdInput.addEventListener('input', () => {
      const policyId = policyIdInput.value.trim();
      if (!policyId) {
        holderJsonInput.value = '';
        setHolderJsonValidationState(false, '');
        setExecutionMessage('Enter a policy ID to load holders from Koios.');
        return;
      }

      if (policyLookupTimer) clearTimeout(policyLookupTimer);
      policyLookupTimer = setTimeout(async () => {
        try {
          const rows = await fetchPolicyHolderRows(policyId);
          if (!rows.length) {
            throw new Error('No current holders were returned for that policy ID. Verify the policy or asset identifier and try again.');
          }

          populateHolderJsonFromRows(rows);
          assertSafeSingleBatchRecipientCount(rows);
          setHolderJsonValidationState(true, `Loaded ${rows.length} valid holders from Koios. Ready to calculate or split this JSON into multiple airdrops.`);
          setExecutionMessage(`Loaded ${rows.length} valid holders from Koios. Ready to calculate or split this JSON into multiple airdrops.`);
        } catch (error) {
          const message = error instanceof Error && /(safe single-batch limit|Please split the list into two airdrops)/.test(error.message)
            ? error.message
            : error.message || 'Unable to load holders from that policy ID.';

          if (holderJsonInput && !holderJsonInput.value.trim()) {
            holderJsonInput.value = '';
          }
          setHolderJsonValidationState(false, message);
          setExecutionMessage(message, true);
        }
      }, 250);
    });
  }

  delegateToPreebInput.addEventListener('change', () => {
    invalidatePreparedTransaction('Delegation preference changed. Rebuild the transaction to apply it.');
  });

  airdropNoteInput.addEventListener('input', () => {
    const truncatedNote = truncateUtf8Text(airdropNoteInput.value, MAX_AIRDROP_NOTE_BYTES);
    if (airdropNoteInput.value !== truncatedNote) airdropNoteInput.value = truncatedNote;
    invalidatePreparedTransaction('Transaction note changed. Rebuild the transaction to apply it.');
  });

  document.querySelectorAll('.airdrop-mode-switch__button').forEach((button) => {
    button.addEventListener('click', () => setMode(button.dataset.mode));
  });

  calculateBtn.addEventListener('click', calculateAirdrop);
  resetBtn.addEventListener('click', resetAirdropForm);
  prepareBtn.addEventListener('click', async () => {
    prepareBtn.disabled = true;
    setExecutionMessage('Checking wallet balance and transaction limits...');
    try {
      await prepareAirdropTransaction();
    } catch (error) {
      setExecutionMessage(error.message || formatTransactionPreparationError(error), true);
    } finally {
      prepareBtn.disabled = !latestPreviewResult || latestPreviewResult.recipientCount === 0;
    }
  });
  signBtn.addEventListener('click', async () => {
    signBtn.disabled = true;
    try {
      await signAndSubmitAirdrop();
    } catch (error) {
      setExecutionMessage(error.message || 'Unable to sign and submit the transaction.', true);
      signBtn.disabled = !latestPreparedBatch || latestPreparedBatch.batches.length !== 1;
    }
  });

  if (document.querySelector('.nav__hamburger')) {
    const nav = document.querySelector('.nav');
    const hamburger = document.querySelector('.nav__hamburger');

    hamburger.addEventListener('click', () => {
      const open = nav.classList.toggle('nav--open');
      hamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });
  }

  readKoiosPolicyCache();
  amountModeInput.value = 'weighted';
  setMode('upload');
  updateSummary({ recipientCount: 0, paidAda: 0, feeAda: 0, skipped: 0, remainderAda: 0 });
  renderPreview([]);
})();

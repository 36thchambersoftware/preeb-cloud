/* ================================================================
   PREEB Guest Wall — Page Script
   Self-contained: duplicates the wallet/bech32 helpers from
   profile.js so page logic stays independent.
   ================================================================ */

(function () {
  'use strict';

  const SUPPORTED_WALLETS = [
    { keys: ['eternl'], label: 'Eternl' },
    { keys: ['vespr'],  label: 'Vespr' },
    { keys: ['typhoncip30', 'typhon'], label: 'Typhon' },
    { keys: ['lace'],   label: 'Lace' },
    { keys: ['1am'],    label: '1AM' },
  ];

  const ROLE_IMAGES = new Map([
    ['@PANDA', '/images/bears/panda.png'],
    ['@BLACK BEAR', '/images/bears/black-bear.png'],
    ['@GRIZZLY BEAR', '/images/bears/grizzly-bear.png'],
    ['@POLAR BEAR', '/images/bears/polar-bear.png'],
    ['@CARE BEAR', '/images/bears/care-bear.png'],
  ]);

  const MAX_MESSAGE_LENGTH = 280;

  // ─── Small helpers ──────────────────────────────────────────────

  function getErrorMessage(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err instanceof Error && err.message) return err.message;
    const info = err.info || err.reason || err.error || err.message;
    if (typeof info === 'string' && info.trim()) return info;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }

  function hexToBytes(hex) {
    if (!hex || typeof hex !== 'string') return new Uint8Array();
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  function textToHex(str) {
    return Array.from(new TextEncoder().encode(str))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function bech32Polymod(values) {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >>> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i += 1) {
        if ((top >>> i) & 1) chk ^= GEN[i];
      }
    }
    return chk;
  }

  function bech32HrpExpand(hrp) {
    const out = [];
    for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >> 5);
    out.push(0);
    for (let i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) & 31);
    return out;
  }

  function convertBits(data, fromBits, toBits, pad = true) {
    let acc = 0;
    let bits = 0;
    const ret = [];
    const maxv = (1 << toBits) - 1;

    for (const value of data) {
      if (value < 0 || value >> fromBits) return null;
      acc = (acc << fromBits) | value;
      bits += fromBits;
      while (bits >= toBits) {
        bits -= toBits;
        ret.push((acc >> bits) & maxv);
      }
    }

    if (pad) {
      if (bits > 0) ret.push((acc << (toBits - bits)) & maxv);
    } else if (bits >= fromBits || ((acc << (toBits - bits)) & maxv)) {
      return null;
    }

    return ret;
  }

  function bech32Encode(hrp, data5Bits) {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const values = bech32HrpExpand(hrp).concat(data5Bits).concat([0, 0, 0, 0, 0, 0]);
    const polymod = bech32Polymod(values) ^ 1;
    const checksum = [];
    for (let i = 0; i < 6; i += 1) {
      checksum.push((polymod >> (5 * (5 - i))) & 31);
    }
    const combined = data5Bits.concat(checksum);
    return `${hrp}1${combined.map((x) => CHARSET[x]).join('')}`;
  }

  function rewardHexToStakeBech32(rewardHex) {
    const bytes = hexToBytes(rewardHex);
    if (!bytes.length) throw new Error('Wallet returned an empty reward address');
    const networkId = bytes[0] & 0x0f;
    const hrp = networkId === 1 ? 'stake' : 'stake_test';
    const data5 = convertBits(bytes, 8, 5, true);
    if (!data5) throw new Error('Could not convert reward address to bech32');
    return bech32Encode(hrp, data5);
  }

  function addressHexToBech32(addressHex) {
    const bytes = hexToBytes(addressHex);
    if (!bytes.length) return null;
    const headerByte = bytes[0];
    const addressType = headerByte >> 4;
    const networkTag = headerByte & 0x0f;
    const isReward = addressType === 0xe || addressType === 0xf;
    const hrp = isReward
      ? (networkTag === 1 ? 'stake' : 'stake_test')
      : (networkTag === 1 ? 'addr' : 'addr_test');
    const data5 = convertBits(bytes, 8, 5, true);
    if (!data5) return null;
    return bech32Encode(hrp, data5);
  }

  async function getRepresentativePaymentAddress(api) {
    try {
      if (typeof api.getUsedAddresses !== 'function') return null;
      const usedAddresses = await api.getUsedAddresses();
      if (!Array.isArray(usedAddresses) || usedAddresses.length === 0) return null;
      return addressHexToBech32(usedAddresses[0]);
    } catch {
      return null;
    }
  }

  function getAvailableWallets() {
    if (!window.cardano) return [];
    const discovered = [];
    const seenProvider = new Set();

    for (const config of SUPPORTED_WALLETS) {
      for (const key of config.keys) {
        const provider = window.cardano[key];
        if (provider && typeof provider.enable === 'function' && !seenProvider.has(provider)) {
          seenProvider.add(provider);
          discovered.push({ key, label: config.label, provider });
          break;
        }
      }
    }
    return discovered;
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        let message = `HTTP ${response.status}`;
        try {
          const data = await response.json();
          if (data?.error) message = data.error;
        } catch { /* keep default message */ }
        throw new Error(message);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── Wall rendering ─────────────────────────────────────────────

  function formatDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function renderEntry(entry) {
    const li = document.createElement('li');
    li.className = 'wall-entry';

    const roleImg = entry.role ? ROLE_IMAGES.get(entry.role) : null;
    const avatar = roleImg
      ? `<img class="wall-entry__avatar" src="${roleImg}" alt="" loading="lazy" />`
      : '<span class="wall-entry__avatar" aria-hidden="true">🐾</span>';

    const badges = entry.isDelegator
      ? `<span class="wall-entry__badge">PREEB Delegator</span>${entry.role ? `<span class="wall-entry__badge">${entry.role}</span>` : ''}`
      : '<span class="wall-entry__badge wall-entry__badge--visitor">Visitor</span>';

    const head = document.createElement('div');
    head.className = 'wall-entry__head';
    head.innerHTML = `
      ${avatar}
      <div class="wall-entry__names">
        <span class="wall-entry__name"></span>
        <span class="wall-entry__date">${formatDate(entry.updatedAt || entry.signedAt)}</span>
      </div>`;
    head.querySelector('.wall-entry__name').textContent = entry.handle || entry.stakeDisplay;

    const badgeRow = document.createElement('div');
    badgeRow.className = 'wall-entry__badges';
    badgeRow.innerHTML = badges;

    const message = document.createElement('p');
    message.className = 'wall-entry__message';
    message.textContent = entry.message;

    li.append(head, badgeRow, message);
    return li;
  }

  async function loadWall() {
    const loadingEl = document.getElementById('wall-loading');
    const errorEl = document.getElementById('wall-error');
    const emptyEl = document.getElementById('wall-empty');
    const listEl = document.getElementById('wall-list');
    const countEl = document.getElementById('wall-count');

    try {
      const data = await fetchJsonWithTimeout('/api/wall', { headers: { Accept: 'application/json' } });
      const entries = Array.isArray(data?.entries) ? data.entries : [];
      if (loadingEl) loadingEl.hidden = true;
      if (countEl) countEl.textContent = `${entries.length} signature${entries.length === 1 ? '' : 's'}`;
      if (listEl) {
        listEl.innerHTML = '';
        entries.forEach((entry) => listEl.appendChild(renderEntry(entry)));
      }
      if (emptyEl) emptyEl.hidden = entries.length > 0;
    } catch (err) {
      console.warn('[PREEB] Guest wall load failed:', err);
      if (loadingEl) loadingEl.hidden = true;
      if (errorEl) errorEl.hidden = false;
    }
  }

  // ─── Signing flow ───────────────────────────────────────────────

  function setSignStatus(message, isError = false) {
    const el = document.getElementById('wall-sign-status');
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle('is-error', Boolean(isError));
  }

  function getMessage() {
    const textarea = document.getElementById('wall-message');
    return String(textarea?.value || '').trim();
  }

  async function signWithWallet(walletConfig) {
    const message = getMessage();
    if (!message) {
      setSignStatus('Write a message first, then sign.', true);
      document.getElementById('wall-message')?.focus();
      return;
    }

    try {
      const provider = walletConfig.provider || window.cardano?.[walletConfig.key];
      if (!provider) throw new Error(`${walletConfig.label} is not available in this browser`);

      setSignStatus(`Connecting to ${walletConfig.label}...`);
      const api = await provider.enable();
      if (typeof api.signData !== 'function') {
        throw new Error(`${walletConfig.label} does not support message signing (signData)`);
      }

      const rewardAddresses = await api.getRewardAddresses();
      if (!Array.isArray(rewardAddresses) || rewardAddresses.length === 0) {
        throw new Error('Connected wallet did not return a reward address');
      }
      const rewardAddressHex = rewardAddresses[0];
      const stakeAddress = rewardHexToStakeBech32(rewardAddressHex);
      const paymentAddress = await getRepresentativePaymentAddress(api);

      setSignStatus('Requesting a signing challenge...');
      const nonceResp = await fetchJsonWithTimeout(
        `/api/wall?nonce=1&stake=${encodeURIComponent(stakeAddress)}&message=${encodeURIComponent(message)}`,
        { headers: { Accept: 'application/json' } }
      );

      setSignStatus(`Confirm the signature request in ${walletConfig.label}...`);
      const signResult = await api.signData(rewardAddressHex, textToHex(nonceResp.message));

      setSignStatus('Verifying and posting to the wall...');
      const result = await fetch('/api/wall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          stake: stakeAddress,
          nonce: nonceResp.nonce,
          message,
          signatureHex: signResult.signature,
          keyHex: signResult.key,
          paymentAddress,
        }),
      }).then((r) => r.json());

      if (result.error) throw new Error(result.error);

      setSignStatus('Signed! Your message is on the wall. 🐻');
      const textarea = document.getElementById('wall-message');
      if (textarea) textarea.value = '';
      updateCharCount();
      await loadWall();
    } catch (err) {
      setSignStatus(getErrorMessage(err), true);
    }
  }

  let detectTimer = null;

  function renderWalletChoices() {
    const choices = document.getElementById('wall-wallet-choices');
    if (!choices) return false;

    const available = getAvailableWallets();
    choices.innerHTML = '';

    if (available.length === 0) {
      choices.innerHTML = '<p class="wall-sign-card__note">No supported wallet detected yet. Install Eternl, Vespr, Typhon, or Lace — or keep this tab open a moment.</p>';
      return false;
    }

    available.forEach((walletConfig) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--outline';
      btn.textContent = `Sign with ${walletConfig.label}`;
      btn.addEventListener('click', () => signWithWallet(walletConfig));
      choices.appendChild(btn);
    });
    return true;
  }

  function updateCharCount() {
    const countEl = document.getElementById('wall-char-count');
    if (countEl) countEl.textContent = `${getMessage().length} / ${MAX_MESSAGE_LENGTH}`;
  }

  function init() {
    const yearEl = document.getElementById('year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    const textarea = document.getElementById('wall-message');
    if (textarea) textarea.addEventListener('input', updateCharCount);
    updateCharCount();

    renderWalletChoices();

    // Wallet extensions inject at different times after page load.
    let checkCount = 0;
    detectTimer = window.setInterval(() => {
      checkCount += 1;
      if (renderWalletChoices() || checkCount >= 20) {
        window.clearInterval(detectTimer);
        detectTimer = null;
      }
    }, 1000);

    loadWall();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

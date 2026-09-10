/* ================================================================
   PREEB Delegator Profile — Page Script
   Self-contained: duplicates a handful of small wallet/Koios helpers
   from script.js so the main landing page logic is never touched.
   ================================================================ */

(function () {
  'use strict';

  const POOL_TICKER    = 'PREEB';
  const POOL_ID_BECH32 = 'pool19peeq2czwunkwe3s70yuvwpsrqcyndlqnxvt67usz98px57z7fk';
  const POOL_ID_HEX    = '2873902b027727676630f3c9c63830183049b7e09998bd7b90114e13';
  const KOIOS_DIRECT_URL = 'https://api.koios.rest/api/v1';

  const SUPPORTED_WALLETS = [
    { keys: ['eternl'], label: 'Eternl' },
    { keys: ['vespr'],  label: 'Vespr' },
    { keys: ['typhoncip30', 'typhon'], label: 'Typhon' },
    { keys: ['lace'],   label: 'Lace' },
  ];

  const DELEGATOR_ROLES = [
    { name: '@Delegator',    thresholdAda: 1,     image: null },
    { name: '@PANDA',        thresholdAda: 500,   image: '/images/bears/panda.png' },
    { name: '@BLACK BEAR',   thresholdAda: 1000,  image: '/images/bears/black-bear.png' },
    { name: '@GRIZZLY BEAR', thresholdAda: 2500,  image: '/images/bears/grizzly-bear.png' },
    { name: '@POLAR BEAR',   thresholdAda: 5000,  image: '/images/bears/polar-bear.png' },
    { name: '@CARE BEAR',    thresholdAda: 50000, image: '/images/bears/care-bear.png' },
  ];

  const ACHIEVEMENT_EPOCHS = [10, 50, 100, 250, 500];
  const DEFAULT_ROLE_IMAGE = '/images/preebot.png';

  let currentPrimaryStake = null;
  let lastProfileState = null;

  // ─── Small shared helpers (ported from script.js) ──────────────

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

  function shortenAddress(value, head = 10, tail = 6) {
    const text = String(value || '').trim();
    if (!text) return '—';
    if (text.length <= head + tail + 3) return text;
    return `${text.slice(0, head)}...${text.slice(-tail)}`;
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

  // Minimal bech32 encoder to convert reward address bytes into stake/stake_test.
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

  // Generic address bech32 encoder (payment/base addresses, not just reward
  // addresses) — used to capture a representative payment address for the
  // shared `wallets` map schema, mirroring preebot's existing bot schema.
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

  function parseLovelaceValue(value) {
    if (value == null || value === '') return 0;
    if (typeof value === 'bigint') return Number(value);
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) return 0;
      if (/^\d+$/.test(trimmed)) return Number(trimmed);
      const numeric = Number(trimmed);
      return Number.isFinite(numeric) ? numeric : 0;
    }
    return Number(value) || 0;
  }

  function formatAdaExact(lovelace, decimals = 2) {
    return `${(Number(lovelace) / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })} ₳`;
  }

  function isDelegatedToPreeb(delegatedPool) {
    const normalizedPool = String(delegatedPool || '').trim().toLowerCase();
    return normalizedPool === POOL_ID_BECH32.toLowerCase() || normalizedPool === POOL_ID_HEX.toLowerCase();
  }

  function getDelegationStartEpoch(account, stakeHistory) {
    const candidateSources = [
      account?.delegated_since,
      account?.delegated_since_epoch,
    ];
    for (const value of candidateSources) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    const historyEntries = Array.isArray(stakeHistory) ? stakeHistory : [];
    const delegatedPool = String(account?.delegated_pool || '').trim().toLowerCase();
    const matchingEntries = historyEntries.filter((entry) => {
      if (!entry || typeof entry !== 'object') return false;
      const entryPool = String(entry.pool_id_bech32 || entry.pool_id || '').trim().toLowerCase();
      if (!delegatedPool) return true;
      return entryPool === delegatedPool;
    });

    if (matchingEntries.length > 0) {
      const epochs = matchingEntries
        .map((entry) => Number(entry.epoch_no ?? entry.epoch ?? entry.epochNumber ?? NaN))
        .filter((value) => Number.isFinite(value) && value > 0);
      if (epochs.length > 0) return Math.min(...epochs);
    }

    return null;
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

  // ─── Koios fetch helpers ────────────────────────────────────────

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function getKoiosBases() {
    const globalBase = window.PREEB_KOIOS_BASE;
    const bases = [];
    if (typeof globalBase === 'string' && globalBase.trim()) {
      bases.push(globalBase.trim().replace(/\/$/, ''));
    }
    bases.push('/api/koios');
    bases.push(KOIOS_DIRECT_URL);
    return [...new Set(bases)];
  }

  function buildKoiosCandidateUrls(base, path) {
    const directUrl = `${base}${path}`;
    if (!/\/api\/koios\/?$/.test(base)) return [directUrl];

    const parsed = new URL(path, 'https://preeb.local');
    const endpoint = parsed.pathname.replace(/^\//, '');
    const params = new URLSearchParams(parsed.search);
    const queryStyle = new URLSearchParams(params);
    queryStyle.set('endpoint', endpoint);

    return [directUrl, `${base}?${queryStyle.toString()}`];
  }

  async function fetchKoiosJson(path, options = {}) {
    const bases = getKoiosBases();
    let lastError;
    for (const base of bases) {
      const candidates = buildKoiosCandidateUrls(base, path);
      for (const url of candidates) {
        try {
          return await fetchJsonWithTimeout(url, options);
        } catch (err) {
          lastError = err;
        }
      }
    }
    throw lastError || new Error(`All Koios endpoints failed for ${path}`);
  }

  async function loadAccountInfo(stakeAddress) {
    const rows = await fetchKoiosJson('/account_info', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    });
    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  async function loadStakeHistory(stakeAddress) {
    if (!stakeAddress) return [];
    const rows = await fetchKoiosJson('/account_stake_history', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    });
    return Array.isArray(rows) ? rows.filter((entry) => entry && typeof entry === 'object') : [];
  }

  // ─── UI helpers ─────────────────────────────────────────────────

  function setLinkStatus(message, isError = false) {
    const el = document.getElementById('profile-link-status');
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle('is-error', Boolean(isError));
  }

  function getHighestRole(adaDelegatedLovelace) {
    let best = null;
    for (const role of DELEGATOR_ROLES) {
      if (adaDelegatedLovelace >= role.thresholdAda * 1_000_000) best = role;
    }
    return best;
  }

  function renderRolesList(totalAdaDelegated) {
    const list = document.getElementById('profile-roles-list');
    if (!list) return;
    list.innerHTML = '';
    DELEGATOR_ROLES.forEach((role) => {
      const unlocked = totalAdaDelegated >= role.thresholdAda * 1_000_000;
      const needed = Math.max(0, role.thresholdAda * 1_000_000 - totalAdaDelegated);
      const li = document.createElement('li');
      li.className = unlocked ? 'is-unlocked' : 'is-locked';
      li.innerHTML = `<span>${role.name}</span><span>${unlocked ? 'Unlocked' : `${formatAdaExact(needed, 0)} more`}</span>`;
      list.appendChild(li);
    });
  }

  function renderAchievementsList(epochsDelegated) {
    const list = document.getElementById('profile-achievements-list');
    if (!list) return;
    list.innerHTML = '';
    ACHIEVEMENT_EPOCHS.forEach((epochs) => {
      const unlocked = epochsDelegated >= epochs;
      const li = document.createElement('li');
      li.className = unlocked ? 'is-unlocked' : 'is-locked';
      li.innerHTML = `<span>${epochs} Epochs Delegated</span><span>${unlocked ? 'Unlocked' : 'Locked'}</span>`;
      list.appendChild(li);
    });
  }

  function renderWalletsList(wallets, primaryStake) {
    const list = document.getElementById('profile-wallets-list');
    if (!list) return;
    list.innerHTML = '';
    wallets.forEach((w) => {
      const li = document.createElement('li');
      const badge = w === primaryStake ? 'Primary' : 'Linked';
      li.innerHTML = `<span>${shortenAddress(w)}</span><span class="profile-wallets__badge">${badge}</span>`;
      list.appendChild(li);
    });
  }

  function renderProfile(state) {
    const roleImage = state.role?.image || DEFAULT_ROLE_IMAGE;
    const roleName = state.totalAdaDelegated > 0 ? (state.role?.name || '@Delegator') : 'Not Yet Delegated';

    const imgEl = document.getElementById('profile-role-image');
    if (imgEl) imgEl.src = roleImage;

    const handleEl = document.getElementById('profile-handle');
    if (handleEl) handleEl.textContent = shortenAddress(state.primaryStake);

    const addressEl = document.getElementById('profile-address');
    if (addressEl) addressEl.textContent = state.primaryStake;

    const roleNameEl = document.getElementById('profile-role-name');
    if (roleNameEl) roleNameEl.textContent = roleName;

    const adaDelegatedText = formatAdaExact(state.totalAdaDelegated, 2);
    const adaTotalText = formatAdaExact(state.totalAdaAllWallets, 2);

    const adaDelegatedEl = document.getElementById('profile-ada-delegated');
    if (adaDelegatedEl) adaDelegatedEl.textContent = adaDelegatedText;

    const adaTotalEl = document.getElementById('profile-ada-total');
    if (adaTotalEl) adaTotalEl.textContent = adaTotalText;

    const epochsEl = document.getElementById('profile-epochs');
    if (epochsEl) epochsEl.textContent = String(state.epochsDelegated);

    const walletCountEl = document.getElementById('profile-wallet-count');
    if (walletCountEl) walletCountEl.textContent = String(state.wallets.length);

    renderRolesList(state.totalAdaDelegated);
    renderAchievementsList(state.epochsDelegated);
    renderWalletsList(state.wallets, state.primaryStake);

    lastProfileState = {
      ...state,
      roleImage,
      roleName,
      adaDelegatedText,
      adaTotalText,
      shortAddress: shortenAddress(state.primaryStake),
      slug: state.primaryStake,
    };
  }

  async function loadProfile(primaryStake) {
    const loadingEl = document.getElementById('profile-loading');
    const contentEl = document.getElementById('profile-content');
    const emptyEl = document.getElementById('profile-empty');

    if (loadingEl) loadingEl.hidden = false;
    if (contentEl) contentEl.hidden = true;
    if (emptyEl) emptyEl.hidden = true;

    let wallets = [primaryStake];
    try {
      const resp = await fetchJsonWithTimeout(`/api/profile?stake=${encodeURIComponent(primaryStake)}`, {
        headers: { Accept: 'application/json' },
      });
      if (Array.isArray(resp?.wallets) && resp.wallets.length > 0) wallets = resp.wallets;
    } catch (err) {
      console.warn('[PREEB] Could not load linked wallets, showing single wallet only:', getErrorMessage(err));
    }

    const [accounts, histories, tipRows] = await Promise.all([
      Promise.all(wallets.map((w) => loadAccountInfo(w).catch(() => null))),
      Promise.all(wallets.map((w) => loadStakeHistory(w).catch(() => []))),
      fetchKoiosJson('/tip', { headers: { Accept: 'application/json' } }).catch(() => null),
    ]);

    const tip = Array.isArray(tipRows) ? tipRows[0] : tipRows;
    const currentEpoch = Number(tip?.epoch_no ?? tip?.epoch ?? NaN);

    let totalAdaAllWallets = 0;
    let totalAdaDelegated = 0;
    let earliestStartEpoch = null;

    wallets.forEach((stake, idx) => {
      const account = accounts[idx];
      if (!account) return;

      const balance = parseLovelaceValue(
        account.total_balance ?? account.controlled_amount ?? account.balance ?? account.utxo ?? 0
      );
      totalAdaAllWallets += balance;

      if (isDelegatedToPreeb(account.delegated_pool)) {
        totalAdaDelegated += balance;
        const startEpoch = getDelegationStartEpoch(account, histories[idx]);
        if (Number.isFinite(startEpoch) && (earliestStartEpoch == null || startEpoch < earliestStartEpoch)) {
          earliestStartEpoch = startEpoch;
        }
      }
    });

    const epochsDelegated = (earliestStartEpoch != null && Number.isFinite(currentEpoch))
      ? Math.max(1, Math.floor(currentEpoch - earliestStartEpoch + 1))
      : 0;

    renderProfile({
      primaryStake,
      wallets,
      totalAdaAllWallets,
      totalAdaDelegated,
      epochsDelegated,
      role: getHighestRole(totalAdaDelegated),
    });

    if (loadingEl) loadingEl.hidden = true;
    if (contentEl) contentEl.hidden = false;
  }

  // ─── Link another wallet ────────────────────────────────────────

  async function connectAndLinkWallet(walletConfig, primaryStake) {
    setLinkStatus(`Connecting to ${walletConfig.label}...`);
    try {
      const provider = walletConfig.provider || window.cardano?.[walletConfig.key];
      if (!provider) throw new Error(`${walletConfig.label} is not available in this browser`);

      const api = await provider.enable();
      if (typeof api.signData !== 'function') {
        throw new Error(`${walletConfig.label} does not support message signing (signData), required to securely link a wallet`);
      }

      const rewardAddresses = await api.getRewardAddresses();
      if (!Array.isArray(rewardAddresses) || rewardAddresses.length === 0) {
        throw new Error('Connected wallet did not return a reward address');
      }
      const rewardAddressHex = rewardAddresses[0];
      const stakeAddress = rewardHexToStakeBech32(rewardAddressHex);

      if (stakeAddress === primaryStake) {
        throw new Error(`${walletConfig.label} is already this profile's wallet — connect a different wallet to link it.`);
      }

      const paymentAddress = await getRepresentativePaymentAddress(api);

      setLinkStatus('Requesting a signing challenge...');
      const nonceResp = await fetchJsonWithTimeout(
        `/api/profile?stake=${encodeURIComponent(primaryStake)}&nonce=1`,
        { headers: { Accept: 'application/json' } }
      );

      setLinkStatus(`Confirm the signature request in ${walletConfig.label} to prove ownership of ${shortenAddress(stakeAddress)}...`);
      const signResult = await api.signData(rewardAddressHex, textToHex(nonceResp.message));

      setLinkStatus('Verifying and linking wallet...');
      const linkResp = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          primaryStake,
          nonce: nonceResp.nonce,
          signatureHex: signResult.signature,
          keyHex: signResult.key,
          paymentAddress,
        }),
      }).then((r) => r.json());

      if (linkResp.error) throw new Error(linkResp.error);

      setLinkStatus(`Linked ${shortenAddress(linkResp.linkedWallet)} to this profile.`);
      await loadProfile(primaryStake);
    } catch (err) {
      setLinkStatus(getErrorMessage(err), true);
    }
  }

  let linkDetectTimer = null;

  function renderLinkWalletChoices() {
    const choices = document.getElementById('profile-link-choices');
    if (!choices) return false;

    const available = getAvailableWallets();
    if (available.length === 0) {
      setLinkStatus('No supported wallet extension detected yet. If installed, keep this tab open a moment or refresh.', true);
      return false;
    }

    setLinkStatus('Wallet detected. Choose a wallet to link.');
    choices.innerHTML = '';
    available.forEach((walletConfig) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--outline btn--sm';
      btn.textContent = `Link with ${walletConfig.label}`;
      btn.addEventListener('click', () => {
        if (linkDetectTimer) {
          window.clearInterval(linkDetectTimer);
          linkDetectTimer = null;
        }
        connectAndLinkWallet(walletConfig, currentPrimaryStake);
      });
      choices.appendChild(btn);
    });
    choices.hidden = false;
    return true;
  }

  function onLinkWalletClick() {
    if (linkDetectTimer) {
      window.clearInterval(linkDetectTimer);
      linkDetectTimer = null;
    }

    renderLinkWalletChoices();

    // Keep polling for the full window even after some wallets are found —
    // extensions inject at different times, so stopping at the first hit
    // can permanently miss ones that inject a moment later.
    let checkCount = 0;
    const maxChecks = 20;
    linkDetectTimer = window.setInterval(() => {
      checkCount += 1;
      renderLinkWalletChoices();
      if (checkCount >= maxChecks) {
        window.clearInterval(linkDetectTimer);
        linkDetectTimer = null;
      }
    }, 1000);
  }

  // ─── Shareable PNG card ─────────────────────────────────────────

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error(`Could not load image: ${src}`));
      img.src = src;
    });
  }

  async function drawProfileCard(state) {
    const canvas = document.getElementById('profile-canvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;

    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, '#0A0E1A');
    grad.addColorStop(1, '#151C30');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    ctx.fillStyle = 'rgba(60,200,200,0.15)';
    ctx.beginPath();
    ctx.arc(W - 150, 100, 220, 0, Math.PI * 2);
    ctx.fill();

    try {
      const img = await loadImage(state.roleImage);
      const size = 320;
      ctx.drawImage(img, 60, (H - size) / 2, size, size);
    } catch (err) {
      console.warn('[PREEB] Could not draw role image on profile card:', getErrorMessage(err));
    }

    ctx.fillStyle = '#3CC8C8';
    ctx.font = '600 26px "Space Grotesk", sans-serif';
    ctx.fillText('PREEB Delegator Profile', 430, 90);

    ctx.fillStyle = '#E8ECF2';
    ctx.font = '700 46px "Space Grotesk", sans-serif';
    ctx.fillText(state.roleName, 430, 150);

    ctx.fillStyle = '#7F8EA8';
    ctx.font = '400 20px Inter, sans-serif';
    ctx.fillText(state.shortAddress, 430, 185);

    const stats = [
      ['Epochs Delegated to PREEB', String(state.epochsDelegated)],
    ];

    let y = 260;
    stats.forEach(([label, value]) => {
      ctx.fillStyle = '#7F8EA8';
      ctx.font = '400 20px Inter, sans-serif';
      ctx.fillText(label, 430, y);
      ctx.fillStyle = '#E8ECF2';
      ctx.font = '700 54px "Space Grotesk", sans-serif';
      ctx.fillText(value, 430, y + 50);
      y += 130;
    });

    ctx.fillStyle = '#4A5568';
    ctx.font = '400 16px Inter, sans-serif';
    ctx.fillText(`preeb.cloud/profile/${shortenAddress(state.slug, 14, 6)}`, 430, H - 40);

    return canvas;
  }

  async function onDownloadClick() {
    if (!lastProfileState) return;
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const canvas = await drawProfileCard(lastProfileState);
      canvas.toBlob((blob) => {
        if (!blob) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'preeb-profile-card.png';
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }, 'image/png');
    } catch (err) {
      setLinkStatus(`Could not generate profile card: ${getErrorMessage(err)}`, true);
    }
  }

  function onShareClick() {
    if (!lastProfileState) return;
    const text = `I'm ${lastProfileState.roleName} with PREEB Pool! 🐻⚡ #Cardano #PREEBPool`;
    const url = window.location.href;
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
      '_blank',
      'noopener'
    );
  }

  // ─── Ownership verification gate ───────────────────────────────

  function verifiedStorageKey(stake) {
    return `preeb-profile-verified:${stake}`;
  }

  function isOwnershipVerified(stake) {
    try {
      return window.localStorage.getItem(verifiedStorageKey(stake)) === '1';
    } catch {
      return false;
    }
  }

  function markOwnershipVerified(stake) {
    try {
      window.localStorage.setItem(verifiedStorageKey(stake), '1');
    } catch {
      // Ignore storage failures (private browsing, quota, etc.) — the user
      // will just be asked to verify again next visit.
    }
  }

  function setGateStatus(message, isError = false) {
    const el = document.getElementById('profile-gate-status');
    if (!el) return;
    el.hidden = false;
    el.textContent = message;
    el.classList.toggle('is-error', Boolean(isError));
  }

  async function verifyOwnershipWithWallet(walletConfig, primaryStake) {
    setGateStatus(`Connecting to ${walletConfig.label}...`);
    try {
      const provider = walletConfig.provider || window.cardano?.[walletConfig.key];
      if (!provider) throw new Error(`${walletConfig.label} is not available in this browser`);

      const api = await provider.enable();
      if (typeof api.signData !== 'function') {
        throw new Error(`${walletConfig.label} does not support message signing (signData), required to verify ownership`);
      }

      const rewardAddresses = await api.getRewardAddresses();
      if (!Array.isArray(rewardAddresses) || rewardAddresses.length === 0) {
        throw new Error('Connected wallet did not return a reward address');
      }
      const rewardAddressHex = rewardAddresses[0];
      const connectedStake = rewardHexToStakeBech32(rewardAddressHex);

      if (connectedStake !== primaryStake) {
        throw new Error(
          `${walletConfig.label} is connected to a different wallet (${shortenAddress(connectedStake)}) than this profile (${shortenAddress(primaryStake)}). Switch accounts in ${walletConfig.label}, or open the profile for the connected wallet instead.`
        );
      }

      const paymentAddress = await getRepresentativePaymentAddress(api);

      setGateStatus('Requesting a signing challenge...');
      const nonceResp = await fetchJsonWithTimeout(
        `/api/profile?stake=${encodeURIComponent(primaryStake)}&nonce=1`,
        { headers: { Accept: 'application/json' } }
      );

      setGateStatus(`Confirm the signature request in ${walletConfig.label} to prove ownership...`);
      const signResult = await api.signData(rewardAddressHex, textToHex(nonceResp.message));

      setGateStatus('Verifying signature...');
      const verifyResp = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          primaryStake,
          nonce: nonceResp.nonce,
          signatureHex: signResult.signature,
          keyHex: signResult.key,
          paymentAddress,
          purpose: 'verify',
        }),
      }).then((r) => r.json());

      if (verifyResp.error) throw new Error(verifyResp.error);

      markOwnershipVerified(primaryStake);
      showGate(false);
      await loadProfile(primaryStake);
    } catch (err) {
      setGateStatus(getErrorMessage(err), true);
    }
  }

  let gateDetectTimer = null;
  let autoVerifyAttempted = false;

  function getLastUsedWalletKey() {
    try {
      return window.sessionStorage.getItem('preeb-last-wallet-key');
    } catch {
      return null;
    }
  }

  function maybeAutoVerify(primaryStake) {
    if (autoVerifyAttempted) return;

    const lastKey = getLastUsedWalletKey();
    if (!lastKey) return;

    const match = getAvailableWallets().find((w) => w.key === lastKey);
    if (!match) return;

    autoVerifyAttempted = true;
    setGateStatus(`Continuing with ${match.label} (already connected on the main site)...`);
    verifyOwnershipWithWallet(match, primaryStake);
  }

  function renderGateWalletChoices() {
    const choices = document.getElementById('profile-gate-choices');
    if (!choices) return false;

    const available = getAvailableWallets();
    choices.innerHTML = '';

    if (available.length === 0) {
      setGateStatus('No supported wallet extension detected yet. If installed, keep this tab open a moment or refresh.', true);
      return false;
    }

    setGateStatus('Wallet detected. Choose a wallet to verify ownership.');
    available.forEach((walletConfig) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn--outline btn--sm';
      btn.textContent = `Verify with ${walletConfig.label}`;
      btn.addEventListener('click', () => {
        if (gateDetectTimer) {
          window.clearInterval(gateDetectTimer);
          gateDetectTimer = null;
        }
        autoVerifyAttempted = true;
        verifyOwnershipWithWallet(walletConfig, currentPrimaryStake);
      });
      choices.appendChild(btn);
    });
    return true;
  }

  function showGate(show) {
    const gateEl = document.getElementById('profile-gate');
    if (!gateEl) return;
    gateEl.hidden = !show;

    if (gateDetectTimer) {
      window.clearInterval(gateDetectTimer);
      gateDetectTimer = null;
    }

    if (!show) return;

    renderGateWalletChoices();
    maybeAutoVerify(currentPrimaryStake);

    // Wallet extensions can inject into window.cardano a little after page
    // load — keep polling for the full window instead of stopping at the
    // first wallet found, since a different extension (e.g. the one you
    // just used on the main page) may inject a moment later.
    let checkCount = 0;
    const maxChecks = 20;
    gateDetectTimer = window.setInterval(() => {
      checkCount += 1;
      renderGateWalletChoices();
      maybeAutoVerify(currentPrimaryStake);
      if (checkCount >= maxChecks) {
        window.clearInterval(gateDetectTimer);
        gateDetectTimer = null;
      }
    }, 1000);

    window.addEventListener('focus', renderGateWalletChoices);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') renderGateWalletChoices();
    });
  }

  // ─── Init ───────────────────────────────────────────────────────

  function init() {
    const yearEl = document.getElementById('year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    const match = window.location.pathname.match(/\/profile\/([^/]+)/);
    const stake = match ? decodeURIComponent(match[1]) : null;

    if (!stake) {
      const loadingEl = document.getElementById('profile-loading');
      const emptyEl = document.getElementById('profile-empty');
      if (loadingEl) loadingEl.hidden = true;
      if (emptyEl) emptyEl.hidden = false;
      return;
    }

    currentPrimaryStake = stake;

    const linkBtn = document.getElementById('profile-link-wallet-btn');
    const downloadBtn = document.getElementById('profile-download-btn');
    const shareBtn = document.getElementById('profile-share-btn');
    if (linkBtn) linkBtn.addEventListener('click', onLinkWalletClick);
    if (downloadBtn) downloadBtn.addEventListener('click', onDownloadClick);
    if (shareBtn) shareBtn.addEventListener('click', onShareClick);

    if (!isOwnershipVerified(stake)) {
      const loadingEl = document.getElementById('profile-loading');
      if (loadingEl) loadingEl.hidden = true;
      showGate(true);
      return;
    }

    loadProfile(stake).catch((err) => {
      const loadingEl = document.getElementById('profile-loading');
      const emptyEl = document.getElementById('profile-empty');
      if (loadingEl) loadingEl.hidden = true;
      if (emptyEl) {
        emptyEl.hidden = false;
        const p = emptyEl.querySelector('p');
        if (p) p.textContent = `Could not load profile data: ${getErrorMessage(err)}`;
      }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();

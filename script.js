/* ================================================================
   PREEB Pool — Landing Page Script
   Fetches live pool stats from Koios and Discord invite stats.
   ================================================================ */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────
  const POOL_TICKER      = 'PREEB';
  const POOL_ID_BECH32   = 'pool19peeq2czwunkwe3s70yuvwpsrqcyndlqnxvt67usz98px57z7fk';
  const POOL_ID_HEX      = '2873902b027727676630f3c9c63830183049b7e09998bd7b90114e13';
  const KOIOS_DIRECT_URL = 'https://api.koios.rest/api/v1';
  const DISCORD_INVITE   = 'nN5xb7zH7d';
  const TX_METADATA_MESSAGE = 'PREEB thanks you for your delegation.';

  const APY_WINDOWS = {
    epochs3: 3,
    months3: 18,
    months6: 36,
    months12: 73,
  };

  const DELEGATION_CONFIRMATION_POLLS = 24;
  const DELEGATION_CONFIRMATION_INTERVAL_MS = 8000;

  const SUPPORTED_WALLETS = [
    { keys: ['eternl'], label: 'Eternl' },
    { keys: ['vespr'],  label: 'Vespr' },
    { keys: ['typhoncip30', 'typhon'], label: 'Typhon' },
    { keys: ['lace'],   label: 'Lace' },
  ];

  let CSL = null;

  const walletState = {
    walletKey: null,
    walletLabel: null,
    api: null,
    stakeAddress: null,
    rewardAddressHex: null,
    delegatedPool: null,
    delegatedPoolTicker: null,
    delegationVerified: false,
    isSyncing: false,
    accountInfo: null,
    apyWindows: null,
  };

  const poolTickerCache = new Map();

  // ─── Footer year ──────────────────────────────────────────────
  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = new Date().getFullYear();

  // ─── Nav hamburger ────────────────────────────────────────────
  const nav       = document.querySelector('.nav');
  const hamburger = document.querySelector('.nav__hamburger');

  if (hamburger && nav) {
    hamburger.addEventListener('click', () => {
      const open = nav.classList.toggle('nav--open');
      hamburger.setAttribute('aria-expanded', open ? 'true' : 'false');
    });

    // Close when a link is clicked
    nav.querySelectorAll('.nav__links a').forEach(link => {
      link.addEventListener('click', () => {
        nav.classList.remove('nav--open');
        hamburger.setAttribute('aria-expanded', 'false');
      });
    });
  }

  // ─── Helpers ──────────────────────────────────────────────────

  /**
   * Format a lovelace value (1 ADA = 1,000,000 lovelace) into a
   * human-readable ADA string.
   */
  function formatAda(lovelace) {
    const ada = Math.round(Number(lovelace) / 1_000_000);
    if (ada >= 1_000_000) return (ada / 1_000_000).toFixed(2) + 'M ₳';
    if (ada >= 1_000)     return (ada / 1_000).toFixed(1) + 'K ₳';
    return ada + ' ₳';
  }

  /** Format a percentage string (e.g. "0.02") into "2.00%" */
  function formatPercent(raw) {
    return (parseFloat(raw) * 100).toFixed(2) + '%';
  }

  /** Simple number formatter */
  function formatNumber(n) {
    return Number(n).toLocaleString();
  }

  function formatAdaExact(lovelace, decimals = 2) {
    return `${(Number(lovelace) / 1_000_000).toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })} ₳`;
  }

  function formatApyPercent(rawPercent, decimals = 2) {
    if (rawPercent == null || Number.isNaN(Number(rawPercent))) return '—';
    return `${Number(rawPercent).toFixed(decimals)}%`;
  }

  function getErrorMessage(err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    if (err instanceof Error && err.message) return err.message;

    // Many wallet APIs return plain objects like { info, code } on reject.
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

  function bytesToHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function wait(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
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

  /** Build possible Koios base URLs in priority order. */
  function getKoiosBases() {
    const globalBase = window.PREEB_KOIOS_BASE;
    const bases = [];

    if (typeof globalBase === 'string' && globalBase.trim()) {
      bases.push(globalBase.trim().replace(/\/$/, ''));
    }

    // Prefer same-origin proxy when available to avoid browser CORS issues.
    bases.push('/api/koios');
    bases.push(KOIOS_DIRECT_URL);

    return [...new Set(bases)];
  }

  async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} from ${url}`);
      }
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }

  function buildKoiosCandidateUrls(base, path) {
    const directUrl = `${base}${path}`;

    // If the base is not our same-origin proxy, keep direct path behavior only.
    if (!/\/api\/koios\/?$/.test(base)) {
      return [directUrl];
    }

    const parsed = new URL(path, 'https://preeb.local');
    const endpoint = parsed.pathname.replace(/^\//, '');
    const params = new URLSearchParams(parsed.search);

    const queryStyle = new URLSearchParams(params);
    queryStyle.set('endpoint', endpoint);

    return [
      directUrl,
      `${base}?${queryStyle.toString()}`,
    ];
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

    if (lastError && /Failed to fetch/i.test(String(lastError.message || lastError))) {
      throw new Error(
        `Unable to reach Koios endpoint (${path}). ` +
        'If this is deployed, verify /api/koios is working on the same domain.'
      );
    }

    throw lastError || new Error(`All Koios endpoints failed for ${path}`);
  }

  async function loadCardanoSerializationLib() {
    if (CSL) return CSL;

    const candidates = [
      'https://esm.sh/@emurgo/cardano-serialization-lib-asmjs@12.1.1',
      'https://esm.sh/@emurgo/cardano-serialization-lib-asmjs@12.1.1?bundle',
      'https://jspm.dev/@emurgo/cardano-serialization-lib-asmjs',
    ];

    let lastErr;
    for (const url of candidates) {
      try {
        const imported = await import(url);
        const resolved = imported?.default && imported.default.TransactionBuilder
          ? imported.default
          : imported;

        if (
          resolved &&
          resolved.TransactionBuilder &&
          resolved.TransactionBuilderConfigBuilder &&
          resolved.BigNum
        ) {
          CSL = resolved;
          return CSL;
        }

        throw new Error(`Imported CSL module missing required tx builder exports from ${url}`);
      } catch (err) {
        lastErr = err;
      }
    }

    throw new Error(
      `Could not load Cardano serialization library. This is often caused by extension/ad-block/network blocking module CDNs. Last error: ${lastErr?.message || 'unknown error'}`
    );
  }

  /**
   * Build a stat card element and insert it into the grid.
   * Replaces the skeleton placeholders.
   */
  function renderStatCards(cards) {
    const grid = document.getElementById('stats-grid');
    if (!grid) return;

    grid.innerHTML = '';
    cards.forEach(card => {
      const el = document.createElement('div');
      el.className = 'stat-card';
      el.innerHTML = `
        <div class="stat-card__label">${card.label}</div>
        <div class="stat-card__value">${card.value}</div>
        ${card.sub ? `<div class="stat-card__sub">${card.sub}</div>` : ''}
      `;
      grid.appendChild(el);
    });
  }

  /** Show the fallback note when we can't load stats */
  function showStatsFallback() {
    const note = document.getElementById('stats-note');
    if (note) note.hidden = false;

    // Replace loading skeletons with a friendly message
    const grid = document.getElementById('stats-grid');
    if (grid) {
      grid.innerHTML = `
        <div class="stat-card" style="grid-column: 1 / -1; text-align: center; color: var(--color-text-muted); font-size: 0.95rem;">
          Live stats are currently unavailable. Search for <strong style="color:var(--color-text)">PREEB</strong>
          on <a href="https://pool.pm/PREEB" target="_blank" rel="noopener" style="color:var(--color-cyan)">Pool.pm</a>
          or <a href="https://cardanoscan.io/pool/?q=PREEB" target="_blank" rel="noopener" style="color:var(--color-cyan)">Cardanoscan</a>
          for the latest pool information.
        </div>
      `;
    }
  }

  // ─── Pool Stats via Koios ──────────────────────────────────────
  async function loadPoolStats() {
    try {
      // 1) Primary path: detailed data from pool_info.
      const infos = await fetchKoiosJson('/pool_info', {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ _pool_bech32_ids: [POOL_ID_BECH32] }),
      });

      if (!Array.isArray(infos) || infos.length === 0) {
        throw new Error('No pool info returned from Koios');
      }

      const p = infos[0];

      // 3. Update hero ticker bar
      const liveStakeEl  = document.getElementById('pool-live-stake');
      const delegatorsEl = document.getElementById('pool-delegators');
      const marginEl     = document.getElementById('pool-margin');

      if (liveStakeEl && p.live_stake)
        liveStakeEl.textContent  = formatAda(p.live_stake);
      if (delegatorsEl && p.live_delegators != null)
        delegatorsEl.textContent = formatNumber(p.live_delegators);
      if (marginEl && p.margin != null)
        marginEl.textContent     = formatPercent(p.margin);

      // 4. Render stat cards
      const cards = [
        {
          label: 'Ticker',
          value: p.ticker || POOL_TICKER,
          sub:   'Pool identifier',
        },
        {
          label: 'Live Stake',
          value: p.live_stake ? formatAda(p.live_stake) : '—',
          sub:   'Total ADA currently staked',
        },
        {
          label: 'Delegators',
          value: p.live_delegators != null ? formatNumber(p.live_delegators) : '—',
          sub:   'Active delegators',
        },
        {
          label: 'Margin',
          value: p.margin != null ? formatPercent(p.margin) : '—',
          sub:   'Operator fee percentage',
        },
        {
          label: 'Fixed Cost',
          value: p.fixed_cost ? formatAda(p.fixed_cost) : '—',
          sub:   'Minimum fee per epoch',
        },
        {
          label: 'Pledge',
          value: p.pledge ? formatAda(p.pledge) : '—',
          sub:   "Operator's own stake",
        },
      ];

      renderStatCards(cards);

    } catch (err) {
      // 2) Fallback path: pool_list has fewer fields but keeps stats useful.
      try {
        const pools = await fetchKoiosJson(
          `/pool_list?ticker=eq.${encodeURIComponent(POOL_TICKER)}`,
          { headers: { 'Accept': 'application/json' } }
        );

        if (!Array.isArray(pools) || pools.length === 0) {
          throw new Error('Pool list returned no data');
        }

        const p = pools[0];

        const liveStakeEl  = document.getElementById('pool-live-stake');
        const delegatorsEl = document.getElementById('pool-delegators');
        const marginEl     = document.getElementById('pool-margin');

        if (liveStakeEl && p.active_stake) {
          liveStakeEl.textContent = formatAda(p.active_stake);
        }
        if (delegatorsEl) {
          delegatorsEl.textContent = '—';
        }
        if (marginEl && p.margin != null) {
          marginEl.textContent = formatPercent(p.margin);
        }

        const cards = [
          {
            label: 'Ticker',
            value: p.ticker || POOL_TICKER,
            sub:   'Pool identifier',
          },
          {
            label: 'Active Stake',
            value: p.active_stake ? formatAda(p.active_stake) : '—',
            sub:   'Current active ADA stake',
          },
          {
            label: 'Margin',
            value: p.margin != null ? formatPercent(p.margin) : '—',
            sub:   'Operator fee percentage',
          },
          {
            label: 'Fixed Cost',
            value: p.fixed_cost ? formatAda(p.fixed_cost) : '—',
            sub:   'Minimum fee per epoch',
          },
          {
            label: 'Pledge',
            value: p.pledge ? formatAda(p.pledge) : '—',
            sub:   "Operator's own stake",
          },
          {
            label: 'Status',
            value: p.pool_status || '—',
            sub:   'Registration status',
          },
        ];

        renderStatCards(cards);
      } catch (fallbackErr) {
        console.warn('[PREEB] Could not load pool stats:', err.message);
        console.warn('[PREEB] Pool list fallback failed:', fallbackErr.message);
        showStatsFallback();
      }
    }
  }

  // ─── Discord Community Stats ───────────────────────────────────
  async function loadDiscordStats() {
    try {
      // Discord's public invite API — no auth required
      const resp = await fetch(
        `https://discord.com/api/v9/invites/${DISCORD_INVITE}?with_counts=true`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (!resp.ok) throw new Error('Discord invite API failed');

      const data = await resp.json();

      const membersEl = document.getElementById('discord-members');
      const onlineEl  = document.getElementById('discord-online');

      if (membersEl && data.approximate_member_count != null) {
        membersEl.textContent = formatNumber(data.approximate_member_count);
      }

      if (onlineEl && data.approximate_presence_count != null) {
        onlineEl.innerHTML =
          `<span class="online-dot"></span>${formatNumber(data.approximate_presence_count)}`;
      }

    } catch (err) {
      console.warn('[PREEB] Could not load Discord stats:', err.message);
      // Stats remain as "—" — no visible error to the user
    }
  }

  // ─── Wallet + Delegation Helper ───────────────────────────────
  function setWalletStatus(message, isError = false) {
    const statusEl = document.getElementById('wallet-status');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.style.borderColor = isError ? 'rgba(255,120,120,0.45)' : 'rgba(60,200,200,0.28)';
    statusEl.style.background = isError ? 'rgba(255,120,120,0.10)' : 'rgba(60,200,200,0.08)';
  }

  function getAvailableWallets() {
    if (!window.cardano) return [];

    const discovered = [];
    const seenProvider = new Set();

    const addProvider = (key, label, provider) => {
      if (!provider || typeof provider.enable !== 'function') return;
      if (seenProvider.has(provider)) return;
      seenProvider.add(provider);
      discovered.push({ key, label, provider });
    };

    for (const config of SUPPORTED_WALLETS) {
      for (const key of config.keys) {
        const provider = window.cardano[key];
        if (provider && typeof provider.enable === 'function') {
          addProvider(key, config.label, provider);
          break;
        }
      }
    }

    return discovered;
  }

  async function getStakeAddressFromRewardHex(rewardHex) {
    return rewardHexToStakeBech32(rewardHex);
  }

  async function loadAccountInfo(stakeAddress) {
    const rows = await fetchKoiosJson('/account_info', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    });

    return Array.isArray(rows) && rows.length > 0 ? rows[0] : null;
  }

  async function loadPoolTickerByBech32(poolBech32) {
    if (!poolBech32) return null;
    if (poolBech32 === POOL_ID_BECH32) return POOL_TICKER;
    if (poolTickerCache.has(poolBech32)) return poolTickerCache.get(poolBech32);

    let ticker = null;

    // Try pool_info first.
    try {
      const rows = await fetchKoiosJson('/pool_info', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ _pool_bech32_ids: [poolBech32] }),
      });

      ticker = Array.isArray(rows) && rows.length > 0 ? (rows[0].ticker || null) : null;
    } catch {
      ticker = null;
    }

    // Fallback to pool_list filtered by pool id.
    if (!ticker) {
      try {
        const listRows = await fetchKoiosJson(
          `/pool_list?pool_id_bech32=eq.${encodeURIComponent(poolBech32)}`,
          { headers: { Accept: 'application/json' } }
        );
        ticker = Array.isArray(listRows) && listRows.length > 0 ? (listRows[0].ticker || null) : null;
      } catch {
        ticker = null;
      }
    }

    poolTickerCache.set(poolBech32, ticker);
    return ticker;
  }

  function isDelegatedToPreeb(delegatedPool, delegatedTicker) {
    const normalizedPool = String(delegatedPool || '').trim().toLowerCase();
    const normalizedTicker = String(delegatedTicker || '').trim().toUpperCase();

    return (
      normalizedPool === POOL_ID_BECH32.toLowerCase() ||
      normalizedPool === POOL_ID_HEX.toLowerCase() ||
      normalizedTicker === POOL_TICKER
    );
  }

  function setWalletSyncState(isSyncing, message) {
    walletState.isSyncing = isSyncing;

    const syncEl = document.getElementById('wallet-sync');
    const syncMsgEl = document.getElementById('wallet-sync-message');
    const walletEarnedPanel = document.getElementById('wallet-earned-panel');
    const walletGrid = document.getElementById('wallet-grid');
    const walletActions = document.querySelector('.wallet-actions');
    const delegateBtn = document.getElementById('wallet-delegate-btn');

    if (syncMsgEl && message) syncMsgEl.textContent = message;
    if (syncEl) syncEl.hidden = !isSyncing;
    if (walletEarnedPanel) walletEarnedPanel.hidden = isSyncing;
    if (walletGrid && isSyncing) walletGrid.hidden = true;
    if (walletActions) walletActions.hidden = isSyncing;

    if (delegateBtn && isSyncing) {
      delegateBtn.hidden = true;
      delegateBtn.disabled = true;
      delegateBtn.style.display = 'none';
    }
  }

  async function waitForDelegationReflection(previousDelegatedPool, txHash) {
    for (let attempt = 1; attempt <= DELEGATION_CONFIRMATION_POLLS; attempt += 1) {
      setWalletStatus(
        `Tx submitted (${txHash.slice(0, 12)}...). Waiting for on-chain delegation update (${attempt}/${DELEGATION_CONFIRMATION_POLLS})...`
      );

      try {
        const account = await loadAccountInfo(walletState.stakeAddress);
        const delegatedPool = account?.delegated_pool || null;
        const nowDelegatedToPreeb = isDelegatedToPreeb(delegatedPool, null);

        if (nowDelegatedToPreeb) {
          return true;
        }

        if (delegatedPool && delegatedPool !== previousDelegatedPool) {
          walletState.delegatedPool = delegatedPool;
        }
      } catch {
        // Keep polling through transient index/network errors.
      }

      await wait(DELEGATION_CONFIRMATION_INTERVAL_MS);
    }

    return false;
  }

  async function calculatePreebRewards(stakeAddress) {
    const rows = await fetchKoiosJson('/account_rewards', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    });

    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const rewards = Array.isArray(rows[0].rewards) ? rows[0].rewards : [];

    return rewards
      .filter((entry) => entry.pool_id === POOL_ID_BECH32 && entry.type === 'member')
      .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  }

  async function loadPoolApyWindows() {
    if (walletState.apyWindows) return walletState.apyWindows;

    const rows = await fetchKoiosJson('/pool_history', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ _pool_bech32: POOL_ID_BECH32 }),
    });

    const history = Array.isArray(rows) ? rows : [];
    const averageWindow = (count) => {
      const slice = history.slice(0, count);
      if (slice.length === 0) return null;

      // epoch_ros from Koios is already annualized percentage for each epoch.
      const values = slice.map((entry) => Number(entry.epoch_ros || 0));
      return values.reduce((sum, v) => sum + v, 0) / values.length;
    };

    walletState.apyWindows = {
      epochs3: averageWindow(APY_WINDOWS.epochs3),
      months3: averageWindow(APY_WINDOWS.months3),
      months6: averageWindow(APY_WINDOWS.months6),
      months12: averageWindow(APY_WINDOWS.months12),
    };

    return walletState.apyWindows;
  }

  function renderApyWindows(apyWindows) {
    const apy3e = document.getElementById('wallet-apy-3e');
    const apy3m = document.getElementById('wallet-apy-3m');
    const apy6m = document.getElementById('wallet-apy-6m');
    const apy12m = document.getElementById('wallet-apy-12m');

    if (apy3e) apy3e.textContent = formatApyPercent(apyWindows?.epochs3);
    if (apy3m) apy3m.textContent = formatApyPercent(apyWindows?.months3);
    if (apy6m) apy6m.textContent = formatApyPercent(apyWindows?.months6);
    if (apy12m) apy12m.textContent = formatApyPercent(apyWindows?.months12);
  }

  function calculateEstimatedAnnualPreebRewards(account, apyPercent) {
    const delegatedBalance = Number(account?.total_balance || account?.utxo || 0);
    if (!Number.isFinite(delegatedBalance) || delegatedBalance <= 0) return 0;
    if (!Number.isFinite(Number(apyPercent))) return 0;
    return delegatedBalance * (Number(apyPercent) / 100);
  }

  async function loadAccountRewardsForPool(stakeAddress, poolId) {
    const rows = await fetchKoiosJson('/account_rewards', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ _stake_addresses: [stakeAddress] }),
    });

    if (!Array.isArray(rows) || rows.length === 0) return 0;
    const rewards = Array.isArray(rows[0].rewards) ? rows[0].rewards : [];

    return rewards
      .filter((entry) => entry.pool_id === poolId && entry.type === 'member')
      .reduce((sum, entry) => sum + Number(entry.amount || 0), 0);
  }

  function getDelegationStartEpoch(account) {
    const candidates = [
      account?.delegated_since,
      account?.delegated_since_epoch,
      account?.active_epoch_no,
      account?.active_epoch,
      account?.stake_delegation?.active_epoch_no,
    ];

    for (const value of candidates) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }

    return null;
  }

  function formatDelegationDuration(account, currentEpoch) {
    if (!account?.delegated_pool) return 'Not currently delegated';

    const startEpoch = getDelegationStartEpoch(account);
    const epochNow = Number(currentEpoch);

    if (!Number.isFinite(startEpoch) || !Number.isFinite(epochNow) || epochNow < startEpoch) {
      return startEpoch ? `Since epoch ${startEpoch}` : 'Delegated (start epoch unavailable)';
    }

    const epochs = Math.max(1, Math.floor(epochNow - startEpoch + 1));
    const approxDays = epochs * 5;
    const epochLabel = `${epochs} epoch${epochs === 1 ? '' : 's'}`;

    if (approxDays < 30) {
      return `${epochLabel} (~${approxDays} days)`;
    }

    if (approxDays < 365) {
      const months = approxDays / 30.44;
      return `${epochLabel} (~${months.toFixed(1)} months)`;
    }

    const years = approxDays / 365;
    return `${epochLabel} (~${years.toFixed(1)} years)`;
  }

  function formatEpochsStaked(account, currentEpoch) {
    const startEpoch = getDelegationStartEpoch(account);
    const epochNow = Number(currentEpoch);

    if (!account?.delegated_pool) return 'Not currently delegated';
    if (!Number.isFinite(startEpoch) || !Number.isFinite(epochNow) || epochNow < startEpoch) {
      return startEpoch ? `${startEpoch} → ${epochNow}` : 'Epoch data unavailable';
    }

    const epochs = Math.max(1, Math.floor(epochNow - startEpoch + 1));
    return `${epochs} epoch${epochs === 1 ? '' : 's'}`;
  }

  async function refreshWalletState() {
    if (!walletState.stakeAddress) return;

    const [account, apyWindows, tipRows] = await Promise.all([
      loadAccountInfo(walletState.stakeAddress),
      loadPoolApyWindows(),
      fetchKoiosJson('/tip', { headers: { Accept: 'application/json' } }),
    ]);

    const tip = Array.isArray(tipRows) ? tipRows[0] : tipRows;
    const currentEpoch = Number(tip?.epoch_no ?? tip?.epoch ?? NaN);

    walletState.accountInfo = account;
    walletState.delegatedPool = account?.delegated_pool || null;
    walletState.delegationVerified = true;

    if (walletState.delegatedPool) {
      try {
        walletState.delegatedPoolTicker = await loadPoolTickerByBech32(walletState.delegatedPool);
      } catch {
        walletState.delegatedPoolTicker = null;
      }
    } else {
      walletState.delegatedPoolTicker = null;
    }

    renderApyWindows(apyWindows);

    const walletGrid = document.getElementById('wallet-grid');
    const walletEarnedPanel = document.getElementById('wallet-earned-panel');
    const walletName = document.getElementById('wallet-name');
    const walletStake = document.getElementById('wallet-stake');
    const walletDelegatedPool = document.getElementById('wallet-delegated-pool');
    const walletEarnedLabel = document.getElementById('wallet-earned-label');
    const walletEarned = document.getElementById('wallet-earned');
    const walletEpochsStaked = document.getElementById('wallet-epochs-staked');
    const delegateBtn = document.getElementById('wallet-delegate-btn');

    if (walletGrid) walletGrid.hidden = walletState.isSyncing;
    if (walletName) walletName.textContent = walletState.walletLabel || '—';
    if (walletStake) walletStake.textContent = walletState.stakeAddress || '—';
    if (walletDelegatedPool) {
      if (walletState.delegatedPoolTicker) {
        walletDelegatedPool.textContent = walletState.delegatedPoolTicker;
      } else if (walletState.delegatedPool) {
        walletDelegatedPool.textContent = `${walletState.delegatedPool.slice(0, 12)}...`;
      } else {
        walletDelegatedPool.textContent = 'Not delegated';
      }
    }

    const delegatedToPreeb = isDelegatedToPreeb(walletState.delegatedPool, walletState.delegatedPoolTicker);
    const canDelegate = Boolean(
      walletState.api &&
      walletState.stakeAddress &&
      !walletState.isSyncing &&
      !delegatedToPreeb
    );
    if (delegateBtn) {
      delegateBtn.hidden = !canDelegate;
      delegateBtn.disabled = !canDelegate;
      delegateBtn.style.display = canDelegate ? '' : 'none';
    }

    if (walletEarnedLabel) walletEarnedLabel.textContent = 'ADA Already Earned With PREEB';
    if (walletEarned) {
      calculatePreebRewards(walletState.stakeAddress).then((earned) => {
        walletEarned.textContent = formatAdaExact(earned, 2);
      }).catch(() => {
        walletEarned.textContent = 'Unavailable';
      });
    }
    if (walletEpochsStaked) {
      walletEpochsStaked.textContent = formatEpochsStaked(account, currentEpoch);
    }

    if (walletEarnedPanel) walletEarnedPanel.hidden = !delegatedToPreeb;

    if (delegatedToPreeb) {
      setWalletStatus('Wallet connected. You are already delegated to PREEB.');
    } else {
      setWalletStatus('Wallet connected. You can build a delegation transaction to PREEB below.');
    }

    if (delegateBtn && canDelegate) delegateBtn.disabled = false;
  }

  async function connectWallet(walletConfig) {
    try {
      const provider = walletConfig.provider || window.cardano?.[walletConfig.key];
      if (!provider) throw new Error(`${walletConfig.label} is not available in this browser`);

      setWalletStatus(`Connecting to ${walletConfig.label}...`);
      const api = await provider.enable();
      const rewardAddresses = await api.getRewardAddresses();

      if (!Array.isArray(rewardAddresses) || rewardAddresses.length === 0) {
        throw new Error('Connected wallet did not return any reward address');
      }

      walletState.walletKey = walletConfig.key;
      walletState.walletLabel = walletConfig.label;
      walletState.api = api;
      walletState.rewardAddressHex = rewardAddresses[0];
      walletState.stakeAddress = await getStakeAddressFromRewardHex(rewardAddresses[0]);
      walletState.delegationVerified = false;

      setWalletStatus(`Connected to ${walletConfig.label}. Loading delegation data...`);

      try {
        await refreshWalletState();
      } catch (networkErr) {
        const walletGrid = document.getElementById('wallet-grid');
        const walletName = document.getElementById('wallet-name');
        const walletStake = document.getElementById('wallet-stake');
        const walletDelegatedPool = document.getElementById('wallet-delegated-pool');
        const walletEarnedPanel = document.getElementById('wallet-earned-panel');
        const walletEarnedLabel = document.getElementById('wallet-earned-label');
        const walletEarned = document.getElementById('wallet-earned');
        const walletEpochsStaked = document.getElementById('wallet-epochs-staked');
        const delegateBtn = document.getElementById('wallet-delegate-btn');
        renderApyWindows(null);

        if (walletGrid) walletGrid.hidden = false;
        if (walletName) walletName.textContent = walletState.walletLabel || '—';
        if (walletStake) walletStake.textContent = walletState.stakeAddress || '—';
        if (walletDelegatedPool) walletDelegatedPool.textContent = 'Unavailable (network error)';
        if (walletEarnedLabel) walletEarnedLabel.textContent = 'ADA Already Earned With PREEB';
        if (walletEarned) walletEarned.textContent = 'Unavailable (network error)';
        if (walletEpochsStaked) walletEpochsStaked.textContent = 'Unavailable';
        if (walletEarnedPanel) walletEarnedPanel.hidden = true;
        walletState.delegationVerified = false;
        if (delegateBtn) {
          const delegatedToPreeb = isDelegatedToPreeb(walletState.delegatedPool, walletState.delegatedPoolTicker);
          const canDelegate = Boolean(
            walletState.api &&
            walletState.stakeAddress &&
            !delegatedToPreeb
          );
          delegateBtn.hidden = !canDelegate;
          delegateBtn.disabled = !canDelegate;
          delegateBtn.style.display = canDelegate ? '' : 'none';
        }

        setWalletStatus(
          `Wallet connected, but delegation lookup failed: ${networkErr.message}. ` +
          'Ensure /api/koios is reachable on this domain.',
          true
        );
      }
    } catch (err) {
      walletState.delegationVerified = false;
      const message = getErrorMessage(err);
      if (/not implemented/i.test(message)) {
        setWalletStatus(
          `${walletConfig?.label || 'This wallet'} is not fully implemented for CIP-30 delegation in this browser. Use Eternl, Vespr, Typhon, or Lace.`,
          true
        );
      } else {
        setWalletStatus(`Wallet connection failed: ${message}`, true);
      }
      console.warn('[PREEB] Wallet connect failed:', message, err);

      const delegateBtn = document.getElementById('wallet-delegate-btn');
      if (delegateBtn) {
        delegateBtn.hidden = true;
        delegateBtn.disabled = true;
        delegateBtn.style.display = 'none';
      }
    }
  }

  function buildMetadata(csl) {
    const metadata = csl.GeneralTransactionMetadata.new();
    const msgMap = csl.MetadataMap.new();
    const msgList = csl.MetadataList.new();

    msgList.add(csl.TransactionMetadatum.new_text(TX_METADATA_MESSAGE));
    msgMap.insert(
      csl.TransactionMetadatum.new_text('msg'),
      csl.TransactionMetadatum.new_list(msgList)
    );

    metadata.insert(
      csl.BigNum.from_str('674'),
      csl.TransactionMetadatum.new_map(msgMap)
    );

    const aux = csl.AuxiliaryData.new();
    aux.set_metadata(metadata);
    return aux;
  }

  async function buildAndSubmitDelegationTx() {
    if (!walletState.api || !walletState.rewardAddressHex) {
      setWalletStatus('Connect a wallet first to build a delegation transaction.', true);
      return;
    }

    try {
      setWalletStatus('Building delegation transaction...');
      const csl = await loadCardanoSerializationLib();
      const previousDelegatedPool = walletState.delegatedPool;

      const [protocolParamsRaw, tipRows, account] = await Promise.all([
        fetchKoiosJson('/cli_protocol_params', { headers: { Accept: 'application/json' } }),
        fetchKoiosJson('/tip', { headers: { Accept: 'application/json' } }),
        loadAccountInfo(walletState.stakeAddress),
      ]);

      const protocolParams = Array.isArray(protocolParamsRaw) ? protocolParamsRaw[0] : protocolParamsRaw;
      if (!protocolParams || typeof protocolParams !== 'object') {
        throw new Error('Invalid protocol parameters response from Koios');
      }

      const tip = Array.isArray(tipRows) ? tipRows[0] : tipRows;
      if (!tip || tip.abs_slot == null) {
        throw new Error('Could not fetch tip data for tx TTL');
      }

      const readProtocolParam = (...keys) => {
        for (const key of keys) {
          const raw = protocolParams?.[key];
          const value = Number(raw);
          if (Number.isFinite(value) && value > 0) return value;
        }
        return null;
      };

      let cfgBuilder = csl.TransactionBuilderConfigBuilder.new()
        .fee_algo(csl.LinearFee.new(
          csl.BigNum.from_str(String(protocolParams.txFeePerByte)),
          csl.BigNum.from_str(String(protocolParams.txFeeFixed))
        ))
        .pool_deposit(csl.BigNum.from_str(String(protocolParams.stakePoolDeposit)))
        .key_deposit(csl.BigNum.from_str(String(protocolParams.stakeAddressDeposit)))
        .max_tx_size(Number(protocolParams.maxTxSize))
        .max_value_size(Number(protocolParams.maxValueSize));

      const hasUtxoSetter =
        typeof cfgBuilder.coins_per_utxo_byte === 'function' ||
        typeof cfgBuilder.coins_per_utxo_word === 'function';
      if (!hasUtxoSetter) {
        throw new Error('Loaded CSL build does not expose coins_per_utxo setters required for delegation tx.');
      }

      let utxoCostPerByte = readProtocolParam(
        'utxoCostPerByte',
        'coinsPerUtxoByte',
        'coins_per_utxo_byte'
      );
      let utxoCostPerWord = readProtocolParam(
        'utxoCostPerWord',
        'coinsPerUtxoWord',
        'coins_per_utxo_word',
        'lovelacePerUTxOWord'
      );

      // Cross-era compatibility between CSL versions expecting byte vs word pricing.
      if (utxoCostPerByte == null && utxoCostPerWord != null) {
        utxoCostPerByte = Math.ceil(utxoCostPerWord / 8);
      }
      if (utxoCostPerWord == null && utxoCostPerByte != null) {
        utxoCostPerWord = utxoCostPerByte * 8;
      }

      if (utxoCostPerByte == null && utxoCostPerWord == null) {
        // Prevent transaction builder initialization failure in either CSL era.
        utxoCostPerByte = 4310;
        utxoCostPerWord = 34480;
      }

      let utxoCostWasSet = false;
      if (typeof cfgBuilder.coins_per_utxo_byte === 'function' && utxoCostPerByte != null) {
        const next = cfgBuilder.coins_per_utxo_byte(
          csl.BigNum.from_str(String(Math.trunc(utxoCostPerByte)))
        );
        if (next) cfgBuilder = next;
        utxoCostWasSet = true;
      }
      if (typeof cfgBuilder.coins_per_utxo_word === 'function' && utxoCostPerWord != null) {
        const next = cfgBuilder.coins_per_utxo_word(
          csl.BigNum.from_str(String(Math.trunc(utxoCostPerWord)))
        );
        if (next) cfgBuilder = next;
        utxoCostWasSet = true;
      }

      if (!utxoCostWasSet && (cfgBuilder.coins_per_utxo_byte || cfgBuilder.coins_per_utxo_word)) {
        throw new Error('Could not determine coins_per_utxo protocol parameter for this network era.');
      }

      let txConfig;
      try {
        txConfig = cfgBuilder.build();
      } catch (buildErr) {
        const buildMsg = getErrorMessage(buildErr);
        if (!/coins_per_utxo_byte|coins_per_utxo_word/i.test(buildMsg)) {
          throw buildErr;
        }

        // Some CSL builds still report uninitialized UTxO cost despite setter calls above.
        // Retry with explicit default era-compatible values before failing.
        const retryPerByte = Math.trunc(utxoCostPerByte ?? 4310);
        const retryPerWord = Math.trunc(utxoCostPerWord ?? (retryPerByte * 8));

        if (typeof cfgBuilder.coins_per_utxo_byte === 'function') {
          const next = cfgBuilder.coins_per_utxo_byte(csl.BigNum.from_str(String(retryPerByte)));
          if (next) cfgBuilder = next;
        }
        if (typeof cfgBuilder.coins_per_utxo_word === 'function') {
          const next = cfgBuilder.coins_per_utxo_word(csl.BigNum.from_str(String(retryPerWord)));
          if (next) cfgBuilder = next;
        }

        txConfig = cfgBuilder.build();
      }

      const txBuilder = csl.TransactionBuilder.new(txConfig);
      const rewardAddress = csl.RewardAddress.from_address(
        csl.Address.from_bytes(hexToBytes(walletState.rewardAddressHex))
      );

      if (!rewardAddress) throw new Error('Unable to parse wallet reward address');

      const stakeCred = rewardAddress.payment_cred();
      const certs = csl.Certificates.new();

      if (!account || account.status !== 'registered') {
        certs.add(csl.Certificate.new_stake_registration(
          csl.StakeRegistration.new(stakeCred)
        ));
      }

      certs.add(csl.Certificate.new_stake_delegation(
        csl.StakeDelegation.new(
          stakeCred,
          csl.Ed25519KeyHash.from_bytes(hexToBytes(POOL_ID_HEX))
        )
      ));

      txBuilder.set_certs(certs);

      const auxData = buildMetadata(csl);
      if (txBuilder.set_auxiliary_data) {
        txBuilder.set_auxiliary_data(auxData);
      }

      const ttlValue = String(Number(tip.abs_slot) + 3600);
      if (txBuilder.set_ttl_bignum) {
        txBuilder.set_ttl_bignum(csl.BigNum.from_str(ttlValue));
      } else {
        txBuilder.set_ttl(Number(ttlValue));
      }

      const utxosHex = await walletState.api.getUtxos();
      if (!Array.isArray(utxosHex) || utxosHex.length === 0) {
        throw new Error('No spendable UTXOs found in connected wallet');
      }

      const utxos = csl.TransactionUnspentOutputs.new();
      for (const utxoHex of utxosHex) {
        utxos.add(csl.TransactionUnspentOutput.from_bytes(hexToBytes(utxoHex)));
      }

      if (txBuilder.add_inputs_from && csl.CoinSelectionStrategyCIP2) {
        const strategy =
          csl.CoinSelectionStrategyCIP2.RandomImproveMultiAsset ||
          csl.CoinSelectionStrategyCIP2.LargestFirstMultiAsset ||
          csl.CoinSelectionStrategyCIP2.LargestFirst ||
          0;
        txBuilder.add_inputs_from(utxos, strategy);
      } else {
        for (let i = 0; i < utxos.len(); i += 1) {
          const txUtxo = utxos.get(i);
          const output = txUtxo.output();
          txBuilder.add_input(output.address(), txUtxo.input(), output.amount());
        }
      }

      const changeAddressHex = await walletState.api.getChangeAddress();
      const changeAddress = csl.Address.from_bytes(hexToBytes(changeAddressHex));
      txBuilder.add_change_if_needed(changeAddress);

      const txBody = txBuilder.build();
      let tx = csl.Transaction.new(txBody, csl.TransactionWitnessSet.new(), auxData);

      const txHex = bytesToHex(tx.to_bytes());
      setWalletStatus('Requesting wallet signature...');
      const signedWitnessHex = await walletState.api.signTx(txHex, true);
      const witnessSet = csl.TransactionWitnessSet.from_bytes(hexToBytes(signedWitnessHex));

      tx = csl.Transaction.new(tx.body(), witnessSet, tx.auxiliary_data());
      setWalletStatus('Submitting transaction...');
      const txHash = await walletState.api.submitTx(bytesToHex(tx.to_bytes()));
      setWalletSyncState(true, 'Delegation submitted. Waiting for on-chain confirmation...');

      const reflected = await waitForDelegationReflection(previousDelegatedPool, txHash);
      await refreshWalletState();

      if (!reflected) {
        setWalletStatus(
          `Delegation submitted (${txHash.slice(0, 12)}...). Chain index update is delayed; showing latest known data.`
        );
      }
    } catch (err) {
      const message = getErrorMessage(err);
      setWalletStatus(`Delegation transaction failed: ${message}`, true);
      console.warn('[PREEB] Delegation tx failed:', message, err);
    } finally {
      setWalletSyncState(false);
      if (walletState.api && walletState.stakeAddress) {
        try {
          await refreshWalletState();
        } catch {
          // No-op: keep existing UI if post-sync refresh fails.
        }
      }
    }
  }

  function initWalletUi() {
    const buttonsWrap = document.getElementById('wallet-buttons');
    const delegateBtn = document.getElementById('wallet-delegate-btn');

    if (!buttonsWrap || !delegateBtn) return;

    const syncDelegateButton = () => {
      const delegatedToPreeb = isDelegatedToPreeb(walletState.delegatedPool, walletState.delegatedPoolTicker);
      const canDelegate = Boolean(
        walletState.api &&
        walletState.stakeAddress &&
        !walletState.isSyncing &&
        !delegatedToPreeb
      );
      delegateBtn.hidden = !canDelegate;
      delegateBtn.disabled = !canDelegate;
      delegateBtn.style.display = canDelegate ? '' : 'none';
    };

    // Keep tx action hidden until connected and delegation status is verified.
    syncDelegateButton();

    const renderWalletButtons = () => {
      if (walletState.api) {
        syncDelegateButton();
        return true;
      }

      syncDelegateButton();

      const available = getAvailableWallets();
      if (available.length === 0) {
        const onFileProtocol = window.location.protocol === 'file:';
        if (onFileProtocol) {
          setWalletStatus('No wallet detected on file:// origin. Open this site on https:// or localhost for wallet injection.', true);
        } else {
          setWalletStatus('No supported wallet extension detected yet. If installed, keep this tab open a moment or refresh.', true);
        }
        return false;
      }

      setWalletStatus('Wallet detected. Choose a wallet to connect.');
      buttonsWrap.innerHTML = '';
      available.forEach((walletConfig) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn--outline btn--sm';
        btn.textContent = `Connect ${walletConfig.label}`;
        btn.addEventListener('click', () => connectWallet(walletConfig));
        buttonsWrap.appendChild(btn);
      });

      return true;
    };

    renderWalletButtons();

    // Some wallets inject a little after initial page load.
    let checkCount = 0;
    const maxChecks = 20;
    const detectTimer = window.setInterval(() => {
      checkCount += 1;
      const found = renderWalletButtons();
      if (found || checkCount >= maxChecks) {
        window.clearInterval(detectTimer);
      }
    }, 1000);

    window.addEventListener('focus', renderWalletButtons);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') renderWalletButtons();
    });

    delegateBtn.addEventListener('click', buildAndSubmitDelegationTx);
  }

  // ─── Intersection Observer — lazy-load stats ──────────────────
  let statsLoaded   = false;
  let discordLoaded = false;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;

      if (entry.target.id === 'community' && !discordLoaded) {
        discordLoaded = true;
        loadDiscordStats();
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  const statsSection     = document.getElementById('stats');
  const communitySection = document.getElementById('community');

  if (statsSection)     observer.observe(statsSection);
  if (communitySection) observer.observe(communitySection);

  // Load pool stats immediately so hero ticker updates as soon as possible.
  if (!statsLoaded) {
    statsLoaded = true;
    loadPoolStats();
    if (statsSection) observer.unobserve(statsSection);
  }

  initWalletUi();

})();

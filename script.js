/* ================================================================
   PREEB Pool — Landing Page Script
   Fetches live pool stats from Koios and Discord invite stats.
   ================================================================ */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────
  const POOL_TICKER      = 'PREEB';
  const POOL_ID_BECH32   = 'pool19peeq2czwunkwe3s70yuvwpsrqcyndlqnxvt67usz98px57z7fk';
  const KOIOS_DIRECT_URL = 'https://api.koios.rest/api/v1';
  const DISCORD_INVITE   = 'nN5xb7zH7d';

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

  async function fetchKoiosJson(path, options = {}) {
    const bases = getKoiosBases();
    let lastError;

    for (const base of bases) {
      try {
        const url = `${base}${path}`;
        return await fetchJsonWithTimeout(url, options);
      } catch (err) {
        lastError = err;
      }
    }

    throw lastError || new Error('All Koios endpoints failed');
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

})();

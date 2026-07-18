/* ================================================================
   PREEB Pool — Landing Page Script
   Fetches live pool stats from Koios and Discord invite stats.
   ================================================================ */

(function () {
  'use strict';

  // ─── Config ───────────────────────────────────────────────────
  const POOL_TICKER    = 'PREEB';
  const KOIOS_BASE     = 'https://api.koios.rest/api/v1';
  const DISCORD_INVITE = 'nN5xb7zH7d';

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
      // 1. Find the pool by ticker
      const listResp = await fetch(
        `${KOIOS_BASE}/pool_list?ticker=eq.${encodeURIComponent(POOL_TICKER)}`,
        { headers: { 'Accept': 'application/json' } }
      );

      if (!listResp.ok) throw new Error('Pool list request failed');

      const pools = await listResp.json();

      if (!Array.isArray(pools) || pools.length === 0) {
        showStatsFallback();
        return;
      }

      const poolId = pools[0].pool_id_bech32;

      // 2. Get detailed pool info
      const infoResp = await fetch(`${KOIOS_BASE}/pool_info`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ _pool_bech32_ids: [poolId] }),
      });

      if (!infoResp.ok) throw new Error('Pool info request failed');

      const infos = await infoResp.json();
      if (!Array.isArray(infos) || infos.length === 0) {
        showStatsFallback();
        return;
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
      console.warn('[PREEB] Could not load pool stats:', err.message);
      showStatsFallback();
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

      if (entry.target.id === 'stats' && !statsLoaded) {
        statsLoaded = true;
        loadPoolStats();
        observer.unobserve(entry.target);
      }

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

  // Also load immediately if already visible (e.g. user scrolled down)
  if (statsSection) {
    const rect = statsSection.getBoundingClientRect();
    if (rect.top < window.innerHeight) {
      statsLoaded = true;
      loadPoolStats();
      observer.unobserve(statsSection);
    }
  }

})();

/* ================================================================
   PREEB Leaderboard — Page Script
   Renders the /api/leaderboard snapshot as two sortable views:
   By Stake and By Loyalty (epochs delegated).
   ================================================================ */

(function () {
  'use strict';

  const DELEGATOR_ROLES = [
    { name: '@Delegator',    image: null },
    { name: '@PANDA',        image: '/images/bears/panda.png' },
    { name: '@BLACK BEAR',   image: '/images/bears/black-bear.png' },
    { name: '@GRIZZLY BEAR', image: '/images/bears/grizzly-bear.png' },
    { name: '@POLAR BEAR',   image: '/images/bears/polar-bear.png' },
    { name: '@CARE BEAR',    image: '/images/bears/care-bear.png' },
  ];
  const ROLE_IMAGES = new Map(DELEGATOR_ROLES.filter((r) => r.image).map((r) => [r.name, r.image]));

  let boardData = null;
  let currentView = 'stake';

  function shortenAddress(value, head = 12, tail = 6) {
    const text = String(value || '').trim();
    if (text.length <= head + tail + 3) return text;
    return `${text.slice(0, head)}...${text.slice(-tail)}`;
  }

  function formatAda(lovelace, decimals = 0) {
    const ada = Number(lovelace) / 1_000_000;
    if (!Number.isFinite(ada)) return '0 ₳';
    return `${ada.toLocaleString(undefined, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })} ₳`;
  }

  function formatAdaCompact(lovelace) {
    const ada = Number(lovelace) / 1_000_000;
    if (!Number.isFinite(ada)) return '0 ₳';
    if (ada >= 1_000_000) return `${(ada / 1_000_000).toFixed(2)}M ₳`;
    if (ada >= 1_000) return `${(ada / 1_000).toFixed(1)}k ₳`;
    return formatAda(lovelace);
  }

  function sortedEntries() {
    const entries = [...(boardData?.delegators || [])];
    if (currentView === 'loyalty') {
      entries.sort((a, b) => (b.epochsDelegated - a.epochsDelegated) || (BigInt(b.activeStake) > BigInt(a.activeStake) ? 1 : -1));
    } else {
      entries.sort((a, b) => (BigInt(b.activeStake) > BigInt(a.activeStake) ? 1 : -1) || (b.epochsDelegated - a.epochsDelegated));
    }
    return entries;
  }

  function rankClass(rank) {
    if (rank === 1) return 'board-rank board-rank--gold';
    if (rank === 2) return 'board-rank board-rank--silver';
    if (rank === 3) return 'board-rank board-rank--bronze';
    return 'board-rank';
  }

  function epochsBadge(epochs) {
    if (!epochs) return '<span class="board-epochs board-epochs--new">New</span>';
    return `<span class="board-epochs">🏅 ${epochs} epoch${epochs === 1 ? '' : 's'}</span>`;
  }

  function renderRows() {
    const tbody = document.getElementById('board-rows');
    if (!tbody) return;
    tbody.innerHTML = '';

    sortedEntries().forEach((entry, index) => {
      const rank = index + 1;
      const tr = document.createElement('tr');

      const tdRank = document.createElement('td');
      tdRank.innerHTML = `<span class="${rankClass(rank)}">${rank}</span>`;

      const tdWho = document.createElement('td');
      const roleImg = ROLE_IMAGES.get(entry.role);
      const display = entry.handle || shortenAddress(entry.stake);
      tdWho.innerHTML = `
        <div class="board-who">
          ${roleImg ? `<img class="board-who__avatar" src="${roleImg}" alt="" loading="lazy" />` : '<span class="board-who__avatar board-who__avatar--placeholder" aria-hidden="true">🐻</span>'}
          <div class="board-who__names">
            <span class="board-who__name">${escapeText(display)}</span>
            ${entry.handle ? `<span class="board-who__sub">${escapeText(shortenAddress(entry.stake))}</span>` : ''}
          </div>
        </div>`;

      const tdRole = document.createElement('td');
      tdRole.innerHTML = entry.role
        ? `<span class="board-role-pill">${escapeText(entry.role)}</span>`
        : '<span class="board-role-pill board-role-pill--none">—</span>';

      const tdEpochs = document.createElement('td');
      tdEpochs.className = 'board-table__num';
      tdEpochs.innerHTML = epochsBadge(entry.epochsDelegated);

      const tdStake = document.createElement('td');
      tdStake.className = 'board-table__num';
      tdStake.textContent = formatAda(entry.activeStake, 2);

      tr.append(tdRank, tdWho, tdRole, tdEpochs, tdStake);
      tbody.appendChild(tr);
    });
  }

  function escapeText(value) {
    const span = document.createElement('span');
    span.textContent = String(value ?? '');
    return span.innerHTML;
  }

  function renderRoleSummary() {
    const wrap = document.getElementById('board-roles-summary');
    if (!wrap) return;
    const summary = Array.isArray(boardData?.roleSummary) ? boardData.roleSummary : [];
    wrap.innerHTML = '';
    summary.forEach(({ role, count }) => {
      const chip = document.createElement('div');
      chip.className = 'board-role-chip';
      const img = ROLE_IMAGES.get(role);
      chip.innerHTML = `
        ${img ? `<img src="${img}" alt="" loading="lazy" />` : ''}
        <span class="board-role-chip__name">${escapeText(role)}</span>
        <span class="board-role-chip__count">${count}</span>`;
      wrap.appendChild(chip);
    });
    wrap.hidden = summary.length === 0;
  }

  function renderMeta() {
    const meta = document.getElementById('board-meta');
    if (!meta) return;
    const countEl = document.getElementById('board-delegator-count');
    const stakeEl = document.getElementById('board-total-stake');
    const epochEl = document.getElementById('board-epoch');
    if (countEl) countEl.textContent = String(boardData.delegators.length);
    if (stakeEl) stakeEl.textContent = formatAdaCompact(boardData.totalStake);
    if (epochEl) epochEl.textContent = String(boardData.epoch ?? '—');
    meta.hidden = false;

    const updatedEl = document.getElementById('board-updated');
    if (updatedEl && boardData.generatedAt) {
      updatedEl.textContent = `Snapshot from ${new Date(boardData.generatedAt).toLocaleString()} — refreshed hourly`;
    }
  }

  function renderBoard() {
    renderMeta();
    renderRoleSummary();
    renderRows();
  }

  function setView(view) {
    currentView = view === 'loyalty' ? 'loyalty' : 'stake';
    document.querySelectorAll('.board-view-switch__button').forEach((btn) => {
      const active = btn.dataset.view === currentView;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    });
    renderRows();
  }

  async function loadBoard() {
    const loadingEl = document.getElementById('board-loading');
    const errorEl = document.getElementById('board-error');
    const tableWrap = document.getElementById('board-table-wrap');
    try {
      const response = await fetch('/api/leaderboard', { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      boardData = await response.json();
      if (loadingEl) loadingEl.hidden = true;
      if (tableWrap) tableWrap.hidden = false;
      renderBoard();
    } catch (err) {
      console.warn('[PREEB] Leaderboard load failed:', err);
      if (loadingEl) loadingEl.hidden = true;
      if (errorEl) errorEl.hidden = false;
    }
  }

  function init() {
    const yearEl = document.getElementById('year');
    if (yearEl) yearEl.textContent = new Date().getFullYear();

    document.querySelectorAll('.board-view-switch__button').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });

    loadBoard();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

(function () {
  'use strict';

  const API = '/api/claim';
  const path = window.location.pathname.replace(/\/+$/, '');
  const route = path.replace(/^\/claim\/?/, '');

  const els = {
    eyebrow: document.getElementById('claim-eyebrow'),
    title: document.getElementById('claim-title'),
    subtitle: document.getElementById('claim-subtitle'),
    createLink: document.getElementById('claim-create-link'),
    message: document.getElementById('claim-message'),
    listView: document.getElementById('claim-list-view'),
    grid: document.getElementById('claim-grid'),
    empty: document.getElementById('claim-empty'),
    detailView: document.getElementById('claim-detail-view'),
    createView: document.getElementById('claim-create-view'),
  };

  const STATUS_LABELS = { upcoming: 'Upcoming', active: 'Open', closed: 'Closed' };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function showMessage(text, isError = false) {
    els.message.hidden = !text;
    els.message.textContent = text || '';
    els.message.classList.toggle('claim-message--error', isError);
  }

  async function request(url, options = {}) {
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}) },
      ...options,
    });
    let data = null;
    try {
      data = await response.json();
    } catch {
      // Non-JSON error bodies fall through to the generic message below.
    }
    if (!response.ok) throw new Error(data?.error || `Request failed (${response.status})`);
    return data;
  }

  function formatAmount(value, decimals = 0) {
    if (value === null || value === undefined) return '—';
    const big = BigInt(value);
    const unit = 10n ** BigInt(decimals);
    const fraction = (big % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
    return `${(big / unit).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}`;
  }

  function formatDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function shorten(value, head = 10, tail = 8) {
    return value && value.length > head + tail + 3 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value || '';
  }

  // Countdowns -------------------------------------------------------------

  const countdownNodes = new Set();
  let countdownTimer = null;
  let onCountdownDone = null;

  function formatRemaining(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const days = Math.floor(total / 86400);
    const parts = [
      [days, 'd'],
      [Math.floor((total % 86400) / 3600), 'h'],
      [Math.floor((total % 3600) / 60), 'm'],
      [total % 60, 's'],
    ];
    return parts.map(([value, unit], index) => {
      const text = index === 0 ? String(value) : String(value).padStart(2, '0');
      return `<span class="claim-countdown__unit"><b>${text}</b>${unit}</span>`;
    }).join('');
  }

  function updateCountdown(node) {
    const remaining = new Date(node.dataset.countdown).getTime() - Date.now();
    node.innerHTML = formatRemaining(remaining);
    return remaining <= 0;
  }

  function tickCountdowns() {
    let finished = false;
    countdownNodes.forEach((node) => {
      if (!node.isConnected) {
        countdownNodes.delete(node);
        return;
      }
      if (updateCountdown(node)) finished = true;
    });
    if (finished && onCountdownDone) {
      const callback = onCountdownDone;
      onCountdownDone = null;
      setTimeout(callback, 3000);
    }
  }

  function countdownLabel(campaign) {
    if (campaign.status === 'upcoming') {
      return campaign.snapshot.status === 'taken' ? 'Claims open in' : 'Snapshot in';
    }
    return 'Closes in';
  }

  function createCountdown(campaign) {
    if (!campaign.countdownTo || campaign.status === 'closed') return null;
    const wrap = el('div', 'claim-countdown');
    wrap.appendChild(el('span', 'claim-countdown__label', countdownLabel(campaign)));
    const timer = el('span', 'claim-countdown__timer');
    timer.dataset.countdown = campaign.countdownTo;
    wrap.appendChild(timer);
    countdownNodes.add(timer);
    updateCountdown(timer);
    if (!countdownTimer) countdownTimer = setInterval(tickCountdowns, 1000);
    return wrap;
  }

  // Shared pieces ----------------------------------------------------------

  function createImage(campaign, className) {
    const frame = el('div', className);
    if (campaign.imageUrl) {
      const image = document.createElement('img');
      image.src = campaign.imageUrl;
      image.alt = '';
      image.loading = 'lazy';
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove());
      frame.appendChild(image);
    }
    frame.appendChild(el('span', 'claim-image__fallback', (campaign.tokenY.ticker || '?').slice(0, 4)));
    return frame;
  }

  function createStatusChip(campaign) {
    const chip = el('span', `claim-chip claim-chip--${campaign.status}`, STATUS_LABELS[campaign.status]);
    if (campaign.status === 'upcoming' && campaign.snapshot.status === 'failed') {
      chip.textContent = 'Snapshot delayed';
    }
    return chip;
  }

  function describeDistribution(campaign) {
    const { mode, amountPerHolder, totalAmount } = campaign.distribution;
    const decimals = campaign.tokenY.decimals;
    const ticker = campaign.tokenY.ticker;
    if (mode === 'fixed') return `${formatAmount(amountPerHolder, decimals)} ${ticker} each`;
    if (mode === 'proportional') return `${formatAmount(totalAmount, decimals)} ${ticker} split by balance`;
    return 'Custom amount per holder';
  }

  // List -------------------------------------------------------------------

  function renderCard(campaign) {
    const card = el('a', `claim-card claim-card--${campaign.status}`);
    card.href = `/claim/${campaign.id}`;
    card.appendChild(createImage(campaign, 'claim-card__image claim-image'));

    const body = el('div', 'claim-card__body');
    const top = el('div', 'claim-card__top');
    top.appendChild(createStatusChip(campaign));
    top.appendChild(el('span', 'claim-card__ticker', campaign.tokenY.ticker));
    body.appendChild(top);
    body.appendChild(el('h3', 'claim-card__title', campaign.title));
    body.appendChild(el('p', 'claim-card__meta', describeDistribution(campaign)));

    const countdown = createCountdown(campaign);
    if (countdown) {
      body.appendChild(countdown);
    } else if (campaign.status === 'closed') {
      body.appendChild(el('p', 'claim-card__meta', `Closed ${formatDate(campaign.claimEndsAt)}`));
    } else if (campaign.snapshot.eligibleCount !== null) {
      body.appendChild(el('p', 'claim-card__meta', `${campaign.snapshot.eligibleCount} eligible wallets`));
    }
    card.appendChild(body);
    return card;
  }

  async function showList() {
    els.listView.hidden = false;
    onCountdownDone = showList;
    try {
      const { campaigns } = await request(`${API}/campaigns`);
      const rank = { active: 0, upcoming: 1, closed: 2 };
      campaigns.sort((a, b) => rank[a.status] - rank[b.status]);
      els.grid.replaceChildren(...campaigns.map(renderCard));
      els.empty.hidden = campaigns.length > 0;
      showMessage('');
    } catch (error) {
      showMessage(error.message, true);
    }
  }

  // Detail -----------------------------------------------------------------

  function fact(label, value) {
    const item = el('div', 'claim-fact');
    item.appendChild(el('dt', null, label));
    const dd = el('dd');
    if (value instanceof Node) dd.appendChild(value);
    else dd.textContent = value;
    item.appendChild(dd);
    return item;
  }

  function copyButton(value, label) {
    const button = el('button', 'btn btn--outline btn--sm', label);
    button.type = 'button';
    button.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(value);
        button.textContent = 'Copied';
      } catch {
        button.textContent = 'Copy failed';
      }
      setTimeout(() => { button.textContent = label; }, 1800);
    });
    return button;
  }

  function renderDetail(campaign) {
    document.title = `${campaign.title} · PREEB Claims`;
    els.eyebrow.textContent = 'Claim campaign';
    els.title.textContent = campaign.title;
    els.subtitle.textContent = campaign.description || '';
    els.createLink.hidden = true;

    const wrap = el('article', `claim-detail claim-detail--${campaign.status}`);

    const head = el('div', 'claim-detail__head');
    head.appendChild(createImage(campaign, 'claim-detail__image claim-image'));
    const headText = el('div', 'claim-detail__headtext');
    const chips = el('div', 'claim-card__top');
    chips.appendChild(createStatusChip(campaign));
    chips.appendChild(el('span', 'claim-card__ticker', campaign.tokenY.ticker));
    headText.appendChild(chips);
    const countdown = createCountdown(campaign);
    if (countdown) headText.appendChild(countdown);
    else if (campaign.status === 'closed') {
      headText.appendChild(el('p', 'claim-card__meta', campaign.claimEndsAt
        ? `This campaign closed on ${formatDate(campaign.claimEndsAt)}.`
        : 'This campaign is closed.'));
    }
    headText.appendChild(copyButton(window.location.href, 'Copy share link'));
    head.appendChild(headText);
    wrap.appendChild(head);

    const eligible = campaign.stats.eligible;
    const claimed = campaign.stats.claimed;
    if (eligible > 0) {
      const progress = el('div', 'claim-progress');
      const bar = el('div', 'claim-progress__bar');
      const fill = el('div', 'claim-progress__fill');
      fill.style.width = `${Math.min(100, Math.round((claimed / eligible) * 100))}%`;
      bar.appendChild(fill);
      progress.appendChild(bar);
      progress.appendChild(el('p', 'claim-card__meta', `${claimed} of ${eligible} wallets have claimed`));
      wrap.appendChild(progress);
    }

    const facts = el('dl', 'claim-facts');
    const snapshotWhen = campaign.snapshot.takenAt || campaign.snapshot.scheduledFor;
    facts.appendChild(fact('Token', `${campaign.tokenY.ticker} · ${shorten(campaign.tokenY.policyId)}`));
    facts.appendChild(fact('Each wallet gets', describeDistribution(campaign)));
    facts.appendChild(fact('Eligible wallets', campaign.snapshot.eligibleCount === null ? 'After the snapshot' : String(campaign.snapshot.eligibleCount)));
    facts.appendChild(fact('Total to distribute', campaign.snapshot.totalAmount === null
      ? '—'
      : `${formatAmount(campaign.snapshot.totalAmount, campaign.tokenY.decimals)} ${campaign.tokenY.ticker}`));
    facts.appendChild(fact(
      campaign.snapshot.status === 'taken' ? 'Snapshot taken' : 'Snapshot scheduled',
      formatDate(snapshotWhen),
    ));
    facts.appendChild(fact('Eligible holders', campaign.snapshot.source === 'json'
      ? 'Uploaded list'
      : `Holders of ${shorten(campaign.tokenX.policyId)}${campaign.tokenX.assetNameHex ? ' (one asset)' : ''}`));
    facts.appendChild(fact('Claims open', campaign.claimStartsAt ? formatDate(campaign.claimStartsAt) : 'After the snapshot'));
    facts.appendChild(fact('Claims close', campaign.claimEndsAt ? formatDate(campaign.claimEndsAt) : 'No end date'));
    facts.appendChild(fact('Created by', shorten(campaign.owner, 12, 8)));
    facts.appendChild(fact('Campaign wallet', shorten(campaign.walletAddress, 14, 10)));
    wrap.appendChild(facts);

    if (campaign.snapshot.status === 'failed') {
      wrap.appendChild(el('p', 'claim-message claim-message--error', `The snapshot could not be taken: ${campaign.snapshot.error || 'unknown error'}`));
    }

    const claimPanel = el('div', 'claim-panel');
    claimPanel.appendChild(el('h3', null, 'Claiming'));
    claimPanel.appendChild(el('p', null, campaign.status === 'closed'
      ? 'Claims for this campaign are closed. The details above stay available for reference.'
      : 'Claim transactions are not live yet. Check back soon.'));
    wrap.appendChild(claimPanel);

    if (campaign.viewerIsOwner && campaign.status !== 'closed') {
      const ownerPanel = el('div', 'claim-panel claim-panel--owner');
      ownerPanel.appendChild(el('h3', null, 'Owner'));
      ownerPanel.appendChild(el('p', null, 'Do not send tokens or ADA to the campaign wallet yet. Funding checks and the reclaim option are still being built.'));
      ownerPanel.appendChild(copyButton(campaign.walletAddress, 'Copy campaign wallet address'));
      wrap.appendChild(ownerPanel);
    }

    els.detailView.replaceChildren(wrap);
    els.detailView.hidden = false;
  }

  async function showDetail(id) {
    try {
      const { campaign } = await request(`${API}/${encodeURIComponent(id)}`);
      countdownNodes.clear();
      renderDetail(campaign);
      onCountdownDone = () => showDetail(id);
      showMessage('');
    } catch (error) {
      els.createLink.textContent = 'All campaigns';
      els.createLink.href = '/claim';
      showMessage(error.message, true);
    }
  }

  // Create -----------------------------------------------------------------

  const form = els.createView;
  const field = (id) => document.getElementById(id);
  const create = { owner: null, images: [], verified: [] };

  function textToHex(value, isHex) {
    const trimmed = value.trim();
    if (isHex) return trimmed.toLowerCase();
    return Array.from(new TextEncoder().encode(trimmed), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function setFormError(text) {
    const node = field('form-error');
    node.hidden = !text;
    node.textContent = text || '';
  }

  function addImageChoices(urls) {
    for (const url of urls) {
      if (!/^(https:\/\/|ipfs:\/\/)/.test(url) || create.images.includes(url)) continue;
      create.images.push(url);
    }
    renderImageChoices();
  }

  function previewUrl(url) {
    return url.startsWith('ipfs://') ? `https://ipfs.io/ipfs/${url.slice(7)}` : url;
  }

  function renderImageChoices() {
    const container = field('image-choices');
    container.replaceChildren();
    create.images.forEach((url, index) => {
      const label = el('label', 'claim-images__choice');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'image-choice';
      input.value = url;
      input.checked = index === 0 && !field('image-url').value;
      const image = document.createElement('img');
      image.src = previewUrl(url);
      image.alt = 'Token artwork';
      image.referrerPolicy = 'no-referrer';
      label.append(input, image);
      container.appendChild(label);
    });
  }

  async function lookupToken(prefix, fillDetails) {
    setFormError('');
    const policy = field(`${prefix}-policy`).value.trim().toLowerCase();
    const assetName = textToHex(field(`${prefix}-name`).value, field(`${prefix}-name-hex`).checked);
    if (!/^[0-9a-f]{56}$/.test(policy)) {
      setFormError('Enter a valid 56-character policy ID first.');
      return;
    }
    try {
      const info = await request(`${API}/token-info?policyId=${policy}&assetName=${assetName}`);
      if (fillDetails) {
        field('y-ticker').value = info.ticker || field('y-ticker').value;
        field('y-decimals').value = String(info.decimals ?? 0);
      }
      addImageChoices(info.images || []);
      if (!info.images?.length) setFormError('Token found, but it has no artwork. You can paste an image URL instead.');
    } catch (error) {
      setFormError(error.message);
    }
  }

  async function connectWallet(walletConfig) {
    const status = field('claim-wallet-status');
    const nav = window.PreebNavigation;
    try {
      status.textContent = `Connecting ${walletConfig.label}…`;
      const api = await walletConfig.provider.enable();
      const [rewardHex] = await api.getRewardAddresses();
      const stake = nav.rewardHexToStakeAddress(rewardHex);
      const payoutAddress = nav.addressHexToBech32(await api.getChangeAddress());

      if (!create.verified.includes(stake)) {
        create.owner = null;
        status.replaceChildren(
          document.createTextNode('This wallet is not verified in this browser yet. '),
          Object.assign(el('a', null, 'Verify it on your profile'), { href: `/profile/${encodeURIComponent(stake)}` }),
          document.createTextNode(', then come back.'),
        );
        return;
      }
      create.owner = { stake, payoutAddress };
      status.textContent = `Connected ${walletConfig.label}: ${shorten(stake, 12, 8)}. Unclaimed funds can only be reclaimed to ${shorten(payoutAddress, 12, 8)}.`;
    } catch (error) {
      create.owner = null;
      status.textContent = error?.message || 'Could not connect the wallet.';
    }
  }

  function syncFormMode() {
    const source = form.querySelector('input[name="source"]:checked').value;
    field('source-koios').hidden = source !== 'koios';
    field('source-json').hidden = source !== 'json';

    const modeSelect = field('distribution-mode');
    const manual = modeSelect.value === 'manual';
    field('distribution-amount').hidden = manual;
    field('distribution-amount-label').hidden = manual;
    field('distribution-amount-label').textContent = modeSelect.value === 'proportional'
      ? 'Total amount to split'
      : 'Amount per holder';
  }

  function readDate(id) {
    const value = field(id).value;
    return value ? new Date(value).toISOString() : null;
  }

  function buildPayload() {
    const source = form.querySelector('input[name="source"]:checked').value;
    const mode = field('distribution-mode').value;
    const imageUrl = field('image-url').value.trim()
      || form.querySelector('input[name="image-choice"]:checked')?.value
      || '';

    const payload = {
      ownerStake: create.owner.stake,
      payoutAddress: create.owner.payoutAddress,
      title: field('f-title').value,
      description: field('f-description').value,
      tokenY: {
        policyId: field('y-policy').value,
        assetNameHex: textToHex(field('y-name').value, field('y-name-hex').checked),
        decimals: Number(field('y-decimals').value || 0),
        ticker: field('y-ticker').value,
      },
      distribution: { mode },
      snapshot: { source, at: readDate('snapshot-at') },
      filters: {
        minBalance: field('min-balance').value,
        excludeScripts: field('exclude-scripts').checked,
        exclude: field('exclude-list').value.split(/\s*\n\s*/).filter(Boolean),
      },
      claimStartsAt: readDate('claim-start'),
      claimEndsAt: readDate('claim-end'),
      image: imageUrl ? { url: imageUrl } : null,
    };

    if (mode === 'fixed') payload.distribution.amountPerHolder = field('distribution-amount').value;
    if (mode === 'proportional') payload.distribution.totalAmount = field('distribution-amount').value;
    if (source === 'koios') {
      payload.tokenX = {
        policyId: field('x-policy').value,
        assetNameHex: textToHex(field('x-name').value, field('x-name-hex').checked),
      };
    } else {
      payload.snapshot.holders = field('holder-json').value;
    }
    return payload;
  }

  async function onSubmit(event) {
    event.preventDefault();
    setFormError('');
    if (!create.owner) {
      setFormError('Connect a verified wallet first.');
      return;
    }

    const submit = field('form-submit');
    submit.disabled = true;
    submit.textContent = 'Creating…';
    try {
      const { campaign } = await request(`${API}/campaigns`, { method: 'POST', body: JSON.stringify(buildPayload()) });
      window.location.href = `/claim/${campaign.id}`;
    } catch (error) {
      setFormError(error.message);
      submit.disabled = false;
      submit.textContent = 'Create campaign';
    }
  }

  async function showCreate() {
    els.eyebrow.textContent = 'New campaign';
    els.title.textContent = 'Create a claim campaign';
    els.subtitle.textContent = 'Anyone can create one. Campaigns are public and listed on the claim page.';
    els.createLink.textContent = 'All campaigns';
    els.createLink.href = '/claim';
    form.hidden = false;

    try {
      const session = await request('/api/auth/session');
      create.verified = session.verifiedWallets || [];
    } catch {
      create.verified = [];
    }

    const buttons = field('claim-wallet-buttons');
    const wallets = window.PreebNavigation?.getAvailableWallets() || [];
    if (!wallets.length) {
      field('claim-wallet-status').textContent = 'No Cardano wallet extension detected in this browser.';
    }
    wallets.forEach((walletConfig) => {
      const button = el('button', 'btn btn--outline btn--sm', `Connect ${walletConfig.label}`);
      button.type = 'button';
      button.addEventListener('click', () => connectWallet(walletConfig));
      buttons.appendChild(button);
    });

    form.querySelectorAll('input[name="source"]').forEach((input) => input.addEventListener('change', () => {
      if (input.value === 'koios' && input.checked && field('distribution-mode').value === 'manual') {
        field('distribution-mode').value = 'fixed';
      }
      syncFormMode();
    }));
    field('distribution-mode').addEventListener('change', () => {
      if (field('distribution-mode').value === 'manual') {
        form.querySelector('input[name="source"][value="json"]').checked = true;
      }
      syncFormMode();
    });
    field('y-lookup').addEventListener('click', () => lookupToken('y', true));
    field('x-lookup').addEventListener('click', () => lookupToken('x', false));
    field('image-url').addEventListener('input', () => {
      if (field('image-url').value) form.querySelectorAll('input[name="image-choice"]').forEach((input) => { input.checked = false; });
    });
    field('holder-file').addEventListener('change', async (event) => {
      const [file] = event.target.files;
      if (file) field('holder-json').value = await file.text();
    });
    form.addEventListener('submit', onSubmit);
    syncFormMode();
  }

  // Boot -------------------------------------------------------------------

  if (route === '') {
    showList();
  } else if (route === 'new') {
    showCreate();
  } else if (/^[a-z0-9]{10}$/.test(route)) {
    showDetail(route);
  } else {
    showMessage('Campaign not found.', true);
  }
})();

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
  const SETUP_LABELS = { 'awaiting-funding': 'Awaiting funding', 'ready-to-prepare': 'Setting up', preparing: 'Setting up' };
  const SETUP_POLL_MS = 30_000;

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
    if (!response.ok) {
      const error = new Error(data?.error || `Something went wrong (HTTP ${response.status}). Please try again.`);
      error.field = data?.field || null;
      throw error;
    }
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

  // Tries each source in turn (IPFS gateways go down), removing the image if none load.
  function attachImage(image, sources) {
    let index = 0;
    image.referrerPolicy = 'no-referrer';
    image.addEventListener('error', () => {
      index += 1;
      if (index < sources.length) image.src = sources[index];
      else image.remove();
    });
    image.src = sources[0];
  }

  function createImage(campaign, className) {
    const frame = el('div', className);
    if (campaign.imageSources?.length) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      attachImage(image, campaign.imageSources);
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
    if (campaign.status === 'active' && SETUP_LABELS[campaign.phase]) {
      chip.textContent = SETUP_LABELS[campaign.phase];
      chip.className = 'claim-chip claim-chip--setup';
    }
    return chip;
  }

  function describeDistribution(campaign) {
    const { mode, amountPerHolder, totalAmount } = campaign.distribution;
    const decimals = campaign.tokenY.decimals;
    const ticker = campaign.tokenY.ticker;
    if (mode === 'fixed') return `${formatAmount(amountPerHolder, decimals)} ${ticker} each`;
    if (mode === 'proportional') return `${formatAmount(totalAmount, decimals)} ${ticker}, split by holdings`;
    return 'Custom amount per holder';
  }

  function describeShare(campaign) {
    const { mode, amountPerHolder } = campaign.distribution;
    if (mode === 'fixed') return `${formatAmount(amountPerHolder, campaign.tokenY.decimals)} ${campaign.tokenY.ticker} each`;
    if (mode === 'proportional') return 'Proportional to holdings';
    return 'Set individually for each wallet';
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

  // A fact's value with optional link and copy chip, e.g. a name plus a button that copies its ID.
  function factValue(text, { copy = null, copyLabel = 'Copy', href = null } = {}) {
    const wrap = el('span', 'claim-fact__value');
    wrap.appendChild(el('span', 'claim-fact__text', text));
    if (href) {
      const link = el('a', 'claim-fact__link', href.replace(/^https:\/\//, '').replace(/\/$/, ''));
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      wrap.appendChild(link);
    }
    if (copy) wrap.appendChild(copyButton(copy, copyLabel, 'claim-copy'));
    return wrap;
  }

  function copyButton(value, label, className = 'btn btn--outline btn--sm') {
    const button = el('button', className, label);
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

  function formatTokens(campaign, value) {
    return `${formatAmount(value, campaign.tokenY.decimals)} ${campaign.tokenY.ticker}`;
  }

  function fundingLine(campaign) {
    const funding = campaign.funding;
    if (!funding) return 'Checking the campaign wallet…';
    return `${formatTokens(campaign, funding.tokensHeld)} of ${formatTokens(campaign, funding.tokensRequired)}`
      + ` and ${formatAmount(funding.lovelaceHeld, 6)} of ${formatAmount(funding.lovelaceRequired, 6)} ADA`;
  }

  async function prepareCampaign(campaign, button) {
    button.disabled = true;
    button.textContent = 'Preparing…';
    try {
      await request(`${API}/${campaign.id}/prepare`, { method: 'POST' });
      await showDetail(campaign.id);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Prepare claims';
      showMessage(error.message, true);
    }
  }

  async function retrySnapshotRequest(campaign, button) {
    button.disabled = true;
    button.textContent = 'Retrying…';
    try {
      await request(`${API}/${campaign.id}/snapshot`, { method: 'POST' });
      await showDetail(campaign.id);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Retry snapshot';
      showMessage(error.message, true);
    }
  }

  function renderPanels(wrap, campaign) {
    const panel = el('div', 'claim-panel');
    panel.appendChild(el('h3', null, 'Claiming'));
    const message = el('p');
    panel.appendChild(message);

    if (campaign.status === 'closed') {
      message.textContent = 'Claims for this campaign are closed. The details above stay available for reference.';
    } else if (campaign.snapshot.status === 'failed') {
      message.textContent = 'The snapshot could not be completed, so claims stay closed until it succeeds.';
    } else if (campaign.status === 'upcoming') {
      message.textContent = 'Claims open after the snapshot is taken.';
    } else if (campaign.phase === 'awaiting-funding') {
      message.textContent = `Waiting for the organizer to fund this campaign. Wallet holds ${fundingLine(campaign)}.`;
    } else if (campaign.phase === 'ready-to-prepare') {
      message.textContent = 'Funded. The organizer needs to prepare claims before they open.';
    } else if (campaign.phase === 'preparing') {
      message.textContent = 'Preparing claims on chain. This usually takes a minute or two.';
    } else {
      message.textContent = 'Funded and ready. Claim transactions are not live yet. Check back soon.';
    }
    wrap.appendChild(panel);

    if (!campaign.viewerIsOwner || campaign.status === 'closed') return;

    const owner = el('div', 'claim-panel claim-panel--owner');
    owner.appendChild(el('h3', null, 'Owner'));
    if (campaign.snapshot.status === 'failed') {
      owner.appendChild(el('p', null, `The snapshot failed: ${campaign.snapshot.error || 'unknown error'}. It was retried automatically; you can run it again now.`));
      const retry = el('button', 'btn btn--primary', 'Retry snapshot');
      retry.type = 'button';
      retry.addEventListener('click', () => retrySnapshotRequest(campaign, retry));
      owner.appendChild(retry);
      wrap.appendChild(owner);
      return;
    }
    if (campaign.snapshot.status === 'taken' && campaign.phase !== 'claiming' && campaign.phase !== 'preparing') {
      owner.appendChild(el('p', null, `Send ${formatTokens(campaign, campaign.funding?.tokensRequired ?? campaign.snapshot.totalAmount)} `
        + `and at least ${formatAmount(campaign.funding?.lovelaceRequired ?? 0, 6)} ADA to the campaign wallet. `
        + 'The ADA is a deposit for the claim lanes and comes back to you when you reclaim.'));
      const address = el('code', 'claim-address', campaign.walletAddress);
      owner.appendChild(address);
      owner.appendChild(copyButton(campaign.walletAddress, 'Copy wallet address'));
      owner.appendChild(el('p', null, `Currently held: ${fundingLine(campaign)}.`));
    }
    if (campaign.phase === 'ready-to-prepare') {
      const button = el('button', 'btn btn--primary', 'Prepare claims');
      button.type = 'button';
      button.addEventListener('click', () => prepareCampaign(campaign, button));
      owner.appendChild(button);
    }
    owner.appendChild(el('p', 'claim-warning', 'Reclaiming leftover funds is not available yet. Only fund a campaign you are ready to run.'));
    wrap.appendChild(owner);
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
    const ticker = campaign.tokenY.ticker;
    const tokenName = campaign.tokenY.name || ticker;
    facts.appendChild(fact('Token', factValue(tokenName, {
      copy: campaign.tokenY.policyId,
      copyLabel: 'Copy policy ID',
      href: campaign.tokenY.website,
    })));
    facts.appendChild(fact('Each wallet gets', describeShare(campaign)));

    const totalToShare = campaign.distribution.mode === 'proportional'
      ? campaign.distribution.totalAmount
      : campaign.snapshot.totalAmount;
    if (totalToShare !== null && totalToShare !== undefined) {
      facts.appendChild(fact('Total to distribute', `${formatAmount(totalToShare, campaign.tokenY.decimals)} ${ticker}`));
    }
    if (campaign.snapshot.eligibleCount !== null) {
      facts.appendChild(fact('Eligible wallets', String(campaign.snapshot.eligibleCount)));
    }

    if (campaign.tokenX) {
      const holderName = campaign.tokenX.name || campaign.tokenX.ticker || 'the holder token';
      facts.appendChild(fact('Eligible holders', factValue(`Holders of ${holderName}`, {
        copy: campaign.tokenX.policyId,
        copyLabel: 'Copy policy ID',
        href: campaign.tokenX.website,
      })));
      if (campaign.filters.minBalance && campaign.filters.minBalance !== '0') {
        facts.appendChild(fact('Minimum holding', `${formatAmount(campaign.filters.minBalance, campaign.tokenX.decimals || 0)} ${campaign.tokenX.ticker || holderName}`));
      }
    } else {
      facts.appendChild(fact('Eligible holders', 'Uploaded list'));
    }

    facts.appendChild(fact(
      campaign.snapshot.status === 'taken' ? 'Snapshot taken' : 'Snapshot scheduled',
      formatDate(campaign.snapshot.takenAt || campaign.snapshot.scheduledFor),
    ));
    facts.appendChild(fact('Claims open', campaign.claimStartsAt ? formatDate(campaign.claimStartsAt) : 'After the snapshot'));
    facts.appendChild(fact('Claims close', campaign.claimEndsAt ? formatDate(campaign.claimEndsAt) : 'No end date'));
    facts.appendChild(fact('Created by', factValue(campaign.ownerHandle || shorten(campaign.owner, 12, 8), {
      copy: campaign.owner,
      copyLabel: 'Copy stake address',
    })));
    facts.appendChild(fact('Campaign wallet', factValue(shorten(campaign.walletAddress, 12, 8), {
      copy: campaign.walletAddress,
      copyLabel: 'Copy address',
    })));
    wrap.appendChild(facts);

    if (campaign.snapshot.status === 'failed') {
      wrap.appendChild(el('p', 'claim-message claim-message--error', `The snapshot could not be taken: ${campaign.snapshot.error || 'unknown error'}`));
    }

    renderPanels(wrap, campaign);

    els.detailView.replaceChildren(wrap);
    els.detailView.hidden = false;
  }

  let detailPoll = null;

  async function showDetail(id) {
    clearTimeout(detailPoll);
    try {
      const { campaign } = await request(`${API}/${encodeURIComponent(id)}`);
      countdownNodes.clear();
      renderDetail(campaign);
      onCountdownDone = () => showDetail(id);
      if (campaign.status === 'active' && campaign.phase !== 'claiming') {
        detailPoll = setTimeout(() => showDetail(id), SETUP_POLL_MS);
      }
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
  const create = { owner: null, images: [], verified: [], token: null, holder: null, chosenAsset: null, submitting: false };
  const FIELD_ALIASES = { wallet: 'claim-wallet-status', source: 'source-koios' };

  const stripCommas = (value) => value.replace(/,/g, '');

  // Adds thousands separators while typing, keeping the caret next to the same digit.
  function formatNumberInput(input, allowDecimal) {
    const caret = input.selectionStart ?? input.value.length;
    const significantBefore = input.value.slice(0, caret).replace(/[^0-9.]/g, '').length;

    let cleaned = input.value.replace(/[^0-9.]/g, '');
    if (!allowDecimal) cleaned = cleaned.replace(/\./g, '');
    const dot = cleaned.indexOf('.');
    if (dot >= 0) cleaned = cleaned.slice(0, dot + 1) + cleaned.slice(dot + 1).replace(/\./g, '');

    const [whole, fraction] = cleaned.split('.');
    const grouped = whole.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const formatted = fraction === undefined ? grouped : `${grouped || '0'}.${fraction}`;
    input.value = formatted;

    let position = 0;
    let seen = 0;
    while (position < formatted.length && seen < significantBefore) {
      if (/[0-9.]/.test(formatted[position])) seen += 1;
      position += 1;
    }
    input.setSelectionRange(position, position);
  }

  function clearFieldErrors() {
    form.querySelectorAll('.is-invalid').forEach((node) => {
      node.classList.remove('is-invalid');
      node.removeAttribute('aria-invalid');
    });
  }

  // One banner for every outcome; errors also highlight and focus the offending field.
  function showFormStatus(kind, message, fieldId = null) {
    const banner = field('form-status');
    clearFieldErrors();
    banner.hidden = !message;
    banner.textContent = message || '';
    banner.classList.toggle('claim-message--error', kind === 'error');
    banner.classList.toggle('claim-message--success', kind === 'success');
    if (!message) return;

    const target = fieldId ? field(FIELD_ALIASES[fieldId] || fieldId) : null;
    if (kind === 'error' && target) {
      target.classList.add('is-invalid');
      target.setAttribute('aria-invalid', 'true');
      if (typeof target.focus === 'function' && target.tagName !== 'P') target.focus({ preventScroll: true });
    }
    (target || banner).scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function setSubmitting(active) {
    create.submitting = active;
    const submit = field('form-submit');
    submit.disabled = active;
    submit.textContent = active ? 'Creating campaign…' : 'Create campaign';
    form.setAttribute('aria-busy', String(active));
  }

  function previewSources(image) {
    return image.sources?.length ? image.sources : [image.ref];
  }

  function addImageChoices(images) {
    for (const image of images) {
      if (!create.images.some((existing) => existing.ref === image.ref)) create.images.push(image);
    }
    renderImageChoices();
  }

  const IMAGE_SOURCE_LABELS = { cip68: 'On-chain (CIP-68)', cip25: 'Mint metadata (CIP-25)', registry: 'Token registry' };

  function renderImageChoices() {
    const container = field('image-choices');
    container.replaceChildren();
    create.images.forEach((choice, index) => {
      const label = el('label', 'claim-images__choice');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'image-choice';
      input.value = choice.ref;
      input.checked = index === 0 && !field('image-url').value;
      const image = document.createElement('img');
      image.alt = 'Token artwork';
      attachImage(image, previewSources(choice));
      label.append(input, image, el('span', 'claim-help', IMAGE_SOURCE_LABELS[choice.source] || 'Image'));
      container.appendChild(label);
    });
  }

  function renderTokenDetails(boxId, token) {
    const box = field(boxId);
    box.hidden = !token;
    box.replaceChildren();
    if (!token) return;

    const title = token.name || token.ticker || 'Unnamed token';
    box.appendChild(el('strong', null, token.ticker && token.ticker !== title ? `${title} (${token.ticker})` : title));
    if (token.website) {
      const link = el('a', 'claim-token__link', token.website.replace(/^https:\/\//, '').replace(/\/$/, ''));
      link.href = token.website;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      box.appendChild(link);
    }
  }

  function showAssetChoice(info) {
    const select = field('y-asset');
    select.replaceChildren(el('option', null, 'Choose a token…'));
    select.firstChild.value = '';
    for (const asset of info.assets) {
      const option = el('option', null, asset.name || `0x${asset.assetNameHex}`);
      option.value = asset.assetNameHex;
      select.appendChild(option);
    }
    field('y-asset-choice').hidden = false;
    renderTokenDetails('y-details', null);
    if (info.tooMany) showFormStatus('error', 'That policy has too many tokens to list. Use a policy that holds the single token you are giving away.', 'y-policy');
  }

  async function lookupGiveaway() {
    const policy = field('y-policy').value.trim().toLowerCase();
    create.token = null;
    if (!/^[0-9a-f]{56}$/.test(policy)) {
      renderTokenDetails('y-details', null);
      field('y-asset-choice').hidden = true;
      return;
    }
    const assetName = create.chosenAsset;
    try {
      const info = await request(`${API}/token-info?policyId=${policy}${assetName !== null ? `&assetName=${assetName}` : ''}`);
      if (field('y-policy').value.trim().toLowerCase() !== policy) return;
      if (info.needsChoice) {
        showAssetChoice(info);
        return;
      }
      field('y-asset-choice').hidden = assetName === null;
      create.token = info;
      renderTokenDetails('y-details', info);
      addImageChoices(info.images || []);
      showFormStatus(null, '');
    } catch (error) {
      renderTokenDetails('y-details', null);
      showFormStatus('error', error.message, 'y-policy');
    }
  }

  async function lookupHolders() {
    const policy = field('x-policy').value.trim().toLowerCase();
    create.holder = null;
    if (!/^[0-9a-f]{56}$/.test(policy)) {
      renderTokenDetails('x-details', null);
      return;
    }
    try {
      const info = await request(`${API}/holder-token?policyId=${policy}`);
      if (field('x-policy').value.trim().toLowerCase() !== policy) return;
      create.holder = info;
      renderTokenDetails('x-details', info);
      addImageChoices(info.images || []);
      const unit = info.ticker || info.name;
      field('min-balance-label').textContent = unit ? `Minimum balance to qualify (${unit})` : 'Minimum balance to qualify';
      showFormStatus(null, '');
    } catch (error) {
      renderTokenDetails('x-details', null);
      showFormStatus('error', error.message, 'x-policy');
    }
  }

  function debounce(callback, wait) {
    let timer = null;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => callback(...args), wait);
    };
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
      status.classList.remove('is-invalid');
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
        ...(create.chosenAsset !== null ? { assetNameHex: create.chosenAsset } : {}),
      },
      distribution: { mode },
      snapshot: { source, at: readDate('snapshot-at') },
      filters: {
        minBalance: stripCommas(field('min-balance').value),
        excludeScripts: field('exclude-scripts').checked,
        exclude: field('exclude-list').value.split(/\s*\n\s*/).filter(Boolean),
      },
      claimStartsAt: readDate('claim-start'),
      claimEndsAt: readDate('claim-end'),
      image: imageUrl ? { url: imageUrl } : null,
    };

    if (mode === 'fixed') payload.distribution.amountPerHolder = stripCommas(field('distribution-amount').value);
    if (mode === 'proportional') payload.distribution.totalAmount = stripCommas(field('distribution-amount').value);
    if (source === 'koios') {
      payload.tokenX = { policyId: field('x-policy').value };
    } else {
      payload.snapshot.holders = field('holder-json').value;
    }
    return payload;
  }

  // Catches the obvious mistakes before a request is made; the server re-checks everything.
  function validateForm() {
    if (!create.owner) {
      return { message: 'Connect a wallet that is verified on your profile first.', field: 'wallet' };
    }
    if (field('f-title').value.trim().length < 3) {
      return { message: 'Give the campaign a title (at least 3 characters).', field: 'f-title' };
    }
    if (!/^[0-9a-fA-F]{56}$/.test(field('y-policy').value.trim())) {
      return { message: 'Enter the 56-character policy ID of the token you are giving away.', field: 'y-policy' };
    }
    if (!field('y-asset-choice').hidden && create.chosenAsset === null) {
      return { message: 'This policy holds several tokens. Choose which one to give away.', field: 'y-asset' };
    }
    if (!create.token) {
      return { message: 'Wait for the token to load, or check that the policy ID is right.', field: 'y-policy' };
    }

    const source = form.querySelector('input[name="source"]:checked').value;
    if (source === 'koios' && !/^[0-9a-fA-F]{56}$/.test(field('x-policy').value.trim())) {
      return { message: 'Enter the 56-character policy ID of the token whose holders can claim.', field: 'x-policy' };
    }
    if (source === 'koios' && !create.holder) {
      return { message: 'Wait for the holder token to load, or check that its policy ID is right.', field: 'x-policy' };
    }
    if (source === 'json' && !field('holder-json').value.trim()) {
      return { message: 'Upload or paste the list of eligible holders.', field: 'holder-json' };
    }

    const mode = field('distribution-mode').value;
    if (mode !== 'manual' && !(Number(stripCommas(field('distribution-amount').value)) > 0)) {
      return { message: mode === 'proportional' ? 'Enter the total amount to split between holders.' : 'Enter how much each holder can claim.', field: 'distribution-amount' };
    }

    const MINUTE = 60_000;
    const snapshotAt = field('snapshot-at').value ? new Date(field('snapshot-at').value) : new Date();
    const start = field('claim-start').value ? new Date(field('claim-start').value) : null;
    const end = field('claim-end').value ? new Date(field('claim-end').value) : null;
    const earliestStart = new Date(Math.max(snapshotAt.getTime(), Date.now()) + 15 * MINUTE);
    const when = (date) => date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

    if (start && start.getTime() < earliestStart.getTime() - MINUTE) {
      return {
        message: `Claims must open at least 15 minutes after the snapshot. The earliest is ${when(earliestStart)}, or leave it empty to use that.`,
        field: 'claim-start',
      };
    }
    const opensAt = start && start > earliestStart ? start : earliestStart;
    if (end && end.getTime() < opensAt.getTime() + 24 * 60 * MINUTE - MINUTE) {
      return {
        message: `Claims must stay open for at least 24 hours. With claims opening ${when(opensAt)}, the earliest close is ${when(new Date(opensAt.getTime() + 24 * 60 * MINUTE))}.`,
        field: 'claim-end',
      };
    }
    return null;
  }

  async function onSubmit(event) {
    event.preventDefault();
    if (create.submitting) return;

    const problem = validateForm();
    if (problem) {
      showFormStatus('error', problem.message, problem.field);
      return;
    }

    setSubmitting(true);
    showFormStatus('info', 'Creating your campaign and reading the token from the chain…');
    try {
      const { campaign, snapshot } = await request(`${API}/campaigns`, { method: 'POST', body: JSON.stringify(buildPayload()) });
      const note = snapshot?.error ? ` The snapshot is not finished yet (${snapshot.error}); it will retry automatically.` : '';
      showFormStatus('success', `Campaign created.${note} Taking you to its page…`);
      setTimeout(() => { window.location.href = `/claim/${campaign.id}`; }, note ? 2500 : 900);
    } catch (error) {
      const network = error instanceof TypeError;
      showFormStatus(
        'error',
        network ? 'Could not reach the server. Check your connection and try again. Nothing was created.' : `${error.message} Nothing was created.`,
        error.field,
      );
      setSubmitting(false);
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

    const lookupGiveawayLater = debounce(() => {
      create.chosenAsset = null;
      field('y-asset-choice').hidden = true;
      lookupGiveaway();
    }, 500);
    field('y-policy').addEventListener('input', lookupGiveawayLater);
    field('y-asset').addEventListener('change', () => {
      create.chosenAsset = field('y-asset').value === '' ? null : field('y-asset').value;
      if (create.chosenAsset !== null) lookupGiveaway();
    });
    field('x-policy').addEventListener('input', debounce(lookupHolders, 500));
    field('min-balance').addEventListener('input', () => formatNumberInput(field('min-balance'), true));
    field('distribution-amount').addEventListener('input', () => formatNumberInput(field('distribution-amount'), true));
    field('image-url').addEventListener('input', () => {
      if (field('image-url').value) form.querySelectorAll('input[name="image-choice"]').forEach((input) => { input.checked = false; });
    });
    field('holder-file').addEventListener('change', async (event) => {
      const [file] = event.target.files;
      if (file) field('holder-json').value = await file.text();
    });
    form.addEventListener('input', (event) => {
      event.target.classList?.remove('is-invalid');
      event.target.removeAttribute?.('aria-invalid');
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

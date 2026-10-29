(function () {
  'use strict';

  const SUPPORTED_WALLETS = [
    { keys: ['eternl'], label: 'Eternl' },
    { keys: ['vespr'], label: 'Vespr' },
    { keys: ['typhoncip30', 'typhon'], label: 'Typhon' },
    { keys: ['lace'], label: 'Lace' },
  ];

  function getAvailableWallets() {
    if (!window.cardano) return [];

    const discovered = [];
    const seenProviders = new Set();
    for (const config of SUPPORTED_WALLETS) {
      for (const key of config.keys) {
        const provider = window.cardano[key];
        if (provider && typeof provider.enable === 'function' && !seenProviders.has(provider)) {
          seenProviders.add(provider);
          discovered.push({ key, label: config.label, provider });
          break;
        }
      }
    }
    return discovered;
  }

  function hexToBytes(hex) {
    if (!hex || typeof hex !== 'string') return new Uint8Array();
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  }

  function bech32Polymod(values) {
    const generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let checksum = 1;
    for (const value of values) {
      const top = checksum >>> 25;
      checksum = ((checksum & 0x1ffffff) << 5) ^ value;
      for (let i = 0; i < 5; i += 1) {
        if ((top >>> i) & 1) checksum ^= generators[i];
      }
    }
    return checksum;
  }

  function convertBits(data, fromBits, toBits) {
    let accumulator = 0;
    let bitCount = 0;
    const converted = [];
    const maxValue = (1 << toBits) - 1;
    for (const value of data) {
      if (value < 0 || value >> fromBits) return null;
      accumulator = (accumulator << fromBits) | value;
      bitCount += fromBits;
      while (bitCount >= toBits) {
        bitCount -= toBits;
        converted.push((accumulator >> bitCount) & maxValue);
      }
    }
    if (bitCount > 0) converted.push((accumulator << (toBits - bitCount)) & maxValue);
    return converted;
  }

  function bech32Encode(hrp, bytes) {
    const data = convertBits(bytes, 8, 5);
    if (!data) throw new Error('Could not read the address returned by the wallet');

    const charset = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    const expandedHrp = [];
    for (let i = 0; i < hrp.length; i += 1) expandedHrp.push(hrp.charCodeAt(i) >> 5);
    expandedHrp.push(0);
    for (let i = 0; i < hrp.length; i += 1) expandedHrp.push(hrp.charCodeAt(i) & 31);

    const values = expandedHrp.concat(data, [0, 0, 0, 0, 0, 0]);
    const checksumValue = bech32Polymod(values) ^ 1;
    const checksum = [];
    for (let i = 0; i < 6; i += 1) {
      checksum.push((checksumValue >> (5 * (5 - i))) & 31);
    }
    return `${hrp}1${data.concat(checksum).map((value) => charset[value]).join('')}`;
  }

  function rewardHexToStakeAddress(rewardHex) {
    const bytes = hexToBytes(rewardHex);
    if (!bytes.length) throw new Error('Connected wallet returned an empty reward address');
    return bech32Encode((bytes[0] & 0x0f) === 1 ? 'stake' : 'stake_test', bytes);
  }

  function addressHexToBech32(addressHex) {
    const bytes = hexToBytes(addressHex);
    if (!bytes.length) throw new Error('Connected wallet returned an empty address');
    return bech32Encode((bytes[0] & 0x0f) === 1 ? 'addr' : 'addr_test', bytes);
  }

  async function connectAndOpenProfile(walletConfig, setStatus) {
    setStatus(`Connecting to ${walletConfig.label}...`);
    try {
      const api = await walletConfig.provider.enable();
      const rewardAddresses = await api.getRewardAddresses();
      if (!Array.isArray(rewardAddresses) || rewardAddresses.length === 0) {
        throw new Error('Connected wallet did not return a reward address');
      }

      const stakeAddress = rewardHexToStakeAddress(rewardAddresses[0]);
      try {
        window.sessionStorage.setItem('preeb-last-wallet-key', walletConfig.key);
      } catch {
        // Session storage is optional; profile navigation still works without it.
      }
      rememberWallet(walletConfig.key);
      window.location.href = `/profile/${encodeURIComponent(stakeAddress)}`;
    } catch (error) {
      setStatus(error?.message || String(error), true);
    }
  }

  function renderProfileChoices(container, statusElement, labelPrefix = 'Connect') {
    if (!container) return false;

    const setStatus = (message, isError = false) => {
      if (!statusElement) return;
      statusElement.hidden = false;
      statusElement.textContent = message;
      statusElement.classList.toggle('is-error', isError);
    };

    const wallets = getAvailableWallets();
    container.innerHTML = '';
    if (wallets.length === 0) {
      setStatus('No supported wallet extension detected. Install Eternl, Vespr, Typhon, or Lace.', true);
      return false;
    }

    statusElement && (statusElement.hidden = true);
    wallets.forEach((walletConfig) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn--outline btn--sm';
      button.textContent = `${labelPrefix} ${walletConfig.label}`;
      button.addEventListener('click', () => connectAndOpenProfile(walletConfig, setStatus));
      container.appendChild(button);
    });
    return true;
  }

  // Connected wallet shown in the header ---------------------------------------

  const WALLET_STORAGE_KEY = 'preeb-nav-wallet';
  const walletState = { wallet: null, api: null };

  function shorten(value, head = 9, tail = 6) {
    return value && value.length > head + tail + 1 ? `${value.slice(0, head)}…${value.slice(-tail)}` : value || '';
  }

  function emitWalletChange() {
    window.dispatchEvent(new CustomEvent('preeb:wallet', { detail: walletState.wallet }));
  }

  function rememberWallet(key) {
    try {
      if (key) window.localStorage.setItem(WALLET_STORAGE_KEY, key);
      else window.localStorage.removeItem(WALLET_STORAGE_KEY);
    } catch {
      // Storage can be unavailable (private mode); the wallet just will not be remembered.
    }
  }

  function rememberedWalletKey() {
    try {
      return window.localStorage.getItem(WALLET_STORAGE_KEY) || window.sessionStorage.getItem('preeb-last-wallet-key');
    } catch {
      return null;
    }
  }

  async function readWalletDetails(walletConfig, api) {
    const rewardAddresses = await api.getRewardAddresses();
    if (!Array.isArray(rewardAddresses) || rewardAddresses.length === 0) {
      throw new Error('The wallet did not return a stake address.');
    }
    let address = '';
    try {
      address = addressHexToBech32(await api.getChangeAddress());
    } catch {
      // The stake address alone is enough to identify the wallet.
    }
    return {
      key: walletConfig.key,
      label: walletConfig.label,
      stake: rewardHexToStakeAddress(rewardAddresses[0]),
      address,
    };
  }

  async function connectWallet(walletConfig) {
    const api = await walletConfig.provider.enable();
    walletState.wallet = await readWalletDetails(walletConfig, api);
    walletState.api = api;
    rememberWallet(walletConfig.key);
    emitWalletChange();

    // Switching accounts inside the wallet should switch the site too, without a reload.
    try {
      api.experimental?.on?.('accountChange', async () => {
        try {
          walletState.wallet = await readWalletDetails(walletConfig, api);
          emitWalletChange();
        } catch {
          disconnectWallet();
        }
      });
    } catch {
      // Not every wallet exposes this event.
    }
    return walletState.wallet;
  }

  function disconnectWallet() {
    walletState.wallet = null;
    walletState.api = null;
    rememberWallet(null);
    try {
      window.sessionStorage.removeItem('preeb-last-wallet-key');
    } catch {
      // Nothing to clear.
    }
    emitWalletChange();
  }

  // Wallet extensions inject themselves after the page loads, so wait briefly for them.
  async function restoreWallet() {
    const key = rememberedWalletKey();
    if (!key) return;

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const walletConfig = getAvailableWallets().find((candidate) => candidate.key === key);
      if (walletConfig) {
        try {
          // Only reconnect silently when the wallet already trusts this site.
          if (typeof walletConfig.provider.isEnabled === 'function' && await walletConfig.provider.isEnabled()) {
            await connectWallet(walletConfig);
          }
        } catch {
          // A failed silent reconnect leaves the "Connect wallet" button.
        }
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }

  const mount = document.querySelector('[data-site-navigation]');
  if (!mount) return;

  const path = window.location.pathname.replace(/\/index\.html$/, '/') || '/';
  const isHome = path === '/';
  const isCurrent = (href) => {
    if (href === '/') return isHome;
    return path === href || path.startsWith(`${href}/`) || path === `${href}.html`;
  };

  mount.outerHTML = `
    <nav class="nav" id="top">
      <div class="nav__inner container">
        <a href="/" class="nav__logo">
          <span class="logo-ticker">PREEB</span>
          <span class="logo-sub">A Cardano Stake Pool</span>
        </a>
        <ul class="nav__links" id="primary-navigation">
          <li><a href="/"${isCurrent('/') ? ' aria-current="page"' : ''}>Home</a></li>
          <li><a href="/airdrop"${isCurrent('/airdrop') ? ' aria-current="page"' : ''}>Airdrop</a></li>
          <li><a href="/claim"${isCurrent('/claim') ? ' aria-current="page"' : ''}>Claim</a></li>
          <li><a href="/leaderboard"${isCurrent('/leaderboard') ? ' aria-current="page"' : ''}>Leaderboard</a></li>
          <li><a href="/wall"${isCurrent('/wall') ? ' aria-current="page"' : ''}>Guest Wall</a></li>
          <li class="nav__profile-item">
            <button type="button" class="nav-wallet" id="nav-wallet-btn" aria-haspopup="true">Connect wallet</button>
            <div class="nav-profile-menu" id="nav-wallet-menu" hidden></div>
          </li>
          <li class="nav__profile-item">
            <button type="button" class="btn btn--outline btn--sm" id="nav-profile-btn">My Profile</button>
            <div class="nav-profile-menu" id="nav-profile-menu" hidden></div>
          </li>
          <li><a href="/#wallet" class="btn btn--outline btn--sm">Delegate</a></li>
        </ul>
        <button class="nav__hamburger" aria-label="Toggle menu" aria-controls="primary-navigation" aria-expanded="false">
          <span></span><span></span><span></span>
        </button>
      </div>
    </nav>`;

  const nav = document.querySelector('.nav');
  const hamburger = nav?.querySelector('.nav__hamburger');
  const links = nav?.querySelector('.nav__links');
  const profileButton = nav?.querySelector('#nav-profile-btn');

  if (!nav || !hamburger || !links) return;

  function setOpen(open) {
    nav.classList.toggle('nav--open', open);
    hamburger.setAttribute('aria-expanded', String(open));
  }

  const walletButton = nav.querySelector('#nav-wallet-btn');
  const walletMenu = nav.querySelector('#nav-wallet-menu');

  function makeButton(text, onClick, className = 'btn btn--outline btn--sm') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.textContent = text;
    button.addEventListener('click', onClick);
    return button;
  }

  function copyRow(label, value) {
    const row = document.createElement('div');
    row.className = 'nav-wallet-row';
    const text = document.createElement('span');
    text.innerHTML = `<small>${label}</small><code></code>`;
    text.querySelector('code').textContent = shorten(value, 14, 8);
    row.appendChild(text);
    const copy = makeButton('Copy', async () => {
      try {
        await navigator.clipboard.writeText(value);
        copy.textContent = 'Copied';
      } catch {
        copy.textContent = 'Failed';
      }
      setTimeout(() => { copy.textContent = 'Copy'; }, 1500);
    }, 'nav-wallet-copy');
    row.appendChild(copy);
    return row;
  }

  function renderWalletButton() {
    const wallet = walletState.wallet;
    walletButton.classList.toggle('nav-wallet--connected', Boolean(wallet));
    walletButton.replaceChildren();
    if (!wallet) {
      walletButton.textContent = 'Connect wallet';
      return;
    }
    const name = document.createElement('span');
    name.className = 'nav-wallet__name';
    name.textContent = wallet.label;
    const id = document.createElement('span');
    id.className = 'nav-wallet__id';
    id.textContent = shorten(wallet.stake, 10, 6);
    walletButton.append(name, id);
    walletButton.title = `${wallet.label} · ${wallet.stake}`;
  }

  function renderWalletMenu() {
    const wallet = walletState.wallet;
    walletMenu.replaceChildren();

    if (wallet) {
      walletMenu.appendChild(copyRow('Stake address', wallet.stake));
      if (wallet.address) walletMenu.appendChild(copyRow('Payment address', wallet.address));
      const profile = document.createElement('a');
      profile.className = 'btn btn--outline btn--sm';
      profile.href = `/profile/${encodeURIComponent(wallet.stake)}`;
      profile.textContent = 'My profile';
      walletMenu.appendChild(profile);
      walletMenu.appendChild(makeButton('Disconnect', () => {
        disconnectWallet();
        walletMenu.hidden = true;
      }));
      return;
    }

    const status = document.createElement('div');
    status.className = 'nav-profile-menu__status';
    status.hidden = true;
    const wallets = getAvailableWallets();
    if (wallets.length === 0) {
      status.hidden = false;
      status.textContent = 'No supported wallet extension detected. Install Eternl, Vespr, Typhon, or Lace.';
    }
    wallets.forEach((walletConfig) => {
      walletMenu.appendChild(makeButton(`Connect ${walletConfig.label}`, async () => {
        status.hidden = false;
        status.classList.remove('is-error');
        status.textContent = `Connecting to ${walletConfig.label}…`;
        try {
          await connectWallet(walletConfig);
          walletMenu.hidden = true;
        } catch (error) {
          status.classList.add('is-error');
          status.textContent = error?.message || 'Could not connect the wallet.';
        }
      }));
    });
    walletMenu.appendChild(status);
  }

  if (walletButton) {
    renderWalletButton();
    walletButton.addEventListener('click', () => {
      if (!walletMenu.hidden) {
        walletMenu.hidden = true;
        return;
      }
      renderWalletMenu();
      walletMenu.hidden = false;
    });
    window.addEventListener('preeb:wallet', () => {
      renderWalletButton();
      if (!walletMenu.hidden) renderWalletMenu();
    });
    document.addEventListener('click', (event) => {
      if (!walletMenu.hidden && !walletMenu.contains(event.target) && !walletButton.contains(event.target)) {
        walletMenu.hidden = true;
      }
    });
    restoreWallet();
  }

  if (profileButton) {
    const profileMenu = nav.querySelector('#nav-profile-menu');
    profileButton.addEventListener('click', () => {
      if (walletState.wallet) {
        window.location.href = `/profile/${encodeURIComponent(walletState.wallet.stake)}`;
        return;
      }
      if (!profileMenu.hidden) {
        profileMenu.hidden = true;
        return;
      }

      profileMenu.innerHTML = `
        <div class="nav-profile-menu__choices"></div>
        <div class="nav-profile-menu__status" hidden></div>`;
      profileMenu.hidden = false;
      renderProfileChoices(
        profileMenu.querySelector('.nav-profile-menu__choices'),
        profileMenu.querySelector('.nav-profile-menu__status'),
        'Connect'
      );
    });

    document.addEventListener('click', (event) => {
      if (!profileMenu.hidden && !profileMenu.contains(event.target) && event.target !== profileButton) {
        profileMenu.hidden = true;
      }
    });
  }

  hamburger.addEventListener('click', () => {
    setOpen(!nav.classList.contains('nav--open'));
  });

  links.addEventListener('click', (event) => {
    if (event.target.closest('a')) setOpen(false);
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setOpen(false);
  });

  window.addEventListener('resize', () => {
    if (window.matchMedia('(min-width: 1041px)').matches) setOpen(false);
  });

  window.PreebNavigation = {
    getAvailableWallets,
    renderProfileChoices,
    rewardHexToStakeAddress,
    addressHexToBech32,
    getConnectedWallet: () => walletState.wallet,
    getWalletApi: () => walletState.api,
    connectWallet,
    disconnectWallet,
  };
})();

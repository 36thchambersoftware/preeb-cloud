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

  function rewardHexToStakeAddress(rewardHex) {
    const bytes = hexToBytes(rewardHex);
    if (!bytes.length) throw new Error('Connected wallet returned an empty reward address');

    const hrp = (bytes[0] & 0x0f) === 1 ? 'stake' : 'stake_test';
    const data = convertBits(bytes, 8, 5);
    if (!data) throw new Error('Could not read the connected wallet reward address');

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

  const mount = document.querySelector('[data-site-navigation]');
  if (!mount) return;

  const path = window.location.pathname.replace(/\/index\.html$/, '/') || '/';
  const isHome = path === '/';
  const isCurrent = (href) => {
    if (href === '/') return isHome;
    return path === href || path === `${href}/` || path === `${href}.html`;
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
          <li><a href="/#about">About</a></li>
          <li><a href="/#community">Community</a></li>
          <li><a href="/airdrop"${isCurrent('/airdrop') ? ' aria-current="page"' : ''}>Airdrop</a></li>
          <li><a href="/leaderboard"${isCurrent('/leaderboard') ? ' aria-current="page"' : ''}>Leaderboard</a></li>
          <li><a href="/wall"${isCurrent('/wall') ? ' aria-current="page"' : ''}>Guest Wall</a></li>
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

  if (profileButton) {
    const profileMenu = nav.querySelector('#nav-profile-menu');
    profileButton.addEventListener('click', () => {
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
  };
})();

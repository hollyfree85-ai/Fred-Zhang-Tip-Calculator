/* ES1.6: install assistance. Never use a persisted "installed" flag or erase site data. */
(function () {
  'use strict';
  if (window.__fzInstallSupport) return;
  window.__fzInstallSupport = true;

  var APP_BUILD = 'ES1.8.63';
  var deferredPrompt = null;
  var swRegistration = null;
  var updateBusy = false;
  var updateAvailable = false;
  var updateRequested = false;
  var updateTimer = null;
  var promptBusy = false;
  var installedEventVersion = 0;
  var notice = '';
  var showSteps = false;
  var ready = false;
  var homeObserver = null;
  var observedHome = null;
  var displayMode = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;

  function isStandalone() {
    return !!((displayMode && displayMode.matches) || window.navigator.standalone === true);
  }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(window.navigator.userAgent || '') ||
      (/Macintosh/.test(window.navigator.userAgent || '') && window.navigator.maxTouchPoints > 1);
  }
  function refresh() {
    if (!ready) return;
    document.querySelectorAll('[data-fz-install]').forEach(function (panel) {
      var button = panel.querySelector('button');
      var status = panel.querySelector('[data-fz-install-status]');
      var help = panel.querySelector('[data-fz-install-help]');
      var updateButton = panel.querySelector('[data-fz-update]');
      var version = panel.querySelector('[data-fz-version]');
      button.disabled = promptBusy;
      if (updateButton) { updateButton.disabled = updateBusy; updateButton.textContent = updateBusy ? 'CHECKING UPDATE…' : (updateAvailable ? 'UPDATE APP NOW' : 'UPDATE APP'); }
      if (version) version.textContent = 'Current version: ' + APP_BUILD;
      button.textContent = promptBusy ? 'Opening installer…' : (isStandalone() ? 'App Info' : 'Install App');
      status.textContent = notice;
      status.hidden = !notice;
      help.hidden = !showSteps;
    });
  }
  function manualHelp(message) {
    notice = message || 'Use your browser menu to install or add this app to your home screen.';
    showSteps = true;
    refresh();
  }
  async function install() {
    if (promptBusy) return;
    if (isStandalone()) {
      notice = 'You are already using FZ Tip as an app. Open it from your home screen or app list next time.';
      showSteps = false;
      refresh();
      return;
    }
    if (!deferredPrompt) {
      manualHelp();
      return;
    }
    // beforeinstallprompt events are single-use. Consume before awaiting so double taps are safe.
    var event = deferredPrompt;
    var startedInstallVersion = installedEventVersion;
    deferredPrompt = null;
    promptBusy = true;
    notice = '';
    showSteps = false;
    refresh();
    try {
      await event.prompt();
      var choice = await event.userChoice;
      if (installedEventVersion !== startedInstallVersion) return;
      if (choice && choice.outcome === 'accepted') {
        notice = 'Install request accepted. Follow the browser instructions to finish.';
        showSteps = false;
      } else {
        notice = 'Installation was canceled. You can retry using the browser menu below.';
        showSteps = true;
      }
    } catch (error) {
      if (installedEventVersion !== startedInstallVersion) return;
      notice = 'The installer could not open. Use the browser menu below to try again.';
      showSteps = true;
    } finally {
      promptBusy = false;
      refresh();
    }
  }
  // Registered immediately when this script loads, before DOMContentLoaded.
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    notice = '';
    showSteps = false;
    refresh();
  });
  window.addEventListener('appinstalled', function () {
    installedEventVersion += 1;
    deferredPrompt = null;
    notice = 'Installation completed. Open FZ Tip from your home screen or app list.';
    showSteps = false;
    refresh();
  });
  if (displayMode) {
    var changed = function () { notice = ''; showSteps = false; refresh(); };
    if (displayMode.addEventListener) displayMode.addEventListener('change', changed);
    else if (displayMode.addListener) displayMode.addListener(changed);
  }

  function safeReloadForUpdate() {
    updateRequested = false;
    // Never clear localStorage / IndexedDB / drafts. A normal reload lets the new
    // service worker take control while all local app data remains intact.
    window.location.reload();
  }
  function watchRegistration(reg) {
    if (!reg) return;
    swRegistration = reg;
    if (reg.waiting) updateAvailable = true;
    reg.addEventListener('updatefound', function () {
      var worker = reg.installing;
      if (!worker) return;
      worker.addEventListener('statechange', function () {
        if (worker.state === 'installed' || worker.state === 'activated') {
          if (window.navigator.serviceWorker.controller) updateAvailable = true;
          refresh();
        }
      });
    });
  }
  async function checkUpdate(manual) {
    if (!('serviceWorker' in window.navigator) || updateBusy) return;
    updateBusy = true;
    if (manual) { notice = 'Checking for the newest app version…'; showSteps = false; }
    refresh();
    try {
      var reg = swRegistration || await window.navigator.serviceWorker.getRegistration('./') || await window.navigator.serviceWorker.ready;
      watchRegistration(reg);
      updateRequested = !!manual;
      await reg.update();
      if (reg.waiting) {
        updateAvailable = true;
        try { reg.waiting.postMessage({type:'SKIP_WAITING'}); } catch (_) {}
      }
      if (manual) {
        await new Promise(function (resolve) { setTimeout(resolve, 1600); });
        if (updateAvailable) {
          notice = 'Update ready. Reloading the app…'; refresh();
          setTimeout(safeReloadForUpdate, 120);
          return;
        }
        updateRequested = false;
        notice = 'App is up to date — ' + APP_BUILD + '.';
      }
    } catch (error) {
      updateRequested = false;
      if (manual) notice = 'Update check could not reach the server. Your current app and saved data are unchanged.';
    } finally {
      updateBusy = false;
      refresh();
    }
  }
  function startUpdateSupport() {
    if (!('serviceWorker' in window.navigator)) return;
    window.navigator.serviceWorker.getRegistration('./').then(watchRegistration).catch(function () {});
    window.navigator.serviceWorker.addEventListener('controllerchange', function () {
      updateAvailable = true;
      if (updateRequested) safeReloadForUpdate();
      else { notice = 'A newer app version is ready. Tap UPDATE APP to reload it.'; showSteps = false; refresh(); }
    });
    // Quiet background checks. They never erase drafts and never force a reload
    // while the user is typing; the user controls the final reload.
    setTimeout(function () { checkUpdate(false); }, 1800);
    updateTimer = setInterval(function () { if (document.visibilityState === 'visible') checkUpdate(false); }, 15 * 60 * 1000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') checkUpdate(false); });
  }
  function syncOwnerTools(target, panel) {
    var ownerHome = target.getAttribute && target.getAttribute('data-fz-home-role') === 'owner';
    var button = panel.querySelector('[data-fz-owner-tools]');
    if (!ownerHome) {
      if (button) button.remove();
      return;
    }
    if (button) return;
    button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn fz-install-button fz-owner-tools-button';
    button.setAttribute('data-fz-owner-tools', '');
    button.textContent = 'Owner Tools';
    button.addEventListener('click', function () {
      if (typeof window.__getCurrentRole === 'function' && window.__getCurrentRole() === 'owner') {
        if (typeof window.fzOpenOwnerTools === 'function') window.fzOpenOwnerTools();
      }
    });
    panel.insertBefore(button, panel.querySelector('[data-fz-update]') || panel.querySelector('[data-fz-install-status]'));
  }
  function mount(target) {
    if (!target) return;
    var existing = target.querySelector('[data-fz-install]');
    if (existing) { syncOwnerTools(target, existing); return; }
    var panel = document.createElement('div');
    panel.className = 'fz-install-support';
    panel.setAttribute('data-fz-install', '');
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn fz-install-button';
    button.textContent = 'Install App';
    button.addEventListener('click', install);
    panel.appendChild(button);
    var updateButton = document.createElement('button');
    updateButton.type = 'button';
    updateButton.className = 'btn fz-install-button fz-update-button';
    updateButton.setAttribute('data-fz-update', '');
    updateButton.textContent = 'UPDATE APP';
    updateButton.addEventListener('click', function () { checkUpdate(true); });
    panel.appendChild(updateButton);
    var version = document.createElement('span');
    version.setAttribute('data-fz-version', '');
    version.className = 'fz-app-version';
    version.textContent = 'Current version: ' + APP_BUILD;
    panel.appendChild(version);
    var status = document.createElement('p');
    status.setAttribute('data-fz-install-status', '');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.hidden = true;
    panel.appendChild(status);
    var help = document.createElement('div');
    help.setAttribute('data-fz-install-help', '');
    help.hidden = true;
    var steps = isIOS() ? [
      'iPhone / iPad: open this website in Safari, tap Share, then Add to Home Screen.'
    ] : [
      'Android / Chrome: open this website in Chrome. Tap ⋮ → Add to Home screen → Install. Menu wording can vary.',
      'If Chrome says already installed: open Android Settings → Apps to confirm the existing FZ Tip app, then open it and use UPDATE APP. Do not uninstall it for normal updates.',
      'On a computer, use the install icon in the address bar or the browser menu. Existing installations can use UPDATE APP.'
    ];
    steps.forEach(function (step) { var p = document.createElement('p'); p.textContent = step; help.appendChild(p); });
    panel.appendChild(help);
    target.appendChild(panel);
    syncOwnerTools(target, panel);
    refresh();
  }
  function bindHome() {
    var home = document.getElementById('fzRoleHome');
    if (!home) return;
    if (home !== observedHome) {
      if (homeObserver) homeObserver.disconnect();
      observedHome = home;
      homeObserver = new MutationObserver(function () { mount(home.querySelector('.fz-role-home-hero')); });
      // Only direct child replacement matters. Never observe the editing tables or our own content.
      homeObserver.observe(home, { childList: true });
    }
    mount(home.querySelector('.fz-role-home-hero'));
  }
  function init() {
    if (ready) return;
    ready = true;
    var style = document.createElement('style');
    style.id = 'fz-install-support-css';
    style.textContent = '.fz-install-support{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:16px;padding-top:14px;border-top:1px solid #87adba55;max-width:100%;text-align:left}.fz-install-support .fz-install-button{display:inline-flex;min-height:44px!important;align-items:center;justify-content:center;background:#edf8fb!important;border:1px solid #91bac9!important;color:#12394d!important;font-size:14px!important;padding:10px 18px!important;border-radius:12px!important}.fz-install-support .fz-update-button{background:#dff7ea!important;border-color:#7bc49c!important;color:#075d38!important;font-weight:900}.fz-install-support .fz-app-version{font-size:12px;font-weight:800;opacity:.8}.fz-install-support .fz-owner-tools-button{background:#fff0be!important;border-color:#d4bc72!important;color:#493d17!important;font-weight:800}.fz-install-support .fz-install-button:focus-visible{outline:3px solid #ffda6a;outline-offset:3px}.fz-install-support p{font-size:13px!important;line-height:1.55!important;margin:0!important;overflow-wrap:anywhere}.fz-install-support [data-fz-install-status],.fz-install-support [data-fz-install-help]{flex-basis:100%;min-width:0}.fz-install-support [data-fz-install-help]{padding:2px 0 3px}.fz-install-support [data-fz-install-help] p+p{margin-top:9px!important}.fz-install-support [hidden]{display:none!important}.fz-role-home-hero .fz-install-support{position:relative;z-index:1;flex-basis:100%}.fz-role-home-hero .fz-install-support p{color:inherit!important}@media print{.fz-install-support{display:none!important}}';
    document.head.appendChild(style);
    mount(document.querySelector('#loginView .login'));
    bindHome();
    startUpdateSupport();
    var appWrap = document.querySelector('#appView > .wrap') || document.querySelector('#appView .wrap');
    if (appWrap) {
      new MutationObserver(bindHome).observe(appWrap, { childList: true });
    }
  }
  window.fzInstallApp = install;
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();

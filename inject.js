// Add TizenTube script to the page. Don't inject more than once.
//
// Restore 4k support by hooking window.MediaSource.isTypeSupported to remove the height/width parameters.
// I am not actually sure why this works since isTypeSupported still returns false for VP09 codecs.
// YouTube does detect spoofing by checking nonsensical values for height/width so maybe that affects something?
// HDR still does not work, but at least 4k works now.
//
(function () {
if (document.mutube) return;
document.mutube = true;

var QUICK_SKIP_KEY = 'enableQuickSkip';
var QUICK_SKIP_CONFIG = 'ytaf-configuration';

function isQuickSkipEnabled() {
  try {
    var config = window.localStorage.getItem(QUICK_SKIP_CONFIG);
    return !config || !new RegExp('"' + QUICK_SKIP_KEY + '"\\s*:\\s*false').test(config);
  } catch (e) {
    return true;
  }
}

try {
  var quickSkipConfig = window.localStorage.getItem(QUICK_SKIP_CONFIG);
  var quickSkipSettings = quickSkipConfig ? JSON.parse(quickSkipConfig) : {};
  if (!quickSkipSettings || typeof quickSkipSettings !== 'object') quickSkipSettings = {};
  if (typeof quickSkipSettings[QUICK_SKIP_KEY] !== 'boolean') {
    quickSkipSettings[QUICK_SKIP_KEY] = true;
    window.localStorage.setItem(QUICK_SKIP_CONFIG, JSON.stringify(quickSkipSettings));
  }
} catch (e) {}

// Cobalt goes straight from readyState "loading" to "complete" without ever firing
// DOMContentLoaded. TizenTube is injected while still "loading", so its modules that
// wait for that event (player buttons incl. Speed Controls, extra subtitles) never
// start. Fire it ourselves at load if Cobalt didn't. Dispatched on document and
// window separately (non-bubbling) so listeners on either get it exactly once.
var dclFired = false;
document.addEventListener('DOMContentLoaded', function () { dclFired = true; });
window.addEventListener('load', function () {
  if (dclFired) return;
  document.dispatchEvent(new Event('DOMContentLoaded'));
  window.dispatchEvent(new Event('DOMContentLoaded'));
});

var script = document.createElement('script');
script.src = "https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v=" + Date.now();
script.async = true;
document.head.appendChild(script);

const originalIsTypeSupported = window.MediaSource.isTypeSupported.bind(window.MediaSource);

window.MediaSource.isTypeSupported = function(mimeType) {
  const parts = mimeType
    .split(';')
    .map(part => part.trim())
    .filter(part => part);

  const filtered = parts.filter(part => {
    return !(part.startsWith('width=') || part.startsWith('height='));
  });

  const cleaned = filtered.join('; ');
  return originalIsTypeSupported(cleaned);
};

var pressedQuickSkipKeys = {};
var lastQuickSkipTime = 0;
var quickSkipControlSelector = 'ytlr-player-actions-container, ytlr-progress-bar';

function quickSkipComposedParent(el) {
  var p = el && el.parentNode;
  return p && p.nodeType === 11 && p.host ? p.host : p;
}

function isVisibleFromQuickSkip(el) {
  if (!el || !el.getClientRects().length) return false;
  for (var c = el; c && c !== document; c = quickSkipComposedParent(c)) {
    if (c.nodeType !== 1) continue;
    var s = window.getComputedStyle(c), op = parseFloat(s.opacity);
    if (c.getAttribute('aria-hidden') === 'true' ||
        (c.classList && c.classList.contains('zylon-hidden')) ||
        s.display === 'none' || s.visibility === 'hidden' || (isFinite(op) && op <= 0)) return false;
  }
  return true;
}

function hasVisibleQuickSkipNode(root, sel) {
  var list = root.querySelectorAll(sel);
  for (var i = 0; i < list.length; i++) if (isVisibleFromQuickSkip(list[i])) return true;
  return false;
}

function isQuickSkipBlockedByUi(e) {
  var paths = e.composedPath ? [e.composedPath()] : [];
  [document.activeElement, e.target].forEach(function (el) {
    var path = [];
    for (; el && el !== document; el = quickSkipComposedParent(el)) if (el.nodeType === 1) path.push(el);
    paths.push(path);
  });
  var relSel = '.ytlr-tile-renderer--focused, ytlr-player-related-videos-container, ytlr-player-related-videos-renderer';
  var browseSel = 'ytlr-button, ytlr-squeezeback-player, ytlr-tile-renderer, ytlr-guide-item, ytlr-pivot-bar-item, ' + relSel;
  var dlgSel = '[role="dialog"], [aria-modal="true"], ytlr-popup-container, ytlr-dialog-renderer';
  var paneSel = '.overlay-panel, ' + dlgSel;
  var inCtrls = false, inBrowse = false, inPane = false;
  for (var p = 0; p < paths.length; p++) {
    for (var i = 0; i < paths[p].length; i++) {
      var n = paths[p][i];
      if (!n || n.nodeType !== 1 || !n.matches || !isVisibleFromQuickSkip(n)) continue;
      if (n.matches(quickSkipControlSelector)) inCtrls = true;
      if (n.matches(browseSel)) inBrowse = true;
      if (n.matches(paneSel)) inPane = true;
    }
  }
  if (inBrowse || (inPane && !inCtrls) || hasVisibleQuickSkipNode(document, dlgSel + ', ' + relSel)) return true;
  var panels = document.querySelectorAll('.overlay-panel');
  for (var j = 0; j < panels.length; j++) {
    if (isVisibleFromQuickSkip(panels[j]) &&
        hasVisibleQuickSkipNode(panels[j], 'button, [role="button"], [tabindex], ytlr-overlay-panel-item-renderer')) return true;
  }
  return false;
}

function sendQuickSkipPointer(target, type, x) {
  try {
    target.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: x,
      clientY: 0,
      screenX: x,
      screenY: 0,
      pointerId: 1,
      pointerType: 'touchpad',
      pressure: type === 'pointerup' ? 0 : 0.5,
      isPrimary: true
    }));
  } catch (e) {}
}

function handleQuickSkipKey(event) {
  if (!isQuickSkipEnabled()) return;
  var key = event.keyCode || event.which;
  if (key !== 37 && key !== 39) return;
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;

  var dispatchTarget = event.target && event.target.dispatchEvent ? event.target : document;
  var target = (document.contains && !document.contains(dispatchTarget)) ? document : dispatchTarget;

  if (event.type === 'keyup') {
    if (pressedQuickSkipKeys[key]) {
      event.preventDefault();
      event.stopImmediatePropagation();
      delete pressedQuickSkipKeys[key];
      sendQuickSkipPointer(target, 'pointerup', 0);
      sendQuickSkipPointer(target, 'pointermove', 0);
    }
    return;
  }

  var video = document.querySelector('video');
  if (!video || video.paused || video.ended || isQuickSkipBlockedByUi(event)) return;

  var controls = quickSkipControlSelector.split(', ');
  for (var i = 0; i < controls.length; i++) {
    var control = document.querySelector(controls[i]);
    if (control && isVisibleFromQuickSkip(control)) return;
  }

  var now = Date.now();
  var state = pressedQuickSkipKeys[key];
  if (state || event.repeat) {
    if (!state) state = pressedQuickSkipKeys[key] = { start: now, last: now };
    if (now - state.start < 400 || now - state.last < 300) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    state.last = now;
  } else {
    if (now - lastQuickSkipTime < 200) {
      pressedQuickSkipKeys[key] = { start: now, last: now };
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    pressedQuickSkipKeys[key] = { start: now, last: now };
  }

  lastQuickSkipTime = now;
  event.preventDefault();
  event.stopImmediatePropagation();

  var x = (key === 37) ? -0.85 : 0.85;
  sendQuickSkipPointer(target, 'pointerdown', x);
  sendQuickSkipPointer(target, 'pointermove', x);

  var init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent('keydown', init));
  target.dispatchEvent(new KeyboardEvent('keyup', init));

  sendQuickSkipPointer(target, 'pointerup', x);
  sendQuickSkipPointer(target, 'pointermove', 0);
}

document.addEventListener('keydown', handleQuickSkipKey, true);
document.addEventListener('keyup', handleQuickSkipKey, true);

function createQuickSkipSetting(index) {
  var enabled = isQuickSkipEnabled();
  return {
    compactLinkRenderer: {
      title: { simpleText: 'Quick Skip' },
      subtitle: { simpleText: 'Skip 10s with left/right button' },
      icon: { iconType: 'SKIP_NEXT' },
      secondaryIcon: { iconType: enabled ? 'CHECK_BOX' : 'CHECK_BOX_OUTLINE_BLANK' },
      serviceEndpoint: {
        commandExecutorCommand: {
          commands: [
            { setClientSettingEndpoint: { settingDatas: [{ clientSettingEnum: { item: QUICK_SKIP_KEY }, boolValue: !enabled }] } },
            { customAction: { action: 'SETTINGS_UPDATE', parameters: [index] } }
          ]
        }
      }
    }
  };
}

function addQuickSkipSetting(command) {
  if (!command || !command.openPopupAction || command.openPopupAction.uniqueId !== 'tt-settings') return;
  var items = command.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel.overlayPanelRenderer.content.overlayPanelItemListRenderer.items;
  if (!Array.isArray(items) || items.some(function (item) {
    return item && item.compactLinkRenderer && item.compactLinkRenderer.title &&
      item.compactLinkRenderer.title.simpleText === 'Quick Skip';
  })) return;
  items.push(createQuickSkipSetting(items.length));
}

setInterval(function () {
  if (!window._yttv) return;
  for (var key in window._yttv) {
    var instance = window._yttv[key] && window._yttv[key].instance;
    if (instance && typeof instance.resolveCommand === 'function' && !instance.resolveCommand._quickSkipHooked) {
      let original = instance.resolveCommand;
      instance.resolveCommand = function (command) {
        try { addQuickSkipSetting(command); } catch (e) {}
        return original.apply(this, arguments);
      };
      instance.resolveCommand._quickSkipHooked = true;
    }
  }
}, 300);

})();

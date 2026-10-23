// Add the TizenTube script and playback options to the page.
(function () {
  if (document.mutube) return;
  document.mutube = true;

  var CFG_KEY = 'ytaf-configuration';
  var origJsonParse = JSON.parse;

  function isSettingEnabled(key) {
    try {
      var raw = window.localStorage.getItem(CFG_KEY);
      return !raw || !new RegExp('"' + key + '"\\s*:\\s*false').test(raw);
    } catch (e) {
      return true;
    }
  }

  try {
    var rawCfg = window.localStorage.getItem(CFG_KEY);
    var parsedCfg = rawCfg ? origJsonParse(rawCfg) : {};
    if (!parsedCfg || typeof parsedCfg !== 'object') parsedCfg = {};
    if (typeof parsedCfg.enableHdr !== 'boolean') {
      parsedCfg.enableHdr = true;
      window.localStorage.setItem(CFG_KEY, JSON.stringify(parsedCfg));
    }
  } catch (e) {}

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

  var HDR_MIME_RE = /vp09\.02|vp9\.2|smpte2084|arib-std-b67|bt2020/i;
  var origIsSupported = window.MediaSource.isTypeSupported.bind(window.MediaSource);

  window.MediaSource.isTypeSupported = function (mimeType) {
    var s = String(mimeType);
    if (!isSettingEnabled('enableHdr') && HDR_MIME_RE.test(s)) return false;
    return origIsSupported(s.replace(/;\s*(width|height)=\d+/gi, ''));
  };

  function isHdrFormat(format) {
    if (!format || typeof format !== 'object') return false;
    return HDR_MIME_RE.test(format.mimeType || '') ||
      /HDR/i.test(format.qualityLabel || '') ||
      (format.colorInfo && /2084|B67|2020/i.test(JSON.stringify(format.colorInfo)));
  }

  JSON.parse = function () {
    var result = origJsonParse.apply(this, arguments);
    try {
      if (result && result.streamingData &&
          Array.isArray(result.streamingData.adaptiveFormats) &&
          !isSettingEnabled('enableHdr')) {
        var formats = result.streamingData.adaptiveFormats;
        var hasSdr = formats.some(function (format) {
          return format && format.mimeType && format.mimeType.indexOf('video/') === 0 && !isHdrFormat(format);
        });
        if (hasSdr) result.streamingData.adaptiveFormats = formats.filter(function (format) {
          return !isHdrFormat(format);
        });
      }
    } catch (e) {}
    return result;
  };

  function createSetting(title, subtitle, icon, key, index) {
    var enabled = isSettingEnabled(key);
    return {
      compactLinkRenderer: {
        title: { simpleText: title },
        subtitle: { simpleText: subtitle },
        icon: { iconType: icon },
        secondaryIcon: { iconType: enabled ? 'CHECK_BOX' : 'CHECK_BOX_OUTLINE_BLANK' },
        serviceEndpoint: {
          commandExecutorCommand: {
            commands: [
              { setClientSettingEndpoint: { settingDatas: [{ clientSettingEnum: { item: key }, boolValue: !enabled }] } },
              { customAction: { action: 'SETTINGS_UPDATE', parameters: [index] } }
            ]
          }
        }
      }
    };
  }

  function patchSettingsPopup(command) {
    if (!command || !command.openPopupAction || command.openPopupAction.uniqueId !== 'tt-settings') return;
    var items = command.openPopupAction.popup.overlaySectionRenderer.overlay.overlayTwoPanelRenderer.actionPanel.overlayPanelRenderer.content.overlayPanelItemListRenderer.items;
    if (!Array.isArray(items) || items.some(function (item) {
      return item && item.compactLinkRenderer && item.compactLinkRenderer.title &&
        item.compactLinkRenderer.title.simpleText === 'Allow HDR';
    })) return;
    items.push(createSetting(
      'Allow HDR',
      'Disable if HDR playback stutters',
      'VIDEO_QUALITY',
      'enableHdr',
      items.length
    ));
  }

  setInterval(function () {
    if (!window._yttv) return;
    for (var key in window._yttv) {
      var instance = window._yttv[key] && window._yttv[key].instance;
      if (instance && typeof instance.resolveCommand === 'function' && !instance.resolveCommand._hdrHooked) {
        var original = instance.resolveCommand;
        instance.resolveCommand = function (command) {
          try { patchSettingsPopup(command); } catch (e) {}
          return original.apply(this, arguments);
        };
        instance.resolveCommand._hdrHooked = true;
      }
    }
  }, 300);
})();

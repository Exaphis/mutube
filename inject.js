// Add TizenTube script to the page. Don't inject more than once.
//
// Restore 4k support by hooking window.MediaSource.isTypeSupported to remove the height/width parameters.
// I am not actually sure why this works since isTypeSupported still returns false for VP09 codecs.
// YouTube does detect spoofing by checking nonsensical values for height/width so maybe that affects something?
// HDR still does not work, but at least 4k works now.
//
// 4K60 cap (test build): stripping width/height hides every size limit from the native capability
// check, and the native HDR patches also lift Google's 4K60 rejection. On devices that decode VP9
// in software and are too slow for 4K60 (Apple TV 4K 1st gen, AppleTV6-2) the video then falls
// behind the audio. Google's own limit for that device is 1440p at any fps, or above 1440p at
// 30fps or less. So unless the device is a known-fast model (2nd gen AppleTV11-1, 3rd gen
// AppleTV14-1), refuse formats above 2560x1440 that are over 30fps or have no framerate given.
// Native patches are left alone, they are fine on the 3rd gen.
//
// HDR cap: HDR is VP9 profile 2 (vp09.02, 10-bit), which is heavier to decode in software than
// SDR. The native vp09.02 hook skips every size/fps check, so on a slow box HDR above 1080p is
// refused when it is over 30fps (measured on a 1st gen: 1080p60 HDR, 1440p30 HDR and 4K30 HDR
// play, 1440p60 HDR stutters and drifts from the audio). BLOCK_4K_HDR also refuses HDR above
// 1440p entirely, for people who see hitches at 4K30 HDR.
//
// Apple TV HD (AppleTV5-3, A8, 1080p max): no hardware VP9, and Google's own native code only
// allows software VP9 up to 1080p at 30fps or less, or 720p at any fps, on boxes that are not
// the 4K 1st gen. We mirror that for VP9 formats. H.264 is left alone (hardware decoded).
//
// SHOW_BANNER prints the cap state and the user agent for 15 seconds after load. Detection is
// confirmed on Apple TV HD (AppleTV5-3), 4K 1st gen (AppleTV6-2) and 4K 3rd gen (AppleTV14-1),
// so by default it only shows on models it does not recognise. Set it to true to force it.
//
(function () {
if (document.mutube) return;
document.mutube = true;

var BLOCK_4K_HDR = false;
var ua = navigator.userAgent || '';
var fastBox = /AppleTV(11|14)[-,]1/.test(ua);
var hdBox = /AppleTV5[-,]3/.test(ua);
var capOn = !fastBox;
var SHOW_BANNER = !/AppleTV(5[-,]3|6[-,]2|11[-,]1|14[-,]1)/.test(ua);

// Cobalt goes straight from readyState "loading" to "complete" without ever firing
// DOMContentLoaded. TizenTube is injected while still "loading", so its modules that
// wait for that event (player buttons incl. Speed Controls, extra subtitles) never
// start. Fire it ourselves at load if Cobalt didn't. Dispatched on document and
// window separately (non-bubbling) so listeners on either get it exactly once.
var dclFired = false;
document.addEventListener('DOMContentLoaded', function () { dclFired = true; });
window.addEventListener('load', function () {
  if (!dclFired) {
    document.dispatchEvent(new Event('DOMContentLoaded'));
    window.dispatchEvent(new Event('DOMContentLoaded'));
  }
  if (SHOW_BANNER && document.body) {
    var d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:40px;bottom:40px;right:40px;z-index:2147483647;background:#000;color:#fff;font:26px monospace;padding:14px;word-break:break-all;opacity:0.9';
    d.textContent = 'MuTube: ' + (hdBox ? 'CAP ON (Apple TV HD rules)' : (capOn ? 'CAP ON (4K60 blocked)' : 'CAP OFF')) + ' | ' + ua;
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 15000);
  }
});

var script = document.createElement('script');
script.src = "https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v=" + Date.now();
script.async = true;
document.head.appendChild(script);

var originalIsTypeSupported = window.MediaSource.isTypeSupported.bind(window.MediaSource);

window.MediaSource.isTypeSupported = function (mimeType) {
  var parts = mimeType
    .split(';')
    .map(function (p) { return p.trim(); })
    .filter(function (p) { return p; });

  if (capOn) {
    var w = 0, h = 0, fps = 0;
    parts.forEach(function (p) {
      var kv = p.split('=');
      if (kv.length === 2) {
        var v = parseFloat(kv[1].replace(/"/g, ''));
        if (kv[0] === 'width') w = v;
        else if (kv[0] === 'height') h = v;
        else if (kv[0] === 'framerate') fps = v;
      }
    });
    if ((w > 2560 || h > 1440) && (!fps || fps > 30)) return false;
    if (hdBox && (mimeType.indexOf('vp09') !== -1 || mimeType.indexOf('vp9') !== -1)) {
      var ok720 = w <= 1280 && h <= 720;
      var ok1080 = w <= 1920 && h <= 1080 && fps > 0 && fps <= 30;
      if (!(ok720 || ok1080)) return false;
    }
    if (mimeType.indexOf('vp09.02') !== -1) {
      if ((w > 1920 || h > 1080) && (!fps || fps > 30)) return false;
      if (BLOCK_4K_HDR && (w > 2560 || h > 1440)) return false;
    }
  }

  var cleaned = parts
    .filter(function (p) { return !(p.indexOf('width=') === 0 || p.indexOf('height=') === 0); })
    .join('; ');
  return originalIsTypeSupported(cleaned);
};
})();

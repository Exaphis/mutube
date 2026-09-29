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

// Cobalt goes straight from readyState "loading" to "complete" without ever firing
// DOMContentLoaded. TizenTube is injected while still "loading", so the modules that
// defer to that event (player buttons incl. Speed Controls, extra subtitles) never
// start. Capture the listeners TizenTube registers and run them if the event never fires.
var dclFired = false, dclPending = [], dclTargets = [window, document];
document.addEventListener('DOMContentLoaded', function () { dclFired = true; });
dclTargets.forEach(function (t) {
  var orig = t.addEventListener;
  t.addEventListener = function (type, fn) {
    if (type === 'DOMContentLoaded' && typeof fn === 'function' && !dclFired) dclPending.push(fn);
    return orig.apply(this, arguments);
  };
});
function flushDCL() {
  if (dclFired) return;
  dclFired = true;
  dclPending.splice(0).forEach(function (fn) { try { fn.call(document, new Event('DOMContentLoaded')); } catch (e) {} });
}

var script = document.createElement('script');
script.src = "https://cdn.jsdelivr.net/npm/@foxreis/tizentube/dist/userScript.js?v=" + Date.now();
script.async = true;
script.onload = function () {
  dclTargets.forEach(function (t) { delete t.addEventListener; }); // back to EventTarget.prototype's
  if (document.readyState === 'complete') flushDCL();
  else window.addEventListener('load', flushDCL);
};
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
})();

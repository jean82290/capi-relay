// The browser script served at /capi.js.
// Nothing leaves the browser until the site calls capi('consent', true).
// It never sets cookies; it only reads the _fbp/_fbc cookies the Pixel already set.

export function snippetSource(endpoint) {
  return `/*! capi-relay browser helper — consent-first. MIT License. */
(function (w, d) {
  'use strict';
  var ENDPOINT = ${JSON.stringify(endpoint)};
  var STANDARD = ${JSON.stringify([
    'AddPaymentInfo', 'AddToCart', 'AddToWishlist', 'CompleteRegistration', 'Contact',
    'CustomizeProduct', 'Donate', 'FindLocation', 'InitiateCheckout', 'Lead', 'PageView',
    'Purchase', 'Schedule', 'Search', 'StartTrial', 'SubmitApplication', 'Subscribe', 'ViewContent',
  ])};
  var granted = false;
  var options = { pixel: true };

  function uuid() {
    if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID();
    return 'e' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function cookie(name) {
    var m = ('; ' + d.cookie).split('; ' + name + '=');
    return m.length > 1 ? decodeURIComponent(m.pop().split(';')[0]) : undefined;
  }
  function fbcFromUrl() {
    var m = /[?&]fbclid=([^&#]+)/.exec(w.location.search);
    return m ? 'fb.1.' + Date.now() + '.' + decodeURIComponent(m[1]) : undefined;
  }
  function post(body) {
    try {
      if (w.navigator.sendBeacon && w.navigator.sendBeacon(ENDPOINT, new Blob([body], { type: 'text/plain' }))) return;
    } catch (e) {}
    try {
      w.fetch(ENDPOINT, { method: 'POST', body: body, keepalive: true, credentials: 'include', headers: { 'content-type': 'text/plain' } });
    } catch (e) {}
  }

  function track(name, customData, opts) {
    opts = opts || {};
    var eventId = opts.eventId || uuid();
    if (!granted) return eventId; // no consent: nothing is sent, neither to Meta nor to the relay
    if (options.pixel && opts.pixel !== false && typeof w.fbq === 'function') {
      w.fbq(STANDARD.indexOf(name) >= 0 ? 'track' : 'trackCustom', name, customData || {}, { eventID: eventId });
    }
    post(JSON.stringify({
      event_name: name,
      event_id: eventId,
      event_source_url: w.location.href,
      consent: true,
      fbp: cookie('_fbp'),
      fbc: cookie('_fbc') || fbcFromUrl(),
      user_data: opts.userData || undefined,
      custom_data: customData || undefined
    }));
    return eventId;
  }

  function handle(args) {
    var cmd = args[0];
    if (cmd === 'consent') granted = args[1] === true;
    else if (cmd === 'config' && args[1]) { for (var k in args[1]) options[k] = args[1][k]; }
    else if (cmd === 'track') return track(args[1], args[2], args[3]);
  }

  var queued = (w.capi && w.capi.q) || [];
  w.capi = function () { return handle(arguments); };
  w.capi.loaded = true;
  for (var i = 0; i < queued.length; i++) handle(queued[i]);
})(window, document);
`;
}

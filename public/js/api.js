/*
 * Zeiterfassung – Verbindung zum Server
 * Merkt sich die Abweichung zwischen Handy- und Serveruhr, damit der
 * Timer auch bei falsch gestellter Handyuhr stimmt.
 */
(function (root) {
  'use strict';

  const Api = {
    offset: 0,
    now() {
      return Date.now() + Api.offset;
    },
    async call(method, url, body) {
      let res;
      try {
        res = await fetch(url, {
          method,
          credentials: 'same-origin',
          cache: 'no-store',
          headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
          body: body !== undefined ? JSON.stringify(body) : undefined,
        });
      } catch (_) {
        const err = new Error('Keine Verbindung zum Server.');
        err.offline = true;
        throw err;
      }
      const serverTime = Number(res.headers.get('X-Server-Time'));
      if (serverTime) Api.offset = serverTime - Date.now();
      let data = null;
      try {
        data = await res.json();
      } catch (_) { /* keine JSON-Antwort */ }
      if (!res.ok) {
        const err = new Error((data && data.error) || `Der Server antwortet mit Fehler ${res.status}.`);
        err.status = res.status;
        if (res.status === 502 || res.status === 503 || res.status === 504) err.offline = true;
        throw err;
      }
      return data || {};
    },
    get: (url) => Api.call('GET', url),
    post: (url, body) => Api.call('POST', url, body || {}),
    put: (url, body) => Api.call('PUT', url, body || {}),
    del: (url) => Api.call('DELETE', url),
  };

  root.Api = Api;
})(self);

/*
 * sso-gate/js — landry.bot sign-in for plain-JS pages, via the broker
 * (auth.landry.bot: Cognito with Google). Authorization code + PKCE; the
 * broker refuses anyone not on this site's allow-list before a token exists.
 *
 *   <script src="/landry-auth.js"></script>
 *   const auth = LandryAuth.create({ site, clientId, hostedDomain, apiUrl });
 *   const s = await auth.init();   // {status: signedIn|signedOut|denied|error, user?, message?}
 *   auth.signIn(); auth.signOut(); await auth.accessToken(); auth.fetch(url, init);
 *   auth.members.list() / add(email, role) / setRole(email, role) / remove(email)
 *   LandryAuth.mountMembersAdmin(element, auth)   // the shared "manage users" UI
 *
 * Every touch of localStorage / sessionStorage sits in a try: iOS Safari with
 * "Block All Cookies" throws SecurityError from the GETTER. Without storage the
 * page still renders and init() answers with a sentence (sign-in itself needs
 * cookies at Google and the broker, so it cannot work there).
 *
 * Classic script (window.LandryAuth) and CommonJS (tests) from one file.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.LandryAuth = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SKEW = 60; // seconds: refresh this long before expiry
  var COOKIES_SENTENCE =
    'Sign-in needs cookies and site data. Allow them for this site (Safari: Settings > Safari > Block All Cookies off) and try again.';

  function b64url(bytes) {
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function randomString(n) {
    var a = new Uint8Array(n);
    crypto.getRandomValues(a);
    return b64url(a);
  }
  async function s256(text) {
    var d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return b64url(new Uint8Array(d));
  }
  /** Claims of a JWT, NOT verified: for the UI only. Servers verify. */
  function claimsOf(token) {
    try {
      var p = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var json = decodeURIComponent(
        atob(p + '==='.slice((p.length + 3) % 4))
          .split('')
          .map(function (c) { return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2); })
          .join(''),
      );
      return JSON.parse(json);
    } catch (e) {
      return null;
    }
  }

  /** A storage that never throws; falls back to memory. */
  function safeStorage(win, which) {
    var mem = {};
    var real = null;
    var blocked = false;
    try {
      real = win[which];
      real.getItem('__probe__');
    } catch (e) {
      real = null;
      blocked = true;
    }
    return {
      blocked: blocked,
      get: function (k) {
        // A write the browser refused lives in mem; it wins over the stale real value.
        if (k in mem) return mem[k];
        try { return real ? real.getItem(k) : null; } catch (e) { return null; }
      },
      /** True if the value reached the browser's storage (survives a navigation). */
      set: function (k, v) {
        try {
          if (!real) throw new Error('no storage');
          real.setItem(k, v);
          delete mem[k];
          return true;
        } catch (e) {
          mem[k] = v;
          return false;
        }
      },
      remove: function (k) {
        try { if (real) real.removeItem(k); } catch (e) { /* ignore */ }
        delete mem[k];
      },
    };
  }

  function create(opts) {
    var win = opts.window || window;
    var doFetch = opts.fetch || function (u, i) { return win.fetch(u, i); };
    var navigate = opts.navigate || function (u) { win.location.assign(u); };
    var site = opts.site;
    var clientId = opts.clientId;
    var hosted = String(opts.hostedDomain || 'https://auth.landry.bot').replace(/\/$/, '');
    var apiUrl = String(opts.apiUrl || 'https://api.auth.landry.bot').replace(/\/$/, '');
    var redirectUri = opts.redirectUri || win.location.origin + '/';
    var key = 'landry.' + site + '.auth';
    var local = safeStorage(win, 'localStorage');
    var session = safeStorage(win, 'sessionStorage');
    var tokens = null; // {access, refresh}
    var refreshing = null;
    var listeners = [];
    var current = { status: 'checking' };

    function load() {
      try { return JSON.parse(local.get(key) || 'null'); } catch (e) { return null; }
    }
    function save(t) {
      tokens = t;
      if (t) local.set(key, JSON.stringify(t));
      else local.remove(key);
    }
    function userOf(access) {
      var c = claimsOf(access) || {};
      return { email: c.email, role: c.landry_role, site: c.landry_site, isAdmin: c.landry_role === 'admin' };
    }
    function expired(access) {
      var c = claimsOf(access);
      return !c || !c.exp || c.exp - SKEW <= Date.now() / 1000;
    }
    function same(a, b) {
      var ua = a.user || {};
      var ub = b.user || {};
      return a.status === b.status && a.message === b.message && ua.email === ub.email && ua.role === ub.role && ua.site === ub.site;
    }
    function set(next) {
      var changed = !same(next, current);
      current = next;
      if (changed) listeners.slice().forEach(function (f) { try { f(next); } catch (e) { /* listener's problem */ } });
      return next;
    }
    function signedIn() {
      return set({ status: 'signedIn', user: userOf(tokens.access) });
    }
    function cleanUrl(to) {
      try { win.history.replaceState(null, '', to); } catch (e) { /* ignore */ }
    }

    async function tokenCall(params) {
      params.client_id = clientId;
      var res = await doFetch(hosted + '/oauth2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString(),
      });
      var body = await res.json().catch(function () { return {}; });
      if (!res.ok || !body.access_token) {
        var err = new Error(body.error || 'token endpoint ' + res.status);
        err.status = res.status;
        throw err;
      }
      return body;
    }

    /** One refresh at a time; the old token stays readable meanwhile. */
    function refresh() {
      if (!tokens || !tokens.refresh) return Promise.resolve(null);
      if (refreshing) return refreshing;
      var r = tokens.refresh;
      refreshing = tokenCall({ grant_type: 'refresh_token', refresh_token: r })
        .then(function (b) {
          // Signed out (or signed in afresh) while this was in flight: not ours to save.
          if (!tokens || tokens.refresh !== r) return tokens ? tokens.access : null;
          save({ access: b.access_token, refresh: b.refresh_token || r });
          signedIn();
          return tokens.access;
        })
        .catch(function (e) {
          // A network failure keeps the session; a refusal ends it.
          if (e && e.status >= 400 && e.status < 500) {
            if (!tokens || tokens.refresh !== r) return null;
            save(null);
            set({ status: 'signedOut' });
            return null;
          }
          throw e;
        })
        .finally(function () { refreshing = null; });
      return refreshing;
    }

    var auth = {
      get storageBlocked() { return local.blocked || session.blocked; },
      get status() { return current; },
      onChange: function (f) {
        listeners.push(f);
        return function () { listeners = listeners.filter(function (x) { return x !== f; }); };
      },

      init: async function () {
        var q = new URLSearchParams(win.location.search);
        if (q.has('error') || q.has('error_description')) {
          var desc = q.get('error_description') || q.get('error') || '';
          cleanUrl(win.location.pathname);
          if (/not_allowed/.test(desc)) return set({ status: 'denied' });
          return set({ status: 'error', message: 'Sign-in failed: ' + desc });
        }
        if (q.has('code')) {
          var code = q.get('code');
          var state = q.get('state');
          var pending = null;
          try { pending = JSON.parse(session.get(key + '.pkce') || 'null'); } catch (e) { pending = null; }
          session.remove(key + '.pkce');
          if (auth.storageBlocked || !pending) {
            cleanUrl(win.location.pathname);
            return set({
              status: 'error',
              message: auth.storageBlocked
                ? COOKIES_SENTENCE
                : 'Sign-in expired. Please try again.',
            });
          }
          if (pending.state !== state) {
            cleanUrl(win.location.pathname);
            return set({ status: 'error', message: 'Sign-in did not match this browser tab. Please try again.' });
          }
          cleanUrl(pending.next || '/');
          try {
            var b = await tokenCall({
              grant_type: 'authorization_code',
              code: code,
              redirect_uri: redirectUri,
              code_verifier: pending.verifier,
            });
            save({ access: b.access_token, refresh: b.refresh_token });
            return signedIn();
          } catch (e) {
            return set({ status: 'error', message: 'Sign-in failed. Please try again.' });
          }
        }
        tokens = load();
        if (!tokens || !tokens.access) return set({ status: 'signedOut' });
        if (!expired(tokens.access)) return signedIn();
        try {
          var a = await refresh();
          return a ? current : set({ status: 'signedOut' });
        } catch (e) {
          return set({ status: 'error', message: 'Could not reach the sign-in service. Check your connection.' });
        }
      },

      signIn: async function (next) {
        var verifier = randomString(48);
        var state = randomString(16);
        var here = win.location.pathname + win.location.search + win.location.hash;
        // The verifier must survive the trip to Google and back; held only in
        // memory it dies with this page and the return can only fail.
        // (and init() refuses any return while either storage is blocked).
        if (!session.set(key + '.pkce', JSON.stringify({ verifier: verifier, state: state, next: next || here })) || auth.storageBlocked) {
          set({ status: 'error', message: COOKIES_SENTENCE });
          return;
        }
        var u = new URL(hosted + '/oauth2/authorize');
        u.searchParams.set('response_type', 'code');
        u.searchParams.set('client_id', clientId);
        u.searchParams.set('redirect_uri', redirectUri);
        u.searchParams.set('scope', 'openid email profile');
        u.searchParams.set('identity_provider', 'Google');
        u.searchParams.set('state', state);
        u.searchParams.set('code_challenge_method', 'S256');
        u.searchParams.set('code_challenge', await s256(verifier));
        navigate(u.toString());
      },

      signOut: async function () {
        var r = tokens && tokens.refresh;
        save(null);
        set({ status: 'signedOut' });
        if (r) {
          try {
            await doFetch(hosted + '/oauth2/revoke', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: new URLSearchParams({ token: r, client_id: clientId }).toString(),
            });
          } catch (e) { /* signed out locally regardless */ }
        }
        var u = new URL(hosted + '/logout');
        u.searchParams.set('client_id', clientId);
        u.searchParams.set('logout_uri', redirectUri);
        navigate(u.toString());
      },

      /** A current access token (refreshed if near expiry), or null if signed out. */
      accessToken: async function () {
        if (!tokens) return null;
        if (!expired(tokens.access)) return tokens.access;
        return refresh();
      },

      /** fetch with the bearer token; one refresh-and-retry on 401. */
      fetch: async function (url, init) {
        init = init || {};
        async function once(t) {
          var h = new Headers(init.headers || {});
          if (t) h.set('Authorization', 'Bearer ' + t);
          return doFetch(url, Object.assign({}, init, { headers: h }));
        }
        var res = await once(await auth.accessToken());
        if (res.status === 401 && tokens) {
          var t = await refresh();
          if (t) res = await once(t);
        }
        return res;
      },

      /** Test seam: make the held access token look expired. */
      expireForTest: function () {
        if (tokens) tokens = { access: tokens.access.split('.')[0] + '.' + b64url(new TextEncoder().encode(JSON.stringify(Object.assign({}, claimsOf(tokens.access), { exp: 1 })))) + '.x', refresh: tokens.refresh };
      },
    };

    async function call(method, path, body) {
      var res = await auth.fetch(apiUrl + '/sites/' + encodeURIComponent(site) + '/members' + path, {
        method: method,
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      var out = res.status === 204 ? {} : await res.json().catch(function () { return {}; });
      if (!res.ok) {
        var err = new Error(out.error || 'HTTP ' + res.status);
        err.status = res.status;
        throw err;
      }
      return out;
    }
    auth.members = {
      list: function () { return call('GET', '').then(function (o) { return o.members || []; }); },
      add: function (email, role) { return call('POST', '', { email: email, role: role || 'user' }); },
      setRole: function (email, role) { return call('PATCH', '/' + encodeURIComponent(email), { role: role }); },
      remove: function (email) { return call('DELETE', '/' + encodeURIComponent(email)); },
    };
    return auth;
  }

  /**
   * The shared "manage users" UI: a list with role and remove, and an add
   * form. Plain DOM; style via the .landry-members* classes. Re-renders from
   * the broker after every change, so two admins see each other's edits.
   */
  function mountMembersAdmin(el, auth) {
    var doc = el.ownerDocument;
    function h(tag, attrs, kids) {
      var n = doc.createElement(tag);
      Object.keys(attrs || {}).forEach(function (k) {
        if (k === 'on') Object.keys(attrs.on).forEach(function (ev) { n.addEventListener(ev, attrs.on[ev]); });
        else if (k === 'text') n.textContent = attrs.text;
        else n.setAttribute(k, attrs[k]);
      });
      (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
      return n;
    }
    var status = h('p', { class: 'landry-members-status', role: 'status' });
    var list = h('ul', { class: 'landry-members-list' });
    var email = h('input', { type: 'email', placeholder: 'name@gmail.com', required: '', 'aria-label': 'Email' });
    var role = h('select', { 'aria-label': 'Role' }, [h('option', { value: 'user', text: 'user' }), h('option', { value: 'admin', text: 'admin' })]);
    var form = h('form', { class: 'landry-members-add', on: { submit: function (e) {
      e.preventDefault();
      act(auth.members.add(email.value, role.value), 'Added ' + email.value).then(function (ok) { if (ok) email.value = ''; });
    } } }, [email, role, h('button', { type: 'submit', text: 'Add' })]);
    el.textContent = '';
    el.appendChild(h('div', { class: 'landry-members' }, [list, form, status]));

    function say(t) { status.textContent = t; }
    function act(p, done) {
      say('Saving…');
      return p.then(function () { say(done); refresh(); return true; }, function (e) {
        say(e.status === 409 ? 'Already done: ' + e.message : e.status === 403 ? 'Only a site admin can do that.' : 'Failed: ' + e.message);
        refresh();
        return false;
      });
    }
    function refresh() {
      return auth.members.list().then(function (members) {
        list.textContent = '';
        var me = (auth.status.user || {}).email;
        members.forEach(function (m) {
          var kids = [h('span', { class: 'landry-members-email', text: m.email }), h('span', { class: 'landry-members-role', text: m.global ? 'admin (all sites)' : m.role })];
          if (!m.global && m.email !== me) {
            kids.push(h('button', { type: 'button', text: m.role === 'admin' ? 'Make user' : 'Make admin', on: { click: function () {
              act(auth.members.setRole(m.email, m.role === 'admin' ? 'user' : 'admin'), 'Updated ' + m.email);
            } } }));
            kids.push(h('button', { type: 'button', text: 'Remove', on: { click: function () {
              act(auth.members.remove(m.email), 'Removed ' + m.email);
            } } }));
          }
          list.appendChild(h('li', {}, kids));
        });
      }, function (e) { say(e.status === 403 ? 'Only a site admin can manage users.' : 'Could not load users: ' + e.message); });
    }
    refresh();
    return { refresh: refresh };
  }

  return { create: create, mountMembersAdmin: mountMembersAdmin, claimsOf: claimsOf };
});

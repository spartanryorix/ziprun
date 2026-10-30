/*
 * ZipRun preview bridge — injected into every previewed page.
 * Forwards console output, errors, failed requests and navigation to the ZipRun UI,
 * and lets the UI run console commands, navigate, and hot-swap CSS.
 */
(function () {
  if (window.__ziprunBridge) return;
  window.__ziprunBridge = true;

  var top = window.parent !== window ? window.parent : null;
  var channel = null;
  try { if (!top) channel = new BroadcastChannel('ziprun-preview'); } catch (e) {}

  function post(msg) {
    msg.__ziprun = true;
    try {
      if (top) top.postMessage(msg, '*');
      else if (channel) channel.postMessage(msg);
    } catch (e) {
      try { msg.args = msg.args && msg.args.map(String); (top || channel).postMessage(msg, '*'); } catch (e2) {}
    }
  }

  function fmt(v, depth, seen) {
    depth = depth || 0;
    seen = seen || [];
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    var t = typeof v;
    if (t === 'string') return depth ? JSON.stringify(v) : v;
    if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
    if (t === 'symbol') return v.toString();
    if (t === 'function') return 'ƒ ' + (v.name || 'anonymous') + '()';
    if (v instanceof Error) return (v.name || 'Error') + ': ' + v.message + (v.stack && depth === 0 ? '\n' + cleanStack(v.stack) : '');
    if (typeof Element !== 'undefined' && v instanceof Element) {
      return '<' + v.tagName.toLowerCase() + (v.id ? '#' + v.id : '') + (v.className && typeof v.className === 'string' ? '.' + v.className.trim().split(/\s+/).join('.') : '') + '>';
    }
    if (seen.indexOf(v) !== -1) return '[Circular]';
    if (depth > 3) return Array.isArray(v) ? '[…]' : '{…}';
    seen = seen.concat([v]);
    try {
      if (Array.isArray(v)) {
        var items = v.slice(0, 50).map(function (x) { return fmt(x, depth + 1, seen); });
        if (v.length > 50) items.push('… ' + (v.length - 50) + ' more');
        return '[' + items.join(', ') + ']';
      }
      if (v instanceof Map) return 'Map(' + v.size + ')';
      if (v instanceof Set) return 'Set(' + v.size + ')';
      if (v instanceof Date) return v.toISOString();
      if (v instanceof Promise) return 'Promise';
      var keys = Object.keys(v);
      var name = v.constructor && v.constructor.name && v.constructor.name !== 'Object' ? v.constructor.name + ' ' : '';
      var parts = keys.slice(0, 30).map(function (k) { return k + ': ' + fmt(v[k], depth + 1, seen); });
      if (keys.length > 30) parts.push('…');
      return name + '{' + parts.join(', ') + '}';
    } catch (e) {
      return String(v);
    }
  }

  function cleanStack(stack) {
    return String(stack).split('\n').slice(0, 6).join('\n');
  }

  function render(args) {
    var list = Array.prototype.slice.call(args);
    // Support console.log('%c styled', 'css') and '%s' substitutions loosely.
    if (typeof list[0] === 'string' && /%[sdoOicf]/.test(list[0])) {
      var first = list.shift();
      first = first.replace(/%([sdoOicf])/g, function (_, k) {
        if (!list.length) return '';
        var a = list.shift();
        return k === 'c' ? '' : fmt(a, 1);
      });
      list.unshift(first);
    }
    return list.map(function (a) { return fmt(a); }).join(' ');
  }

  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      post({ type: 'console', level: level, text: render(arguments) });
      return orig && orig.apply(console, arguments);
    };
  });
  var origTable = console.table;
  console.table = function (data) {
    post({ type: 'console', level: 'log', text: fmt(data) });
    return origTable && origTable.apply(console, arguments);
  };

  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && (t.src || t.href)) {
      post({ type: 'console', level: 'error', text: 'Failed to load ' + (t.tagName || '').toLowerCase() + ': ' + (t.src || t.href) });
      return;
    }
    var where = e.filename ? ' (' + e.filename.replace(location.origin, '') + ':' + e.lineno + ':' + e.colno + ')' : '';
    post({ type: 'console', level: 'error', text: 'Uncaught ' + (e.error ? fmt(e.error) : e.message) + where, uncaught: true });
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    post({ type: 'console', level: 'error', text: 'Unhandled promise rejection: ' + fmt(e.reason), uncaught: true });
  });

  // Watch fetch failures (cross-origin ones are invisible to the service worker).
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function (input, init) {
      var u = typeof input === 'string' ? input : (input && input.url) || String(input);
      return origFetch.apply(this, arguments).then(function (res) {
        if (!res.ok) post({ type: 'console', level: 'warn', text: 'fetch ' + u + ' → HTTP ' + res.status });
        return res;
      }, function (err) {
        var hint = /^https?:\/\/(localhost|127\.0\.0\.1)/.test(u) ? ' — this points at a local backend that is not running in the preview.' : ' — network error or blocked by CORS.';
        post({ type: 'console', level: 'error', text: 'fetch ' + u + ' failed' + hint });
        throw err;
      });
    };
  }

  // Previews share ZipRun's origin, so a project's own service worker would replace ours.
  try {
    if (navigator.serviceWorker && location.hostname.indexOf('webcontainer') === -1) {
      Object.defineProperty(navigator.serviceWorker, 'register', {
        value: function () {
          post({ type: 'console', level: 'info', text: 'ZipRun: service worker registration skipped in preview.' });
          return Promise.resolve({ unregister: function () { return Promise.resolve(true); }, addEventListener: function () {} });
        },
      });
    }
  } catch (e) {}

  function sendLocation() {
    post({ type: 'location', path: location.pathname + location.search + location.hash, title: document.title });
  }
  ['pushState', 'replaceState'].forEach(function (k) {
    var orig = history[k];
    history[k] = function () {
      var r = orig.apply(this, arguments);
      setTimeout(sendLocation, 0);
      return r;
    };
  });
  window.addEventListener('popstate', sendLocation);
  window.addEventListener('hashchange', sendLocation);
  window.addEventListener('DOMContentLoaded', sendLocation);
  window.addEventListener('load', function () {
    sendLocation();
    var nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
    post({ type: 'ready', loadMs: nav ? Math.round(nav.loadEventStart || nav.domContentLoadedEventEnd) : null });
  });

  function onCommand(data) {
    if (!data || !data.__ziprunCmd) return;
    if (data.cmd === 'eval') {
      try {
        var result = (0, eval)(data.code);
        if (result && typeof result.then === 'function') {
          result.then(function (v) { post({ type: 'console', level: 'result', text: fmt(v, 1) }); },
            function (e) { post({ type: 'console', level: 'error', text: fmt(e) }); });
        } else {
          post({ type: 'console', level: 'result', text: fmt(result, 1) });
        }
      } catch (e) {
        post({ type: 'console', level: 'error', text: fmt(e) });
      }
    } else if (data.cmd === 'navigate') {
      location.href = data.path;
    } else if (data.cmd === 'back') {
      history.back();
    } else if (data.cmd === 'forward') {
      history.forward();
    } else if (data.cmd === 'reload') {
      location.reload();
    } else if (data.cmd === 'outline') {
      post({ type: 'outline', id: data.id, text: outline() });
    } else if (data.cmd === 'css') {
      var path = data.path;
      document.querySelectorAll('link[rel="stylesheet"]').forEach(function (l) {
        try {
          var u = new URL(l.href, location.href);
          if (u.origin === location.origin && u.pathname === path) {
            u.searchParams.set('zr', Date.now());
            l.href = u.toString();
          }
        } catch (e) {}
      });
      document.querySelectorAll('style[data-zr-file="' + path + '"]').forEach(function (s) {
        fetch(path, { cache: 'no-store' }).then(function (r) { return r.text(); }).then(function (t) { s.textContent = t; });
      });
    }
  }
  // Compact description of the rendered page, used by the AI design review.
  function outline() {
    var lines = [];
    var count = 0;
    var bs = getComputedStyle(document.body);
    lines.push('title: ' + document.title + ' | viewport: ' + innerWidth + 'x' + innerHeight + ' | page height: ' + document.documentElement.scrollHeight);
    lines.push('body font: ' + bs.fontFamily + ' ' + bs.fontSize + ' | color: ' + bs.color + ' | background: ' + bs.backgroundColor);
    lines.push('images without alt: ' + document.querySelectorAll('img:not([alt])').length + ' | buttons without text: ' +
      [].filter.call(document.querySelectorAll('button'), function (b) { return !b.textContent.trim() && !b.getAttribute('aria-label'); }).length);
    function walk(el, depth) {
      if (count > 450 || depth > 12) return;
      var tag = el.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'svg', 'path', 'link', 'meta'].indexOf(tag) !== -1) {
        if (tag === 'svg') { lines.push(new Array(depth + 1).join('  ') + '<svg>'); count++; }
        return;
      }
      var r = el.getBoundingClientRect();
      var cls = typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\s+/).slice(0, 6).join('.') : '';
      var text = '';
      for (var i = 0; i < el.childNodes.length; i++) if (el.childNodes[i].nodeType === 3) text += el.childNodes[i].textContent;
      text = text.trim().replace(/\s+/g, ' ').slice(0, 70);
      var cs = getComputedStyle(el);
      var extra = (tag === 'button' || tag === 'a' || /^h[1-6]$/.test(tag)) ? ' {' + cs.fontSize + ', ' + cs.color + ' on ' + cs.backgroundColor + '}' : '';
      lines.push(new Array(depth + 1).join('  ') + '<' + tag + (el.id ? '#' + el.id : '') + cls + '> ' + Math.round(r.width) + 'x' + Math.round(r.height) + extra + (text ? ' "' + text + '"' : ''));
      count++;
      for (var j = 0; j < el.children.length; j++) walk(el.children[j], depth + 1);
    }
    walk(document.body, 0);
    return lines.join('\n').slice(0, 30000);
  }

  window.addEventListener('message', function (e) {
    if (top && e.source !== top) return;
    onCommand(e.data);
  });
  if (channel) channel.onmessage = function (e) { onCommand(e.data); };
})();

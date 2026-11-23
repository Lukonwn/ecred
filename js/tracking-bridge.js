(function () {
  var storageKey = 'ecred:utm';
  var cookieKey = 'ecred_attribution';
  var names = {
    utm_source: 'utmSource',
    utm_medium: 'utmMedium',
    utm_campaign: 'utmCampaign',
    utm_term: 'utmTerm',
    utm_content: 'utmContent',
    src: 'src',
    sck: 'sck'
  };

  function parse(value) {
    try {
      var parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      try {
        var decoded = JSON.parse(decodeURIComponent(value));
        return decoded && typeof decoded === 'object' ? decoded : {};
      } catch (_) {
        return {};
      }
    }
  }

  function existingCookie() {
    var prefix = cookieKey + '=';
    var item = document.cookie.split('; ').filter(function (part) {
      return part.indexOf(prefix) === 0;
    })[0];
    return item ? parse(item.slice(prefix.length)) : {};
  }

  function clean(source) {
    var result = {};
    Object.keys(names).forEach(function (queryKey) {
      var key = names[queryKey];
      if (typeof source[key] === 'string' && source[key].trim()) {
        result[key] = source[key].trim().slice(0, 255);
      }
    });
    return result;
  }

  var saved = existingCookie();
  try {
    saved = Object.assign({}, clean(parse(localStorage.getItem(storageKey) || '')), clean(saved));
  } catch (_) {
    saved = clean(saved);
  }

  var url = new URL(location.href);
  var incoming = {};
  Object.keys(names).forEach(function (queryKey) {
    var value = url.searchParams.get(queryKey);
    if (value) incoming[names[queryKey]] = value;
  });
  var tracking = Object.assign({}, saved, clean(incoming));
  if (!Object.keys(tracking).length) return;

  try {
    localStorage.setItem(storageKey, JSON.stringify(tracking));
  } catch (_) {}
  var host = location.hostname.toLowerCase();
  var domain = '';
  ['credconsulta.online', 'ecredhoje.online'].forEach(function (root) {
    if (host === root || host.endsWith('.' + root)) domain = '; Domain=' + root;
  });
  document.cookie = cookieKey + '=' + encodeURIComponent(JSON.stringify(tracking)) +
    '; Path=/; Max-Age=1209600; SameSite=Lax' +
    (location.protocol === 'https:' ? '; Secure' : '') + domain;

  // Preserve the campaign in every same-origin SPA route, including routes
  // that do not call the app's existing tracking-aware link helper.
  ['pushState', 'replaceState'].forEach(function (method) {
    var original = history[method];
    if (typeof original !== 'function') return;
    history[method] = function () {
      if (arguments.length > 2 && arguments[2] != null) {
        try {
          var destination = new URL(String(arguments[2]), location.href);
          if (destination.origin === location.origin) {
            Object.keys(names).forEach(function (queryKey) {
              var value = tracking[names[queryKey]];
              if (value && !destination.searchParams.has(queryKey)) {
                destination.searchParams.set(queryKey, value);
              }
            });
            arguments[2] = destination.pathname + destination.search + destination.hash;
          }
        } catch (_) {}
      }
      return original.apply(this, arguments);
    };
  });

  // The Utmify pixel reads the page URL. Restore attribution before it loads
  // when navigation crosses the www and apex hosts.
  if (!Object.keys(incoming).length) {
    Object.keys(names).forEach(function (queryKey) {
      var value = tracking[names[queryKey]];
      if (value && !url.searchParams.has(queryKey)) url.searchParams.set(queryKey, value);
    });
    if (url.href !== location.href) history.replaceState(history.state, '', url.href);
  }
})();

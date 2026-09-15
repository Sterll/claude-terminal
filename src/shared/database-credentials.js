'use strict';

/** Keep MongoDB credentials out of persisted connection strings, including multi-host URIs. */
function splitConnectionSecrets(connection) {
  const { password: supplied, ...config } = connection;
  let password = supplied;
  if (typeof config.connectionString === 'string') {
    config.connectionString = config.connectionString.replace(/^(mongodb(?:\+srv)?:\/\/)([^/?#]+)/i, (match, scheme, authority) => {
      const at = authority.lastIndexOf('@');
      if (at < 0) return match;
      const auth = authority.slice(0, at);
      const colon = auth.indexOf(':');
      config.username = decodeURIComponent(colon < 0 ? auth : auth.slice(0, colon));
      if (colon >= 0 && password === undefined) password = decodeURIComponent(auth.slice(colon + 1));
      return scheme + authority.slice(at + 1);
    });
  }
  return { config, password };
}

module.exports = { splitConnectionSecrets };

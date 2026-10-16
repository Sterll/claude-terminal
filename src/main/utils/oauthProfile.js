/**
 * Who an OAuth token belongs to, asked of the API rather than of a config file.
 *
 * The CLI records the signed-in account as `oauthAccount` in `~/.claude.json`,
 * but that file describes the last `claude /login`, not the credentials in the
 * store: an account switch swaps the store and leaves `oauthAccount` naming the
 * previous account. `/api/oauth/profile` answers for the token itself, which is
 * the only identity safe to file an account under. The CLI calls the same
 * endpoint to fill `oauthAccount` in the first place.
 */

const https = require('https');

const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';
const TIMEOUT_MS = 5000;

/**
 * @param {Object} json - the endpoint's body
 * @returns {{ accountUuid: string, email: string|null, organizationUuid: string|null }|null}
 */
function parseProfile(json) {
  const accountUuid = json?.account?.uuid;
  if (typeof accountUuid !== 'string' || !accountUuid) return null;
  const email = json.account.email ?? json.account.email_address;
  const organizationUuid = json.organization?.uuid;
  return {
    accountUuid,
    email: typeof email === 'string' && email ? email : null,
    organizationUuid: typeof organizationUuid === 'string' && organizationUuid ? organizationUuid : null,
  };
}

/**
 * The account and organisation a token signs in as.
 *
 * Never rejects: the identity only names an account and catches a duplicate,
 * so a refused token, a timeout or an unexpected body all answer null and the
 * caller carries on without it.
 *
 * @param {string|null} token - an OAuth access token
 * @returns {Promise<{ accountUuid: string, email: string|null, organizationUuid: string|null }|null>}
 */
function fetchOAuthIdentity(token) {
  if (!token) return Promise.resolve(null);
  return new Promise((resolve) => {
    const url = new URL(PROFILE_URL);
    let req;
    try {
      req = https.get({
        hostname: url.hostname,
        path: url.pathname,
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
          'anthropic-beta': OAUTH_BETA_HEADER,
        },
        timeout: TIMEOUT_MS,
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) return resolve(null);
          try {
            resolve(parseProfile(JSON.parse(body)));
          } catch {
            resolve(null);
          }
        });
        res.on('error', () => resolve(null));
      });
    } catch {
      return resolve(null);
    }
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

module.exports = { fetchOAuthIdentity, parseProfile };

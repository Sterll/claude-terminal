/**
 * Contract fixture for the fake tracker. Every adapter needs one, named
 * `<id>.fixture.js`, and `contract.test.js` fails without it.
 *
 * - `secret`     a credential the fixture's `fetch` accepts
 * - `fetch`      stands in for the network: answer the adapter's requests with
 *                recorded responses, and with a 401 for any other secret
 * - `unknownKey` a key the fixture answers "not found" for
 *
 * The fake never touches the network, so its `fetch` only fails loudly.
 */

'use strict';

module.exports = {
  secret: 'fake-secret',
  unknownKey: '#999999',
  fetch: async (url) => {
    throw new Error(`the fake tracker should not fetch ${url}`);
  },
};

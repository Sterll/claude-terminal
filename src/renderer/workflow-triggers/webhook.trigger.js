'use strict';

module.exports = {
  type: 'webhook',
  label: 'Webhook (HTTP POST)',
  fields: [
    {
      type: 'hint',
      key: '_wh_hint',
      text: 'Ce workflow se déclenche via un POST HTTP depuis un service externe (GitHub, Stripe, etc.).',
    },
  ],
};
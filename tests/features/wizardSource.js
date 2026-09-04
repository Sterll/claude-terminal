/**
 * Shared plumbing for the setup wizard tests.
 *
 * The wizard ships as an inline script inside setup-wizard.html, so rather
 * than re-implementing its functions here (which would test the copy, not the
 * shipped code), the real source is extracted from the HTML and evaluated
 * against actual DOM nodes with its dependencies injected.
 */

const fs = require('fs');
const path = require('path');

const WIZARD_HTML = path.resolve(__dirname, '../../setup-wizard.html');

/**
 * @returns {string} the shipped wizard HTML
 */
function readWizardHtml() {
  return fs.readFileSync(WIZARD_HTML, 'utf8');
}

/**
 * Pull a top-level function's full source out of a file by brace matching.
 * @param {string} source
 * @param {string} signature - e.g. 'function goToStep(step) {'
 * @returns {string}
 */
function extractFunction(source, signature) {
  const start = source.indexOf(signature);
  if (start === -1) throw new Error(`Not found in setup-wizard.html: ${signature}`);

  let depth = 0;
  for (let i = start + signature.length - 1; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`Unbalanced braces while extracting: ${signature}`);
}

/**
 * The wizard's own step count, read from the shipped script so these tests
 * cannot drift from it when a step is added or removed.
 * @param {string} source
 * @returns {number}
 */
function readTotalSteps(source) {
  const match = /const TOTAL_STEPS = (\d+);/.exec(source);
  if (!match) throw new Error('TOTAL_STEPS not found in setup-wizard.html');
  return Number(match[1]);
}

/**
 * Mount the wizard's real markup — every step, every input, no script — into
 * the jsdom document, so extracted functions run against the shipped DOM.
 * @param {string} source
 */
function mountWizardMarkup(source) {
  const body = /<body>([\s\S]*?)<script>/.exec(source);
  if (!body) throw new Error('Could not locate the wizard body in setup-wizard.html');
  document.body.innerHTML = body[1];
}

module.exports = { readWizardHtml, extractFunction, readTotalSteps, mountWizardMarkup };

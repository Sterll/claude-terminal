/**
 * Regression tests for the setup wizard step navigation.
 *
 * The wizard ships as an inline script inside setup-wizard.html, so rather
 * than re-implementing goToStep() here (which would test the copy, not the
 * shipped code), the real function source is extracted from the HTML and
 * evaluated against actual DOM nodes with its dependencies injected.
 *
 * Guards issue #75: backward navigation used to call classList.add('') on the
 * outgoing step, which throws a DOMException. That aborted goToStep() halfway,
 * leaving the wizard blank, the counter frozen, and the next click skipping a
 * step because currentStep had never been updated.
 */

const fs = require('fs');
const path = require('path');

const WIZARD_HTML = path.resolve(__dirname, '../../setup-wizard.html');

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

const TOTAL_STEPS = 8;

/**
 * Build a wizard harness running the real goToStep() over real DOM nodes.
 */
function createWizard() {
  const html = fs.readFileSync(WIZARD_HTML, 'utf8');
  const goToStepSource = extractFunction(html, 'function goToStep(step) {');

  document.body.innerHTML = Array.from(
    { length: TOTAL_STEPS },
    (_, i) => `<div class="step${i === 0 ? ' active' : ''}" data-step="${i}"></div>`
  ).join('');

  const steps = document.querySelectorAll('.step');
  const summaryBuilds = [];

  // Run the rAF callback synchronously so assertions see the settled DOM.
  const raf = cb => { cb(); return 0; };

  const factory = new Function(
    'steps',
    'TOTAL_STEPS',
    'buildSummary',
    'updateUI',
    'requestAnimationFrame',
    `let currentStep = 0;
     ${goToStepSource}
     return { goToStep, getCurrentStep: () => currentStep };`
  );

  const wizard = factory(
    steps,
    TOTAL_STEPS,
    () => summaryBuilds.push(true),
    () => {},
    raf
  );

  return { ...wizard, steps, summaryBuilds };
}

/** Indices of every step currently rendered as active. */
function activeIndices(steps) {
  return Array.from(steps).flatMap((el, i) => (el.classList.contains('active') ? [i] : []));
}

describe('setup wizard navigation', () => {
  test('moving forward advances the step and shows exactly one page', () => {
    const w = createWizard();
    w.goToStep(1);
    expect(w.getCurrentStep()).toBe(1);
    expect(activeIndices(w.steps)).toEqual([1]);
  });

  test('moving backward advances the step back instead of throwing', () => {
    const w = createWizard();
    w.goToStep(1);
    w.goToStep(0);
    expect(w.getCurrentStep()).toBe(0);
  });

  test('moving backward never leaves the wizard on a blank page', () => {
    const w = createWizard();
    w.goToStep(1);
    w.goToStep(0);
    // The reported symptom: the outgoing step lost .active but the incoming
    // one never gained it, so nothing was rendered at all.
    expect(activeIndices(w.steps)).toEqual([0]);
  });

  test('back then next returns to the same step rather than skipping one', () => {
    const w = createWizard();
    // Walk to step index 1, the point the bug report starts from.
    w.goToStep(1);

    // "Back" then "Next", the way the buttons compute their target.
    w.goToStep(w.getCurrentStep() - 1);
    w.goToStep(w.getCurrentStep() + 1);

    expect(w.getCurrentStep()).toBe(1);
    expect(activeIndices(w.steps)).toEqual([1]);
  });

  test('walking the whole wizard backward keeps one page visible throughout', () => {
    const w = createWizard();
    for (let i = 1; i < TOTAL_STEPS; i++) w.goToStep(i);
    expect(w.getCurrentStep()).toBe(TOTAL_STEPS - 1);

    for (let i = TOTAL_STEPS - 2; i >= 0; i--) {
      w.goToStep(i);
      expect(w.getCurrentStep()).toBe(i);
      expect(activeIndices(w.steps)).toEqual([i]);
    }
  });

  test('the exit-left animation class only applies going forward', () => {
    const w = createWizard();
    w.goToStep(1);
    expect(w.steps[0].classList.contains('exit-left')).toBe(true);

    w.goToStep(0);
    // Step 1 leaves to the right, so it must not carry the left-exit class.
    expect(w.steps[1].classList.contains('exit-left')).toBe(false);
  });

  test('out-of-range targets are ignored', () => {
    const w = createWizard();
    w.goToStep(-1);
    expect(w.getCurrentStep()).toBe(0);
    w.goToStep(TOTAL_STEPS);
    expect(w.getCurrentStep()).toBe(0);
    expect(activeIndices(w.steps)).toEqual([0]);
  });

  test('the summary is built when the last step is reached', () => {
    const w = createWizard();
    for (let i = 1; i < TOTAL_STEPS; i++) w.goToStep(i);
    expect(w.summaryBuilds).toHaveLength(1);
  });
});

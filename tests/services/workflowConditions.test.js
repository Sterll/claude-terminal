/** @jest-environment node */
const condition = require('../../src/main/workflow-nodes/condition.node');
describe('structured workflow conditions', () => {
  test.each([
    ['', 'is_empty', '', true], ['', 'is_not_empty', '', false],
    [[], 'is_empty', '', true], [{}, 'is_empty', '', true],
    ['1.2.3', '==', '1.2.4', false], ['5.0', '==', '5', true],
    ['text == injection', '==', 'text == injection', true],
    ['a contains b', 'contains', 'contains', true],
  ])('keeps typed operands %p %s %p', async (left, operator, value, expected) => {
    const vars = new Map([['left', left]]);
    expect(await condition.run({ _condMode: 'builder', variable: '$left', operator, value }, vars))
      .toEqual({ result: expected, value: expected });
  });
});

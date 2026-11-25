// Workbook formulas (D232): addresses, precedence, functions over ranges and other sheets,
// lookups, cycles and parse errors shown in the cell, live values read like typed ones.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellName, columnIndex, columnName, display, parse, recalculate, key } from '../../src/services/workspace/formula.service.ts';

const at = (values: Map<string, unknown>, sheet: string, name: string) => {
  const m = /^([A-Z]+)(\d+)$/.exec(name)!;
  return values.get(key(sheet, columnIndex(m[1]!), Number(m[2]) - 1));
};

test('columns and cells by name', () => {
  assert.deepEqual([columnName(0), columnName(25), columnName(26), columnName(701), columnIndex('AA'), cellName(2, 9)], ['A', 'Z', 'AA', 'ZZ', 26, 'C10']);
});

test('arithmetic, precedence, text, comparison, percentages', () => {
  const v = recalculate([{ name: 'S', cells: {
    A1: '2', A2: '3', A3: '=A1+A2*4', A4: '=(A1+A2)*4', A5: '=-A1^2', A6: '="a"&A1', A7: '=A1<A2', A8: '=50%*A2', A9: '=A1/0', A10: '="x"+1',
  } }], '2026-11-23');
  assert.deepEqual(['A3', 'A4', 'A5', 'A6', 'A7', 'A8'].map((c) => at(v, 'S', c)), [14, 20, 4, 'a2', true, 1.5]);
  assert.deepEqual([at(v, 'S', 'A9'), at(v, 'S', 'A10')], [{ error: '#DIV/0!' }, { error: '#VALUE!' }]);
});

test('functions over ranges, conditions and lookups; another sheet; an unknown function', () => {
  const v = recalculate([
    { name: 'Data', cells: { A1: 'north', B1: '10', A2: 'south', B2: '20', A3: 'north', B3: '5', A4: 'east', B4: 'n/a' } },
    { name: 'Sum', cells: {
      A1: '=SUM(Data!B1:B4)', A2: '=AVERAGE(Data!B1:B3)', A3: '=SUMIF(Data!A1:A4,"north",Data!B1:B4)', A4: '=COUNTIF(Data!B1:B4,">8")',
      A5: '=VLOOKUP("south",Data!A1:B4,2)', A6: '=IF(A1>30,"big","small")', A7: '=IFERROR(VLOOKUP("west",Data!A1:B4,2),0)', A8: '=NOPE(1)',
      A9: '=ROUND(2.345,2)', A10: '=INDEX(Data!A1:B4,2,1)', A11: '=MATCH("east",Data!A1:A4)', A12: '=TODAY()', A13: '=Other!A1',
    } },
  ], '2026-11-23');
  assert.deepEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A9', 'A10', 'A11', 'A12'].map((c) => at(v, 'Sum', c)),
    [35, 35 / 3, 15, 2, 20, 'big', 0, 2.35, 'south', 4, '2026-11-23']);
  assert.deepEqual([at(v, 'Sum', 'A8'), at(v, 'Sum', 'A13')], [{ error: '#NAME?' }, { error: '#REF!' }]);
});

test('a cycle is #CYCLE!, never a loop; a formula that does not parse says so', () => {
  const v = recalculate([{ name: 'S', cells: { A1: '=B1+1', B1: '=A1+1', C1: '=A1', D1: '=SUM(1,', E1: '=1+' } }], '2026-11-23');
  assert.deepEqual(['A1', 'B1', 'C1', 'D1', 'E1'].map((c) => display(at(v, 'S', c) as never)), ['#CYCLE!', '#CYCLE!', '#CYCLE!', '#PARSE!', '#PARSE!']);
  assert.throws(() => parse('=SUM(A1:'), SyntaxError);
});

test('live values placed over the grid are read like typed ones', () => {
  const overlay = new Map([[key('S', 0, 0), 4], [key('S', 0, 1), 6]]);
  const v = recalculate([{ name: 'S', cells: { B1: '=SUM(A1:A2)' } }], '2026-11-23', overlay);
  assert.equal(at(v, 'S', 'B1'), 10);
});

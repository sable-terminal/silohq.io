// The ontology search scorer on its own (services/search/scoring.service.ts).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { score, similarity } from '../../src/services/search/scoring.service.ts';

describe('vocabulary scoring', () => {
  test('exact, then prefix, then a word, then every word, then inside, then near, then the description', () => {
    const name = (n: string) => score('order', { names: [n] });
    assert.equal(name('Order'), 1);
    assert.equal(name('Orders'), 0.9);
    assert.equal(name('Sales order'), 0.8);
    assert.equal(score('sales ord', { names: ['Open sales orders'] }), 0.7);
    assert.equal(name('Reorder level'), 0.6);
    assert.ok(name('Ordre') > 0 && name('Ordre') < 0.6, 'a typo still matches, below every exact kind');
    assert.equal(score('trade', { names: ['Company'], description: 'Who we trade with' }), 0.2);
    assert.equal(score('zebra', { names: ['Company'], description: 'Who we trade with' }), 0);
  });

  test('case, accents and api-name underscores do not matter', () => {
    assert.equal(score('cafe', { names: ['Café'] }), 1);
    assert.equal(score('purchase order', { names: ['purchase_order'.replaceAll('_', ' ')] }), 1);
    assert.equal(score('ORDER', { names: ['order'] }), 1);
  });

  test('similarity is trigram overlap, as pg_trgm\'s', () => {
    assert.equal(similarity('abc', 'abc'), 1);
    assert.equal(similarity('abc', 'xyz'), 0);
    assert.ok(similarity('company', 'compnay') > 0.3);
  });
});

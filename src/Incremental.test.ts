import { test } from 'uvu'
import * as assert from 'uvu/assert'

import { computeAffectedFiles } from './Incremental'

function sorted(values: Set<string>): string[] {
  return [...values].sort()
}

test('computeAffectedFiles marks transitive dependents of changed files', () => {
  const result = computeAffectedFiles({
    currentFiles: ['a.ts', 'b.ts', 'c.ts'],
    currentHashes: new Map([
      ['a.ts', 'hash-a-new'],
      ['b.ts', 'hash-b'],
      ['c.ts', 'hash-c'],
    ]),
    currentDependents: new Map([
      ['a.ts', new Set(['b.ts'])],
      ['b.ts', new Set(['c.ts'])],
    ]),
    previousHashes: new Map([
      ['a.ts', 'hash-a-old'],
      ['b.ts', 'hash-b'],
      ['c.ts', 'hash-c'],
    ]),
    previousDependents: new Map(),
    contextMatches: true,
  })

  assert.equal(sorted(result.affected), ['a.ts', 'b.ts', 'c.ts'])
  assert.equal(sorted(result.removed), [])
  assert.equal(sorted(result.unchanged), [])
})

test('computeAffectedFiles marks dependents of removed files', () => {
  const result = computeAffectedFiles({
    currentFiles: ['b.ts'],
    currentHashes: new Map([['b.ts', 'hash-b']]),
    currentDependents: new Map(),
    previousHashes: new Map([
      ['a.ts', 'hash-a'],
      ['b.ts', 'hash-b'],
    ]),
    previousDependents: new Map([['a.ts', new Set(['b.ts'])]]),
    contextMatches: true,
  })

  assert.equal(sorted(result.affected), ['b.ts'])
  assert.equal(sorted(result.removed), ['a.ts'])
  assert.equal(sorted(result.unchanged), [])
})

test('computeAffectedFiles invalidates all files when context does not match', () => {
  const result = computeAffectedFiles({
    currentFiles: ['a.ts', 'b.ts'],
    currentHashes: new Map([
      ['a.ts', 'hash-a'],
      ['b.ts', 'hash-b'],
    ]),
    currentDependents: new Map([['a.ts', new Set(['b.ts'])]]),
    previousHashes: new Map([
      ['a.ts', 'hash-a'],
      ['b.ts', 'hash-b'],
    ]),
    previousDependents: new Map(),
    contextMatches: false,
  })

  assert.equal(sorted(result.affected), ['a.ts', 'b.ts'])
  assert.equal(sorted(result.removed), [])
  assert.equal(sorted(result.unchanged), [])
})

test.run()

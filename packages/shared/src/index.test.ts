import assert from 'node:assert/strict'
import test from 'node:test'
import { GAME, cleanGuestName, radiusForMass, speedForMass } from './index.js'

test('guest names are bounded and sanitized', () => {
  assert.equal(cleanGuestName('  Player   One  '), 'Player One')
  assert.equal(cleanGuestName('<good>'), 'good')
  assert.equal(cleanGuestName('A'), null)
  assert.equal(cleanGuestName('x'.repeat(GAME.maxNameLength + 1)), null)
})

test('larger cells have larger radius but lower speed', () => {
  assert.ok(radiusForMass(400) > radiusForMass(100))
  assert.ok(speedForMass(400) < speedForMass(100))
})

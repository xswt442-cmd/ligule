import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createKernel, KernelError, VERSION } from '../src/index.js'

test('a fresh kernel provides no tools', () => {
  assert.deepEqual(createKernel().list(), [])
})

test('register shows up in list and returns a dispose action', () => {
  const kernel = createKernel()
  const dispose = kernel.register({ name: 'read', run: async () => 'ok' })
  assert.deepEqual(kernel.list(), ['read'])
  dispose()
  assert.deepEqual(kernel.list(), [])
})

test('a duplicate name throws instead of dropping the second one silently', () => {
  const kernel = createKernel()
  kernel.register({ name: 'read', run: async () => 'ok' })
  assert.throws(
    () => kernel.register({ name: 'read', run: async () => 'ok' }),
    (e) => e instanceof KernelError && e.code === 'tool_already_registered',
  )
})

test('calling an unregistered tool rejects with a code', async () => {
  await assert.rejects(
    createKernel().call('nope'),
    (e) => e.code === 'tool_not_found',
  )
})

test('VERSION matches package.json', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(VERSION, pkg.version)
})

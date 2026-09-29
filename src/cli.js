#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { createKernel } from './kernel.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const [command] = process.argv.slice(2)

if (command === '--version' || command === '-v') {
  console.log(pkg.version)
} else if (command === 'tools') {
  // Empty on a fresh install: the kernel ships no tools (I1).
  for (const name of createKernel().list()) console.log(name)
} else {
  console.log(`ligule ${pkg.version} - under development, do not depend on it.`)
}

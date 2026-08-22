import fs from 'node:fs'

const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'))
if (!pkg.dsh || !pkg.dsh.bundle) {
  console.error('package.json does not declare dsh.bundle')
  process.exit(1)
}
const patch = pkg.dsh.bundle.patch
if (!patch || !fs.existsSync(patch)) {
  console.error('bundle patch not found: ' + String(patch))
  process.exit(1)
}
const patchText = fs.readFileSync(patch, 'utf8')
if (patchText.trim().length === 0) {
  console.error(patch + ' is empty')
  process.exit(1)
}
console.log('OK: dsh.bundle -> ' + patch)

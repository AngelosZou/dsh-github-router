/**
 * Deterministic local install into a DSH profile without pnpm/network:
 * 1. add the link: dependency + bundle entry to the profile manifest,
 * 2. junction node_modules/<name> → this checkout,
 * 3. smoke-import the package from the profile directory.
 *
 * Usage: node scripts/install-profile.mjs <profileDir>
 * Equivalent to `dsh plugin --profile <p> add link:<this dir>` minus pnpm.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-github-router'
const pluginDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const profileDir = process.argv[2]

if (!profileDir || !existsSync(join(profileDir, 'package.json'))) {
  console.error('usage: node scripts/install-profile.mjs <profileDir with package.json>')
  process.exit(2)
}

const pkgPath = join(profileDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
pkg.dependencies ??= {}
pkg.dependencies[NAME] = 'link:' + pluginDir.replace(/\\/g, '/')
pkg.dsh ??= {}
pkg.dsh.profile ??= {}
pkg.dsh.profile.bundles ??= []
if (!pkg.dsh.profile.bundles.includes(NAME)) pkg.dsh.profile.bundles.push(NAME)
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
console.log('manifest updated:', pkgPath)

const linkPath = join(profileDir, 'node_modules', NAME)
if (!existsSync(linkPath)) {
  const result = spawnSync('cmd', ['/c', 'mklink', '/J', linkPath, pluginDir], { encoding: 'utf8' })
  if (result.status !== 0) {
    console.error('junction failed:', result.stdout, result.stderr)
    process.exit(1)
  }
  console.log('junction created:', linkPath)
} else {
  console.log('junction already present:', linkPath)
}

const smoke = spawnSync(
  process.execPath,
  ['--input-type=module', '-e', `import(${JSON.stringify(NAME)}).then(m => console.log('SMOKE', m.name, JSON.stringify(m.inject)))`],
  { cwd: profileDir, encoding: 'utf8', timeout: 30000 },
)
process.stdout.write(smoke.stdout ?? '')
process.stderr.write(smoke.stderr ?? '')
process.exit(smoke.status ?? 0)

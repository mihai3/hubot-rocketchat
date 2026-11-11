/**
 * Bundles the @rocket.chat/sdk mobile source into a self-contained ESM
 * module the adapter can import at runtime (vendor/rocketchat-sdk.mjs).
 *
 * The 2.0.0-mobile SDK ships TypeScript source with extensionless imports,
 * which Node cannot execute directly, and it is not published to npm. This
 * script is run by the `prepare` lifecycle hook and the resulting bundle is
 * committed, so registry installs need no build step.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import path from 'node:path'
import esbuild from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

// Prefer the local git clone of the SDK when available (development),
// otherwise use the copy installed from git by npm
const candidates = [
  path.resolve(root, '..', 'Rocket.Chat.js.SDK', 'index.ts'),
  path.resolve(root, 'node_modules', '@rocket.chat', 'sdk', 'index.ts')
]
const entry = candidates.find((candidate) => existsSync(candidate))
if (!entry) {
  console.error('Unable to find @rocket.chat/sdk source (looked in:\n  ' + candidates.join('\n  ') + ')')
  process.exit(1)
}
console.log(`Bundling @rocket.chat/sdk from ${entry}`)

await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: path.join(root, 'vendor', 'rocketchat-sdk.mjs'),
  banner: {
    // Let the bundle's CommonJS interop require() Node builtins and
    // modules at runtime instead of failing on esbuild's static shim
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
  },
  logLevel: 'info'
})

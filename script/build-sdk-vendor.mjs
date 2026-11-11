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

// Source resolution order:
//   1. RC_SDK_PATH env override (explicit pin for local development)
//   2. the copy installed from git by npm (tracks the #mobile branch tip)
//   3. a sibling git clone of the SDK repo, as a last resort — this may be
//      stale, which would silently drop fixes from the vendored bundle
const candidates = [
  process.env.RC_SDK_PATH,
  path.resolve(root, 'node_modules', '@rocket.chat', 'sdk', 'index.ts'),
  path.resolve(root, '..', 'Rocket.Chat.js.SDK', 'index.ts')
].filter(Boolean)
const entry = candidates.find((candidate) => existsSync(candidate))
if (!entry) {
  console.error('Unable to find @rocket.chat/sdk source (looked in:\n  ' + candidates.join('\n  ') + ')')
  process.exit(1)
}
console.log(`Bundling @rocket.chat/sdk from ${entry}`)

let result = await esbuild.build({
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
  write: false,
  logLevel: 'info'
})

// The upstream fix (Rocket.Chat.js.SDK mobile, "fix: omit WebSocket
// subprotocols instead of passing null") passes `undefined` protocols to
// the WebSocket constructor; `ws` wraps a `null` in an array and rejects
// it as an invalid subprotocol. Until the fix is merged upstream, apply
// it here so bundles built from any SDK vintage work.
const broken = /(new \w+\.default\(this\.host,) null, \{ headers: (?:settings\.)?customHeaders \}\)/
let patched = false
for (const file of result.outputFiles) {
  if (broken.test(file.text)) {
    file.contents = new TextEncoder().encode(file.text.replace(broken, '$1 void 0, { headers: customHeaders })'))
    patched = true
  }
}
if (!patched) {
  console.error('Expected the null-protocols WebSocket bug pattern in the bundle; either it is fixed upstream (remove this patch) or the SDK source changed shape (investigate).')
  process.exit(1)
}

const { writeFile, mkdir } = await import('node:fs/promises')
const outfile = path.join(root, 'vendor', 'rocketchat-sdk.mjs')
await mkdir(path.dirname(outfile), { recursive: true })
await writeFile(outfile, result.outputFiles[0].contents)

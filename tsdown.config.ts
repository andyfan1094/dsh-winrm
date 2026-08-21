/**
 * Self-contained build config for dsh-winrm, mirroring the dsh-web-ui family
 * preset (shared/tsdown.client.ts) without the repository:
 *   - node half lib/ (host engine + routes + tools) as ESM;
 *   - browser bundle lib/client.js as a closure-factory artifact the GUI's
 *     __ModuleLoader__ consumes: window.__ModuleLoader__.load({id, factory}),
 *     externals resolved through the loader's injected require (platform
 *     module table), CSS Modules compiled by lightningcss with the hashed
 *     class map and an auto-injected <style data-plugin> tag.
 */
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve as resolvePath, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Plugin id (package name), stamped into the loader handoff and style tags. */
const PKG_ID = 'dsh-winrm'

/** Browser platform modules the shell shares into the frozen module table. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** Documented runtime exemption (snapshot-store engine, see preset notes). */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** Externals answered by the loader module table. */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

/** SDK packages the host half imports at runtime from the profile tree. */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-settings',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  'schemastery',
]

/** Virtual-id wrapper keeping module CSS away from tsdown's own css pipeline. */
const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

/** Compile one *.module.css into a JS module: hashed class map + injected style. */
const cssModulePlugin = {
  name: 'dsh-winrm-css-modules',
  resolveId(source: string, importer?: string): string | null {
    if (!source.endsWith('.module.css')) return null
    const physical = resolvePath(dirname(importer ?? process.cwd()), source)
    return CSS_VIRTUAL_PREFIX + physical + CSS_VIRTUAL_SUFFIX
  },
  async load(id: string): Promise<string | null> {
    if (!id.startsWith(CSS_VIRTUAL_PREFIX)) return null
    const physical = id.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
    const code = await readFile(physical, 'utf8')
    const result = transform({
      filename: physical,
      code: Buffer.from(code),
      minify: true,
      cssModules: true,
    })
    const cssText = result.code.toString()
    const map: Record<string, string> = {}
    for (const [key, value] of Object.entries(result.exports ?? {})) {
      map[key] = String((value as { name?: unknown }).name ?? '')
    }
    const tagId = PKG_ID + '/' + relative(process.cwd(), physical).split(sep).join('/')
    return [
      'const css = ' + JSON.stringify(cssText) + ';',
      'const tagId = ' + JSON.stringify(tagId) + ';',
      'if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {',
      '  const tag = document.createElement("style");',
      '  tag.dataset.plugin = ' + JSON.stringify(PKG_ID) + ';',
      '  tag.dataset.pluginCss = tagId;',
      '  tag.textContent = css;',
      '  document.head.appendChild(tag);',
      '}',
      'export default ' + JSON.stringify(map) + ';',
      '',
    ].join('\n')
  },
}

/** Node half: host engine, routes, tools (ESM, SDK packages external). */
const lib: UserConfig = {
  name: PKG_ID,
  entry: ['src/index.ts', 'src/invariant.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  external: HOST_EXTERNALS,
}

/** Browser half: closure-factory artifact for the GUI module loader. */
const client: UserConfig = {
  name: PKG_ID + '/client',
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  sourcemap: true,
  clean: false,
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => (CLIENT_EXTERNALS.includes(id) ? undefined : true),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [cssModulePlugin],
  outputOptions: { entryFileNames: 'client.cjs' },
}

export default existsSync('src/client/index.ts') ? [lib, client] : [lib]

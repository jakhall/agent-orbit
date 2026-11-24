// Local-only by design: binds 127.0.0.1, checks Host and Origin, and every API call needs the run's token.

import { MOD_VERSION } from '../shared/constants.js'
import { clear, launch } from './lib/lifecycle.mjs'
import { prune } from './lib/prune.mjs'
import { IS_MAIN, opts, print } from './lib/runtime.mjs'
import { serve } from './lib/serve.mjs'

export { parseArgs } from './lib/runtime.mjs'

async function main() {
  if (opts.mode === 'launch') await launch()
  else if (opts.mode === 'serve') await serve()
  else if (opts.mode === 'prune') prune()
  else if (opts.mode === 'clear') await clear()
  else if (opts.mode === 'version') print({ ok: true, version: MOD_VERSION })
  else {
    print({ ok: false, message: 'usage: server.mjs --launch [--no-window]|--serve|--prune|--clear|--version --data <dir> [--dry-run [--projects <dir>]]' })
    process.exitCode = 2
  }
}

if (IS_MAIN) await main()

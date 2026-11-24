import fs from 'node:fs'
import path from 'node:path'

const READ_MAX_BYTES = 4 * 1024 * 1024

function kindOf(stat) {
  if (!stat) return 'other'
  if (stat.isDirectory()) return 'dir'
  return stat.isFile() ? 'file' : 'other'
}

async function describe(file) {
  const link = await fs.promises.lstat(file)
  const isLink = link.isSymbolicLink()
  const target = isLink ? await fs.promises.stat(file).catch(() => null) : link
  return { kind: kindOf(target), size: target?.size ?? 0, mtimeMs: target?.mtimeMs ?? 0, isLink }
}

/**
 * The part of the engine's `$` the aggregation code in `shared/aggregate/`
 * uses (`fs.list`, `read`, `stat`, `exists`), on Node, with the engine's
 * limits: reads refuse files over 4 MiB and answer text.
 */
export function nodeHost() {
  return {
    fs: {
      async list(dir) {
        const names = await fs.promises.readdir(dir)
        const entries = await Promise.all(names.map(async name => ({ name, ...(await describe(path.join(dir, name)).catch(() => ({ kind: 'other', size: 0, mtimeMs: 0, isLink: false }))) })))
        return entries
      },
      async read(file) {
        const stat = await fs.promises.stat(file)
        if (stat.size > READ_MAX_BYTES) throw Object.assign(new Error('file too large to read'), { code: 'EFBIG' })
        return fs.promises.readFile(file, 'utf8')
      },
      stat: describe,
      async exists(file) {
        return fs.promises.access(file).then(
          () => true,
          () => false,
        )
      },
    },
  }
}

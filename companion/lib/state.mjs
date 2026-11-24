function jsonOrNull(text) {
  try {
    JSON.parse(text)
    return text
  } catch {
    return 'null'
  }
}

/**
 * The body of `GET /api/state`: the snapshot (unless only prefs were asked
 * for), the prefs, and the stamps the page records as seen. The stamps are
 * taken before the reads, so they are never newer than what was read.
 * @param {{ readText: (file: string) => Promise<string>, takeStamps: () => object, files: { snapshot: string, prefs: string }, wantsSnapshot: boolean }} io
 */
export async function stateAnswer({ readText, takeStamps, files, wantsSnapshot }) {
  const stamps = takeStamps()
  const read = file => readText(file).catch(() => 'null')
  const [snapshot, prefs] = await Promise.all([wantsSnapshot ? read(files.snapshot) : Promise.resolve('null'), read(files.prefs)])
  return `{"snapshot":${jsonOrNull(snapshot)},"prefs":${jsonOrNull(prefs)},"stamps":${JSON.stringify(stamps)}}`
}

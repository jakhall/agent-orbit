import { expect, test } from 'claude-code/testing'

import { parsePorcelainV2Z } from '../shared/changes.js'

const NUL = String.fromCodePoint(0)
const z = (...fields: string[]) => fields.join(NUL) + NUL
const SHA = 'a'.repeat(40)
const ordinary = (xy: string, path: string) => `1 ${xy} N... 100644 100644 100644 ${SHA} ${SHA} ${path}`

test('porcelain v2 with --branch gives the branch, HEAD, upstream counts and the entries in one git call (E-115)', () => {
  const text = z(
    `# branch.oid ${SHA}`,
    '# branch.head feature/login',
    '# branch.upstream origin/feature/login',
    '# branch.ab +3 -1',
    ordinary('.M', 'a.txt'),
    ordinary('A.', 'b.txt'),
    `2 R. N... 100644 100644 100644 ${SHA} ${SHA} R100 new name.txt`,
    'old name.txt',
    `u UU N... 100644 100644 100644 100644 ${SHA} ${SHA} ${SHA} conflict.txt`,
    '? c.txt',
    '? with space.txt',
    '! ignored.log',
  )
  expect(parsePorcelainV2Z(text)).toEqual({
    branch: 'feature/login',
    hasHead: true,
    upstream: { ahead: 3, behind: 1 },
    status: [
      { code: ' M', path: 'a.txt', oldPath: null },
      { code: 'A ', path: 'b.txt', oldPath: null },
      { code: 'R ', path: 'new name.txt', oldPath: 'old name.txt' },
      { code: 'UU', path: 'conflict.txt', oldPath: null },
      { code: '??', path: 'c.txt', oldPath: null },
      { code: '??', path: 'with space.txt', oldPath: null },
    ],
  })
})

test('porcelain v2: a repository without a commit, a detached HEAD, no upstream, unicode and spaces in paths', () => {
  expect(parsePorcelainV2Z(z('# branch.oid (initial)', '# branch.head main', ordinary('A.', 'a.txt')))).toEqual({ branch: 'main', hasHead: false, upstream: null, status: [{ code: 'A ', path: 'a.txt', oldPath: null }] })
  expect(parsePorcelainV2Z(z(`# branch.oid ${SHA}`, '# branch.head (detached)', ordinary('.M', 'ünï dir/f.txt')))).toEqual({ branch: 'detached', hasHead: true, upstream: null, status: [{ code: ' M', path: 'ünï dir/f.txt', oldPath: null }] })
  expect(parsePorcelainV2Z('')).toEqual({ branch: null, hasHead: false, upstream: null, status: [] })
})

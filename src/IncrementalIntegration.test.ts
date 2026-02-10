import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { test } from 'uvu'
import * as assert from 'uvu/assert'

import { MultiProjectOptions } from './CommandLineOptions'
import { indexCommand } from './main'

interface CachedFileState {
  hash: string
  blob: string
  dependents: string[]
}

interface Manifest {
  schemaVersion: number
  contextHash: string
  files: Record<string, CachedFileState>
}

function makeTempProjectFromFixture(): { root: string; output: string } {
  const fixtureRoot = path.join(
    process.cwd(),
    'fixtures',
    'incremental-dummy'
  )
  if (!fs.existsSync(fixtureRoot)) {
    throw new Error(`missing fixture directory: ${fixtureRoot}`)
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scip-ts-incremental-'))
  fs.cpSync(fixtureRoot, root, { recursive: true })
  return {
    root,
    output: path.join(root, 'index.scip'),
  }
}

function runIncrementalIndex(root: string, output: string): void {
  const options: MultiProjectOptions = {
    cwd: root,
    inferTsconfig: false,
    output,
    yarnWorkspaces: false,
    yarnBerryWorkspaces: false,
    pnpmWorkspaces: false,
    progressBar: false,
    indexedProjects: new Set(),
    globalCaches: true,
    maxFileByteSize: '1mb',
    maxFileByteSizeNumber: 1024 * 1024,
    incremental: true,
  }
  indexCommand([], options)
}

function findManifestFile(incrementalRoot: string): string {
  const stack = [incrementalRoot]
  while (stack.length > 0) {
    const current = stack.pop()
    if (current === undefined) {
      continue
    }
    if (!fs.existsSync(current)) {
      continue
    }
    const stat = fs.statSync(current)
    if (!stat.isDirectory()) {
      continue
    }
    for (const entry of fs.readdirSync(current)) {
      const child = path.join(current, entry)
      if (entry === 'manifest.json') {
        return child
      }
      stack.push(child)
    }
  }
  throw new Error(`missing manifest.json under ${incrementalRoot}`)
}

function readManifest(output: string): Manifest {
  const incrementalRoot = `${output}.incremental`
  const manifestPath = findManifestFile(incrementalRoot)
  return JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as Manifest
}

function findFileState(
  manifest: Manifest,
  suffix: string
): [string, CachedFileState] {
  for (const entry of Object.entries(manifest.files)) {
    if (entry[0].endsWith(suffix)) {
      return entry
    }
  }
  throw new Error(`expected manifest file ending with ${suffix}`)
}

test('incremental indexing creates persistent manifest state', () => {
  const fixture = makeTempProjectFromFixture()
  try {
    runIncrementalIndex(fixture.root, fixture.output)
    const manifest = readManifest(fixture.output)
    assert.is(manifest.schemaVersion, 1)
    assert.ok(typeof manifest.contextHash === 'string')
    const [aPath] = findFileState(manifest, path.join('src', 'a.ts'))
    const [bPath] = findFileState(manifest, path.join('src', 'b.ts'))
    assert.ok(aPath.length > 0)
    assert.ok(bPath.length > 0)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('incremental indexing reuses cache when nothing changed', () => {
  const fixture = makeTempProjectFromFixture()
  try {
    runIncrementalIndex(fixture.root, fixture.output)
    const firstOutput = fs.readFileSync(fixture.output)
    const firstManifest = readManifest(fixture.output)
    runIncrementalIndex(fixture.root, fixture.output)
    const secondOutput = fs.readFileSync(fixture.output)
    const secondManifest = readManifest(fixture.output)

    assert.equal(secondOutput, firstOutput)
    assert.equal(secondManifest.files, firstManifest.files)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('incremental indexing reindexes dependents of changed files', () => {
  const fixture = makeTempProjectFromFixture()
  try {
    runIncrementalIndex(fixture.root, fixture.output)
    const firstManifest = readManifest(fixture.output)
    const [firstAPath, firstAState] = findFileState(
      firstManifest,
      path.join('src', 'a.ts')
    )
    const [firstBPath, firstBState] = findFileState(
      firstManifest,
      path.join('src', 'b.ts')
    )

    fs.writeFileSync(
      path.join(fixture.root, 'src', 'a.ts'),
      "export const value = 'changed'\nexport type SharedType = string\n"
    )
    runIncrementalIndex(fixture.root, fixture.output)

    const secondManifest = readManifest(fixture.output)
    const secondAState = secondManifest.files[firstAPath]
    const secondBState = secondManifest.files[firstBPath]

    assert.ok(secondAState !== undefined)
    assert.ok(secondBState !== undefined)
    assert.not.equal(secondAState.blob, firstAState.blob)
    assert.not.equal(secondBState.blob, firstBState.blob)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test('incremental indexing indexes new files without reindexing unchanged files', () => {
  const fixture = makeTempProjectFromFixture()
  try {
    runIncrementalIndex(fixture.root, fixture.output)
    const firstManifest = readManifest(fixture.output)
    const [firstAPath, firstAState] = findFileState(
      firstManifest,
      path.join('src', 'a.ts')
    )
    const [firstBPath, firstBState] = findFileState(
      firstManifest,
      path.join('src', 'b.ts')
    )

    fs.writeFileSync(
      path.join(fixture.root, 'src', 'c.ts'),
      "import { value, SharedType } from './a'\nexport const plusTwo: SharedType = value + 2\n"
    )
    runIncrementalIndex(fixture.root, fixture.output)

    const secondManifest = readManifest(fixture.output)
    const secondAState = secondManifest.files[firstAPath]
    const secondBState = secondManifest.files[firstBPath]
    const [, secondCState] = findFileState(secondManifest, path.join('src', 'c.ts'))

    assert.ok(secondAState !== undefined)
    assert.ok(secondBState !== undefined)
    assert.ok(secondCState !== undefined)
    assert.equal(secondAState.blob, firstAState.blob)
    assert.equal(secondBState.blob, firstBState.blob)
    assert.ok(secondCState.blob.length > 0)
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true })
  }
})

test.run()

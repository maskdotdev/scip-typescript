#!/usr/bin/env node
import * as child_process from 'child_process'
import { createHash } from 'crypto'
import * as fs from 'fs'
import { EOL } from 'os'
import * as path from 'path'
import * as url from 'url'

import * as ts from 'typescript'

import packageJson from '../package.json'

import {
  GlobalCache,
  mainCommand,
  MultiProjectOptions,
  ProjectOptions,
} from './CommandLineOptions'
import { computeAffectedFiles } from './Incremental'
import { inferTsconfig } from './inferTsconfig'
import { ProjectIndexer } from './ProjectIndexer'
import * as scip from './scip'

export function main(): void {
  mainCommand((projects, options) => indexCommand(projects, options)).parse(
    process.argv
  )
  return
}

export function indexCommand(
  projects: string[],
  options: MultiProjectOptions
): void {
  if (options.yarnWorkspaces) {
    projects.push(...listYarnWorkspaces(options.cwd, 'tryYarn1'))
  } else if (options.yarnBerryWorkspaces) {
    projects.push(...listYarnWorkspaces(options.cwd, 'yarn2Plus'))
  } else if (options.pnpmWorkspaces) {
    projects.push(...listPnpmWorkspaces(options.cwd))
  } else if (projects.length === 0) {
    projects.push(options.cwd)
  }
  options.cwd = makeAbsolutePath(process.cwd(), options.cwd)
  options.output = makeAbsolutePath(options.cwd, options.output)
  if (options.incremental) {
    options.incrementalRoot = `${options.output}.incremental`
  }
  if (!options.indexedProjects) {
    options.indexedProjects = new Set()
  }
  const output = fs.openSync(options.output, 'w')
  let documentCount = 0
  const writeIndex = (index: scip.scip.Index): void => {
    documentCount += index.documents.length
    fs.writeSync(output, index.serializeBinary())
  }

  const cache: GlobalCache = {
    sources: new Map(),
    parsedCommandLines: new Map(),
  }
  try {
    writeIndex(
      new scip.scip.Index({
        metadata: new scip.scip.Metadata({
          project_root: url.pathToFileURL(options.cwd).toString(),
          text_document_encoding: scip.scip.TextEncoding.UTF8,
          tool_info: new scip.scip.ToolInfo({
            name: 'scip-typescript',
            version: packageJson.version,
            arguments: [],
          }),
        }),
      })
    )
    // NOTE: we may want index these projects in parallel in the future.
    // We need to be careful about which order we index the projects because
    // they can have dependencies.
    for (const projectRoot of projects) {
      const projectDisplayName = projectRoot === '.' ? options.cwd : projectRoot
      indexSingleProject(
        {
          ...options,
          projectRoot,
          projectDisplayName,
          writeIndex,
        },
        cache
      )
    }
  } finally {
    fs.close(output)
    if (documentCount > 0) {
      console.log(`done ${options.output}`)
    } else {
      process.exitCode = 1
      fs.rmSync(options.output)
      const prettyProjects = JSON.stringify(projects)
      console.log(
        `error: no files got indexed. To fix this problem, make sure that the TypeScript projects ${prettyProjects} contain input files or reference other projects.`
      )
    }
  }
}

function makeAbsolutePath(cwd: string, relativeOrAbsolutePath: string): string {
  if (path.isAbsolute(relativeOrAbsolutePath)) {
    return relativeOrAbsolutePath
  }
  return path.resolve(cwd, relativeOrAbsolutePath)
}

function indexSingleProject(options: ProjectOptions, cache: GlobalCache): void {
  if (options.indexedProjects.has(options.projectRoot)) {
    return
  }

  options.indexedProjects.add(options.projectRoot)
  let config = ts.parseCommandLine(
    ['-p', options.projectRoot],
    (relativePath: string) => path.resolve(options.projectRoot, relativePath)
  )
  let tsconfigFileName: string | undefined
  if (config.options.project) {
    const projectPath = path.resolve(config.options.project)
    if (ts.sys.directoryExists(projectPath)) {
      tsconfigFileName = path.join(projectPath, 'tsconfig.json')
    } else {
      tsconfigFileName = projectPath
    }
    if (!ts.sys.fileExists(tsconfigFileName)) {
      if (options.inferTsconfig) {
        fs.writeFileSync(tsconfigFileName, inferTsconfig(projectPath))
      } else {
        console.error(`- ${options.projectDisplayName} (missing tsconfig.json)`)
        return
      }
    }
    const loadedConfig = loadConfigFile(tsconfigFileName)
    if (loadedConfig !== undefined) {
      config = loadedConfig
    }
  }

  for (const projectReference of config.projectReferences || []) {
    indexSingleProject(
      {
        ...options,
        projectRoot: projectReference.path,
        projectDisplayName: projectReference.path,
      },
      cache
    )
  }

  if (config.fileNames.length > 0) {
    const indexer = new ProjectIndexer(config, options, cache)
    if (!options.incremental) {
      indexer.index()
      return
    }
    indexSingleProjectIncremental(options, indexer, tsconfigFileName)
  }
}

interface IncrementalCachedFileState {
  hash: string
  dependents: string[]
  blob?: string
}

interface IncrementalManifest {
  schemaVersion: number
  contextHash: string
  files: Record<string, IncrementalCachedFileState>
}

interface IncrementalPaths {
  projectDirectory: string
  blobsDirectory: string
  manifestPath: string
}

const INCREMENTAL_SCHEMA_VERSION = 1

function indexSingleProjectIncremental(
  options: ProjectOptions,
  indexer: ProjectIndexer,
  tsconfigFileName?: string
): void {
  const paths = incrementalPaths(options)
  fs.mkdirSync(paths.blobsDirectory, { recursive: true })
  const previousManifest = loadIncrementalManifest(paths.manifestPath)
  const currentFiles = indexer.getIndexableFileNames()
  const currentHashes = new Map<string, string>()
  for (const fileName of currentFiles) {
    currentHashes.set(fileName, hashFile(fileName))
  }
  const currentDependents = indexer.computeDependents()

  const previousHashes = new Map<string, string>()
  const previousDependents = new Map<string, Set<string>>()
  for (const [fileName, state] of Object.entries(previousManifest.files)) {
    previousHashes.set(fileName, state.hash)
    previousDependents.set(fileName, new Set(state.dependents))
  }
  const contextHash = computeIncrementalContextHash(
    options,
    indexer.config,
    tsconfigFileName
  )
  const computed = computeAffectedFiles({
    currentFiles,
    currentHashes,
    currentDependents,
    previousHashes,
    previousDependents,
    contextMatches: previousManifest.contextHash === contextHash,
  })
  const affected = new Set(computed.affected)
  const unchanged = new Set(computed.unchanged)
  for (const fileName of [...unchanged]) {
    const previous = previousManifest.files[fileName]
    if (!previous?.blob) {
      continue
    }
    const blobPath = path.join(paths.projectDirectory, previous.blob)
    if (!fs.existsSync(blobPath)) {
      unchanged.delete(fileName)
      affected.add(fileName)
    }
  }

  const freshDocuments = new Map<string, Uint8Array>()
  indexer.index(affected, (fileName, indexBytes) => {
    freshDocuments.set(fileName, indexBytes)
    options.writeIndex(scip.scip.Index.deserializeBinary(indexBytes))
  })

  const nextManifest: IncrementalManifest = {
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    contextHash,
    files: {},
  }
  const usedBlobPaths = new Set<string>()
  for (const fileName of currentFiles) {
    const hash = currentHashes.get(fileName)
    if (hash === undefined) {
      continue
    }
    const dependents = [...(currentDependents.get(fileName) || [])].sort()
    const fresh = freshDocuments.get(fileName)
    if (fresh) {
      const blob = writeBlob(paths.blobsDirectory, fresh)
      nextManifest.files[fileName] = {
        hash,
        blob: path.relative(paths.projectDirectory, blob),
        dependents,
      }
      usedBlobPaths.add(path.relative(paths.projectDirectory, blob))
      continue
    }

    const previous = previousManifest.files[fileName]
    if (previous?.blob && unchanged.has(fileName)) {
      const blobPath = path.join(paths.projectDirectory, previous.blob)
      const bytes = fs.readFileSync(blobPath)
      options.writeIndex(scip.scip.Index.deserializeBinary(bytes))
      nextManifest.files[fileName] = {
        hash,
        blob: previous.blob,
        dependents,
      }
      usedBlobPaths.add(previous.blob)
      continue
    }

    nextManifest.files[fileName] = {
      hash,
      dependents,
    }
  }

  fs.mkdirSync(paths.projectDirectory, { recursive: true })
  fs.writeFileSync(paths.manifestPath, JSON.stringify(nextManifest, null, 2))
  cleanupUnusedBlobs(paths, usedBlobPaths)
}

function incrementalPaths(options: ProjectOptions): IncrementalPaths {
  const root = options.incrementalRoot || `${options.output}.incremental`
  const key = createHash('sha1')
    .update(path.resolve(options.projectRoot))
    .digest('hex')
  const projectDirectory = path.join(root, key)
  return {
    projectDirectory,
    blobsDirectory: path.join(projectDirectory, 'blobs'),
    manifestPath: path.join(projectDirectory, 'manifest.json'),
  }
}

function loadIncrementalManifest(manifestPath: string): IncrementalManifest {
  if (!fs.existsSync(manifestPath)) {
    return {
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      contextHash: '',
      files: {},
    }
  }
  const json = fs.readFileSync(manifestPath, 'utf-8')
  const parsed = JSON.parse(json) as IncrementalManifest
  if (parsed.schemaVersion !== INCREMENTAL_SCHEMA_VERSION) {
    return {
      schemaVersion: INCREMENTAL_SCHEMA_VERSION,
      contextHash: '',
      files: {},
    }
  }
  return parsed
}

function cleanupUnusedBlobs(paths: IncrementalPaths, usedBlobPaths: Set<string>): void {
  if (!fs.existsSync(paths.blobsDirectory)) {
    return
  }
  for (const entry of fs.readdirSync(paths.blobsDirectory)) {
    const absolute = path.join(paths.blobsDirectory, entry)
    const relative = path.relative(paths.projectDirectory, absolute)
    if (!usedBlobPaths.has(relative)) {
      fs.rmSync(absolute, { force: true })
    }
  }
}

function writeBlob(blobsDirectory: string, bytes: Uint8Array): string {
  const hash = createHash('sha1').update(Buffer.from(bytes)).digest('hex')
  const blobFile = path.join(blobsDirectory, `${hash}.bin`)
  if (!fs.existsSync(blobFile)) {
    fs.writeFileSync(blobFile, Buffer.from(bytes))
  }
  return blobFile
}

function hashFile(fileName: string): string {
  return createHash('sha1').update(fs.readFileSync(fileName)).digest('hex')
}

function computeIncrementalContextHash(
  options: ProjectOptions,
  config: ts.ParsedCommandLine,
  tsconfigFileName?: string
): string {
  const lockfiles = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].map(
    file => hashFileOrEmpty(path.join(options.cwd, file))
  )
  const payload = {
    schemaVersion: INCREMENTAL_SCHEMA_VERSION,
    scipVersion: packageJson.version,
    typescriptVersion: ts.version,
    projectRoot: path.resolve(options.projectRoot),
    maxFileByteSizeNumber: options.maxFileByteSizeNumber,
    compilerOptions: stableJson(config.options),
    tsconfigHash: tsconfigFileName ? hashFileOrEmpty(tsconfigFileName) : '',
    cwdPackageHash: hashFileOrEmpty(path.join(options.cwd, 'package.json')),
    projectPackageHash: hashFileOrEmpty(
      path.join(options.projectRoot, 'package.json')
    ),
    lockfiles,
  }
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex')
}

function hashFileOrEmpty(fileName: string): string {
  if (!fs.existsSync(fileName)) {
    return ''
  }
  return hashFile(fileName)
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => stableJson(item))
  }
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'function' || value === undefined) {
      return undefined
    }
    return value
  }
  const object = value as Record<string, unknown>
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(object).sort()) {
    const normalized = stableJson(object[key])
    if (normalized !== undefined) {
      result[key] = normalized
    }
  }
  return result
}

if (require.main === module) {
  main()
}

function loadConfigFile(file: string): ts.ParsedCommandLine | undefined {
  const absolute = path.resolve(file)

  const readResult = ts.readConfigFile(absolute, path => ts.sys.readFile(path))

  if (readResult.error) {
    throw new Error(
      ts.formatDiagnostics([readResult.error], ts.createCompilerHost({}))
    )
  }
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const config = readResult.config
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  if (config.compilerOptions !== undefined) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
    config.compilerOptions = {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      ...config.compilerOptions,
      ...defaultCompilerOptions(file),
    }
  }
  const basePath = path.dirname(absolute)
  const result = ts.parseJsonConfigFileContent(config, ts.sys, basePath)
  const errors: ts.Diagnostic[] = []
  for (const error of result.errors) {
    if (error.code === 18003) {
      // Ignore errors about missing 'input' fields, example:
      // > TS18003: No inputs were found in config file 'tsconfig.json'. Specified 'include' paths were '[]' and 'exclude' paths were '["out","node_modules","dist"]'.
      // The reason we ignore this error here is because we report the same
      // error at a higher-level.  It's common to hit on a single TypeScript
      // project with no sources when using the --yarnWorkspaces option.
      // Instead of failing fast at that single project, we only report this
      // error if all projects have no files.
      continue
    }
    errors.push(error)
  }
  if (errors.length > 0) {
    console.log(ts.formatDiagnostics(errors, ts.createCompilerHost({})))
    return undefined
  }
  return result
}

function defaultCompilerOptions(configFileName?: string): ts.CompilerOptions {
  const options: ts.CompilerOptions =
    // Not a typo, jsconfig.json is a thing https://sourcegraph.com/search?q=context:global+file:jsconfig.json&patternType=literal
    configFileName && path.basename(configFileName) === 'jsconfig.json'
      ? {
          allowJs: true,
          maxNodeModuleJsDepth: 2,
          allowSyntheticDefaultImports: true,
          skipLibCheck: true,
          noEmit: true,
        }
      : {}
  return options
}

function listPnpmWorkspaces(directory: string): string[] {
  /**
   * Returns the list of projects formatted as:
   * '/Users/user/sourcegraph/client/web:@sourcegraph/web@1.10.1:PRIVATE',
   *
   * See https://pnpm.io/id/cli/list#--depth-number
   */
  const output = child_process.execSync(
    'pnpm ls -r --depth -1 --long --parseable',
    {
      cwd: directory,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 5, // 5MB
    }
  )

  return output
    .split(EOL)
    .filter(project => project.includes(':'))
    .map(project => project.split(':')[0])
}

function listYarnWorkspaces(
  directory: string,
  yarnVersion: 'tryYarn1' | 'yarn2Plus'
): string[] {
  const runYarn = (cmd: string): string =>
    child_process.execSync(cmd, {
      cwd: directory,
      encoding: 'utf-8',
      maxBuffer: 1024 * 1024 * 5, // 5MB
    })
  const result: string[] = []
  const yarn1WorkspaceInfo = (): void => {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const json = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      JSON.parse(runYarn('yarn --silent --json workspaces info')).data
    )
    for (const key of Object.keys(json)) {
      const location = 'location'
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      if (json[key][location] !== undefined) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        result.push(path.join(directory, json[key][location]))
      }
    }
  }
  const yarn2PlusWorkspaceInfo = (): void => {
    const jsonLines = runYarn('yarn --json workspaces list').split(
      /\r?\n|\r|\n/g
    )
    for (let line of jsonLines) {
      line = line.trim()
      if (line.length === 0) {
        continue
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const json = JSON.parse(line)
      if ('location' in json) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
        result.push(path.join(directory, json.location))
      }
    }
  }
  if (yarnVersion === 'tryYarn1') {
    try {
      yarn2PlusWorkspaceInfo()
    } catch {
      yarn1WorkspaceInfo()
    }
  } else {
    yarn2PlusWorkspaceInfo()
  }
  return result
}

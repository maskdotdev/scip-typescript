import * as path from 'path'

import ProgressBar from 'progress'
import * as ts from 'typescript'

import { GlobalCache, ProjectOptions } from './CommandLineOptions'
import { FileIndexer } from './FileIndexer'
import { Input } from './Input'
import { Packages } from './Packages'
import * as scip from './scip'
import { ScipSymbol } from './ScipSymbol'

function createCompilerHost(
  cache: GlobalCache,
  compilerOptions: ts.CompilerOptions,
  projectOptions: ProjectOptions
): ts.CompilerHost {
  const host = ts.createCompilerHost(compilerOptions)
  if (!projectOptions.globalCaches) {
    return host
  }
  const hostCopy = { ...host }
  host.getParsedCommandLine = (fileName: string) => {
    if (!hostCopy.getParsedCommandLine) {
      return undefined
    }
    const fromCache = cache.parsedCommandLines.get(fileName)
    if (fromCache !== undefined) {
      return fromCache
    }
    const result = hostCopy.getParsedCommandLine(fileName)
    if (result !== undefined) {
      // Don't cache undefined results even if they could be cached
      // theoretically. The big performance gains from this cache come from
      // caching non-undefined results.
      cache.parsedCommandLines.set(fileName, result)
    }
    return result
  }
  host.getSourceFile = (
    fileName,
    languageVersion,
    onError,
    shouldCreateNewSourceFile
  ) => {
    const fromCache = cache.sources.get(fileName)
    if (fromCache !== undefined) {
      const [sourceFile, cachedLanguageVersion] = fromCache
      if (isSameLanguageVersion(languageVersion, cachedLanguageVersion)) {
        return sourceFile
      }
    }
    const result = hostCopy.getSourceFile(
      fileName,
      languageVersion,
      onError,
      shouldCreateNewSourceFile
    )
    if (result !== undefined) {
      // Don't cache undefined results even if they could be cached
      // theoretically. The big performance gains from this cache come from
      // caching non-undefined results.
      cache.sources.set(fileName, [result, languageVersion])
    }
    return result
  }
  return host
}

export class ProjectIndexer {
  private program: ts.Program
  private checker: ts.TypeChecker
  private symbolCache: Map<ts.Node, ScipSymbol> = new Map()
  private hasConstructor: Map<ts.ClassDeclaration, boolean> = new Map()
  private packages: Packages
  private indexableSourceFiles: ts.SourceFile[] | undefined
  constructor(
    public readonly config: ts.ParsedCommandLine,
    public readonly options: ProjectOptions,
    cache: GlobalCache
  ) {
    const host = createCompilerHost(cache, config.options, options)
    this.program = ts.createProgram(config.fileNames, config.options, host)
    this.checker = this.program.getTypeChecker()
    this.packages = new Packages(options.projectRoot)
  }
  public getIndexableFileNames(): string[] {
    return this.getIndexableSourceFiles().map(sourceFile => sourceFile.fileName)
  }

  public computeDependents(): Map<string, Set<string>> {
    const dependents = new Map<string, Set<string>>()
    const sourceFiles = this.getIndexableSourceFiles()
    const fileSet = new Set(sourceFiles.map(sourceFile => sourceFile.fileName))

    for (const sourceFile of sourceFiles) {
      const dependencies = resolveDependencies(
        sourceFile,
        this.config.options,
        fileSet
      )
      for (const dependency of dependencies) {
        let current = dependents.get(dependency)
        if (!current) {
          current = new Set()
          dependents.set(dependency, current)
        }
        current.add(sourceFile.fileName)
      }
    }

    return dependents
  }

  public index(
    onlyFiles?: Set<string>,
    onDocument?: (fileName: string, indexBytes: Uint8Array) => void
  ): Set<string> {
    const startTimestamp = Date.now()
    const filesToIndex: ts.SourceFile[] = []
    for (const sourceFile of this.getIndexableSourceFiles()) {
      if (!onlyFiles || onlyFiles.has(sourceFile.fileName)) {
        filesToIndex.push(sourceFile)
      }
    }

    if (this.getIndexableSourceFiles().length === 0) {
      throw new Error(
        `no indexable files in project '${this.options.projectDisplayName}'`
      )
    }
    if (filesToIndex.length === 0) {
      return new Set()
    }

    const jobs: ProgressBar | undefined = this.options.progressBar
      ? new ProgressBar(
          `  ${this.options.projectDisplayName} [:bar] :current/:total :title`,
          {
            total: filesToIndex.length,
            renderThrottle: 100,
            incomplete: '_',
            complete: '#',
            width: 20,
            clear: true,
            stream: process.stderr,
          }
        )
      : undefined
    let lastWrite = startTimestamp
    const emittedFiles = new Set<string>()
    for (const [index, sourceFile] of filesToIndex.entries()) {
      const title = path.relative(this.options.cwd, sourceFile.fileName)
      jobs?.tick({ title })
      if (!this.options.progressBar) {
        const now = Date.now()
        const elapsed = now - lastWrite
        if (elapsed > 1000 && index > 2) {
          lastWrite = now
          process.stdout.write('.')
        }
      }
      const document = new scip.scip.Document({
        relative_path: path.relative(this.options.cwd, sourceFile.fileName),
        occurrences: [],
      })
      const input = new Input(sourceFile.fileName, sourceFile.getText())
      const visitor = new FileIndexer(
        this.checker,
        this.options,
        input,
        document,
        this.symbolCache,
        this.hasConstructor,
        this.packages,
        sourceFile
      )
      try {
        visitor.index()
      } catch (error) {
        console.error(
          `unexpected error indexing project root '${this.options.cwd}'`,
          error
        )
      }
      if (visitor.document.occurrences.length > 0) {
        const indexMessage = new scip.scip.Index({
          documents: [visitor.document],
        })
        if (onDocument) {
          onDocument(sourceFile.fileName, indexMessage.serializeBinary())
        } else {
          this.options.writeIndex(indexMessage)
        }
        emittedFiles.add(sourceFile.fileName)
      }
    }
    jobs?.terminate()
    const elapsed = Date.now() - startTimestamp
    if (!this.options.progressBar && lastWrite > startTimestamp) {
      process.stdout.write('\n')
    }
    console.log(
      `+ ${this.options.projectDisplayName} (${prettyMilliseconds(elapsed)})`
    )
    return emittedFiles
  }

  private getIndexableSourceFiles(): ts.SourceFile[] {
    if (this.indexableSourceFiles) {
      return this.indexableSourceFiles
    }
    const sourceFiles = this.program.getSourceFiles()
    const filesToIndex: ts.SourceFile[] = []
    for (const sourceFile of sourceFiles) {
      if (this.config.fileNames.includes(sourceFile.fileName)) {
        filesToIndex.push(sourceFile)
      }
    }
    this.indexableSourceFiles = filesToIndex
    return filesToIndex
  }
}

export function prettyMilliseconds(milliseconds: number): string {
  let ms = Math.floor(milliseconds)
  let result = ''
  if (ms >= 1000 * 60) {
    const minutes = Math.floor(ms / (1000 * 60))
    if (minutes !== 0) {
      result += `${minutes}m `
      ms -= minutes * 1000 * 60
    }
  }
  if (result !== '' || ms >= 1000) {
    const seconds = Math.floor(ms / 1000)
    result += `${seconds}s `
    ms -= seconds * 1000
  }
  result += `${ms}ms`
  return result.trim()
}

function isSameLanguageVersion(
  a: ts.ScriptTarget | ts.CreateSourceFileOptions,
  b: ts.ScriptTarget | ts.CreateSourceFileOptions
): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b
  }
  if (typeof a === 'number' || typeof b === 'number') {
    // Different shape: one is ts.ScriptTarget, the other is
    // ts.CreateSourceFileOptions
    return false
  }
  return (
    a.languageVersion === b.languageVersion &&
    a.impliedNodeFormat === b.impliedNodeFormat
    // Ignore setExternalModuleIndicator even if that increases the risk of a
    // false positive. A local experiment revealed that we never get a cache hit
    // if we compare setExternalModuleIndicator since it's function with a
    // unique reference on every `CompilerHost.getSourceFile` callback.
  )
}

function resolveDependencies(
  sourceFile: ts.SourceFile,
  compilerOptions: ts.CompilerOptions,
  fileSet: Set<string>
): Set<string> {
  const dependencies = new Set<string>()
  const preprocessed = ts.preProcessFile(sourceFile.getFullText())
  for (const reference of preprocessed.referencedFiles) {
    const resolved = path.resolve(path.dirname(sourceFile.fileName), reference.fileName)
    if (fileSet.has(resolved)) {
      dependencies.add(resolved)
    }
  }
  const modules = collectModuleSpecifiers(sourceFile)
  for (const moduleName of modules) {
    const resolution = ts.resolveModuleName(
      moduleName,
      sourceFile.fileName,
      compilerOptions,
      ts.sys
    ).resolvedModule
    if (!resolution) {
      continue
    }
    const resolvedFileName = path.resolve(resolution.resolvedFileName)
    if (fileSet.has(resolvedFileName)) {
      dependencies.add(resolvedFileName)
    }
  }
  return dependencies
}

function collectModuleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const modules: string[] = []
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      modules.push(node.moduleSpecifier.text)
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression &&
      ts.isStringLiteral(node.moduleReference.expression)
    ) {
      modules.push(node.moduleReference.expression.text)
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      modules.push(node.arguments[0].text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return modules
}

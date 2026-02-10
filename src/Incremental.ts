export interface ComputeAffectedFilesParams {
  currentFiles: string[]
  currentHashes: Map<string, string>
  currentDependents: Map<string, Set<string>>
  previousHashes: Map<string, string>
  previousDependents: Map<string, Set<string>>
  contextMatches: boolean
}

export interface ComputeAffectedFilesResult {
  affected: Set<string>
  removed: Set<string>
  unchanged: Set<string>
}

export function computeAffectedFiles(
  params: ComputeAffectedFilesParams
): ComputeAffectedFilesResult {
  const affected = new Set<string>()
  const removed = new Set<string>()

  if (!params.contextMatches) {
    for (const file of params.currentFiles) {
      affected.add(file)
    }
    return {
      affected,
      removed,
      unchanged: new Set(),
    }
  }

  for (const [previousFile, previousHash] of params.previousHashes) {
    const currentHash = params.currentHashes.get(previousFile)
    if (currentHash === undefined) {
      removed.add(previousFile)
      continue
    }
    if (currentHash !== previousHash) {
      affected.add(previousFile)
    }
  }

  for (const currentFile of params.currentFiles) {
    if (!params.previousHashes.has(currentFile)) {
      affected.add(currentFile)
    }
  }

  const queue: string[] = [...affected]
  for (const deleted of removed) {
    queue.push(deleted)
  }

  while (queue.length > 0) {
    const head = queue.shift()
    if (head === undefined) {
      continue
    }
    const dependents =
      params.currentDependents.get(head) ?? params.previousDependents.get(head)
    if (!dependents) {
      continue
    }
    for (const dependent of dependents) {
      if (affected.has(dependent)) {
        continue
      }
      affected.add(dependent)
      queue.push(dependent)
    }
  }

  const unchanged = new Set<string>()
  for (const currentFile of params.currentFiles) {
    if (!affected.has(currentFile)) {
      unchanged.add(currentFile)
    }
  }

  return {
    affected,
    removed,
    unchanged,
  }
}

# incremental-dummy

Minimal TypeScript fixture repository used by incremental indexing tests.

- `src/a.ts` exports values/types.
- `src/b.ts` imports `a.ts`, so it should be invalidated when `a.ts` changes.

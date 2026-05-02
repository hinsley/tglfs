# Agent Instructions

This project uses **bd** (beads) for issue tracking. Run `bd onboard` to get started.

## Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --status in_progress  # Claim work
bd close <id>         # Complete work
bd sync               # Sync with git
```

## Landing the Plane (Session Completion)

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd sync
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds

## CLI Package Notes

- The global npm CLI lives in `packages/tglfs-cli`.
- Keep CLI runtime code isolated from the browser app in `src/web`; do not import DOM or service-worker modules into the CLI package.
- Prefer updating the CLI package's direct subcommands, `--help` output, and manpages together so installed users and AI agents get consistent guidance.
- Run CLI quality gates from the repo root with:
  - `npm run build --workspace tglfs`
  - `npm run test --workspace tglfs`

## Durable Protocol and Sync Safety

TGLFS stores user data as Telegram messages. Treat every serialized record that can be written to Telegram, read from Telegram, or persisted in local sync state as a durable protocol surface. This includes file cards, chunk metadata, future sync roots, sync entries, sync journals, tombstones, local ledger formats, and any import/export or repair records.

**Protocol changes require explicit compatibility work:**
- The existing unversioned `tglfs:file` Telegram records are protocol version 1. Readers must treat missing `type`/`version` on otherwise valid current file cards as v1, without calling that format "legacy" because "legacy" already means the older download/decryption pipeline in this project.
- Newly written file-card records use protocol version 2, the first file-card protocol with explicit `type` and `version` fields. New record types MUST include explicit `type` and `version` from the start.
- Folder-backed sync roots write `tglfs:sync-manifest` version 2. Readers must continue to parse sync-manifest v1 records, where no `folderId` exists, but newly initialized or upgraded sync roots must link to a `tglfs:folder` v1 record through `folderId`.
- TGLFS folder structure uses `tglfs:folder` v1 records for folder identity and `tglfs:folder-manifest` v1 records for folder contents. Folder manifests reference immutable `tglfs:file` blobs by UFID; do not move blob/chunk metadata into folder records.
- Do not invent a separate version 0 for existing records. The compatibility boundary is: missing version means v1 only for the already-shipped unversioned file-card shape.
- Before introducing a new durable protocol version or changing a version-specific storage algorithm, stop and discuss the compatibility design with the user. Do not silently choose a migration strategy.
- When changing the meaning, required fields, validation rules, encryption parameters, compression parameters, chunk semantics, sync conflict semantics, or deletion/rename semantics of a durable record, bump that record's protocol version in the same change.
- Add or update parser/serializer tests and fixture records for every supported protocol version. Tests must cover old records, new records, unknown future versions, and malformed records.
- Old clients must fail closed on unsupported versions instead of rewriting records they do not understand.
- New clients must preserve unknown fields when safely editing a record, or refuse the edit if preservation is not possible.
- Never silently migrate or rewrite user records in Telegram. Any migration must be explicit, recoverable, documented, and covered by tests using real serialized fixtures.

**File-content safety rules:**
- Treat uploaded encrypted file blobs as immutable once their file card is marked complete. If content changes, upload a new blob and point metadata at the new UFID.
- Do not mutate existing chunk lists, encryption metadata, compression metadata, IV/salt/counter fields, or UFID semantics except to complete an in-progress upload.
- Publish metadata that points to file content only after the target file card is complete and the referenced chunks are available.
- Keep blob format changes separate from sync metadata changes. Ordinary `tglfs:file` records should remain usable outside sync.

**Future sync design rules:**
- Sync must use explicit sync protocol records rather than inferring folder state only from ordinary file cards.
- Sync roots should point at first-class TGLFS folders. Do not introduce a new sync mode that creates a private path universe disconnected from `tglfs:folder` / `tglfs:folder-manifest` records.
- Track stable logical file identity separately from path. Renames, moves, deletes, and conflicts must not be represented only by disappearing or reappearing paths.
- Deletes require tombstones or explicit deletion records. Absence from a listing is not proof of deletion.
- Prefer append-only sync journals plus optional compacted checkpoints over in-place replacement of the only folder manifest.
- Conflict resolution must never silently overwrite local or remote user edits. Preserve both sides or create a clearly named conflict record/path.

**Agent checklist before landing protocol work:**
1. Identify every durable record type touched by the change.
2. Decide whether the change is backward-compatible. If not, bump the relevant version.
3. Update parsers, serializers, validators, fixtures, docs/help text, and repair/diagnostic behavior together.
4. Run the CLI build and test gates from the repo root.
5. In the handoff, explicitly state which protocol versions are read, written, migrated, refused, and preserved.

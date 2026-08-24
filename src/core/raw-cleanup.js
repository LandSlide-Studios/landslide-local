/**
 * RawCleanup — decides whether a raw GGUF on disk may be deleted, separated
 * from the code that does the deleting so the decision can be tested without
 * a 7 GiB file anywhere near it.
 *
 * Interface:
 *   canDeleteRaw({ modelId, fileBytes, registryEntry }) -> { ok, reason }
 *   findRegistryEntry(modelId, entries)                 -> entry | null
 *   matchesName(modelId, name)                          -> boolean
 *
 * Why this is a module and not an `if`:
 *
 * The old check asked "does the registry hold SOMETHING called cold-fusion-9b?"
 * A name is not an identity. Correct a filename in the catalog (commit 22a2c97
 * did exactly that), re-download, then run `--cleanup-raw`, and the name still
 * matches the OLD registration while the file on disk is the new one — so the
 * only copy of a 5-7 GiB download is deleted, unregistered, with no offline way
 * to get it back.
 *
 * Identity here means name AND size. Ollama reports the blob size it built the
 * entry from in /api/tags, so a registration made from a different file gives
 * itself away. Sizes are compared with a tolerance because a re-encode or a
 * metadata rewrite can move the byte count fractionally; anything past that is
 * a different file, and the file stays.
 *
 * Pure: no fs, no fetch, no clock. The caller supplies the two facts.
 */

/** Fractional difference between file and registry size still called "rounding". */
export const SIZE_TOLERANCE = 0.01;

/** Ollama tags carry a `:latest` suffix the catalog id does not. */
export function matchesName(modelId, name) {
  const id = String(modelId ?? '').toLowerCase();
  const got = String(name ?? '').toLowerCase();
  if (!id || !got) return false;
  return got === id || got === `${id}:latest`;
}

/** The registry entry for a catalog id, or null. One notion of "this model". */
export function findRegistryEntry(modelId, entries = []) {
  if (!Array.isArray(entries)) return null;
  return entries.find((e) => matchesName(modelId, e?.name)) ?? null;
}

/**
 * @param {{ modelId: string, fileBytes: number, registryEntry: ?{ name: string, size: number } }} input
 * @returns {{ ok: boolean, reason: string }}
 */
export function canDeleteRaw({ modelId, fileBytes, registryEntry } = {}) {
  const id = String(modelId ?? '');
  if (!id) return no('no model id was given, so nothing can be confirmed');

  const bytes = Number(fileBytes);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return no(`${id}: there is no raw file on disk to delete`);
  }

  if (!registryEntry) {
    return no(`${id} is not in the runtime registry — the raw file is the only copy`);
  }

  if (!matchesName(id, registryEntry.name)) {
    return no(`${id}: registry entry "${registryEntry.name}" is a different model — no name match`);
  }

  const registered = Number(registryEntry.size);
  if (!Number.isFinite(registered) || registered <= 0) {
    return no(`${id}: the registry entry reports no size, so its identity cannot be confirmed`);
  }

  const drift = Math.abs(bytes - registered) / Math.max(bytes, registered);
  if (drift > SIZE_TOLERANCE) {
    return no(
      `${id}: size mismatch — registered ${gib(registered)} GiB against ${gib(bytes)} GiB on disk. ` +
        'The registry was not built from this file; keeping it.',
    );
  }

  return {
    ok: true,
    reason: `${id}: registered from a file of this size (${gib(bytes)} GiB), so the raw copy is redundant`,
  };
}

function no(reason) {
  return { ok: false, reason };
}

function gib(bytes) {
  return (bytes / 1024 ** 3).toFixed(2);
}

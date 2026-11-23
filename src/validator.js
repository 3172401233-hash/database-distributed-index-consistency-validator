export function rowRefOf(row) {
  return { shardId: row.shardId, rowId: row.rowId, version: row.version };
}

export function entryRowRef(entry) {
  return {
    shardId: entry.rowShardId ?? entry.shardId,
    rowId: entry.rowId,
    version: entry.version,
  };
}

export function rowRefKey(ref) {
  return `${ref.shardId}/${ref.rowId}@${ref.version}`;
}

export function uniqueKeyOf(name, value) {
  return `${name}=${value}`;
}

export function isVisibleAt(position, shardId, snapshot) {
  const positions = snapshot?.positions ?? {};
  const watermark = positions[shardId];
  if (watermark === undefined) return false;
  return position <= watermark;
}

export function isRowVisible(row, snapshot) {
  return row.state === 'committed' && isVisibleAt(row.commitPosition, row.shardId, snapshot);
}

function hashKey(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return hash;
}

export function createKeyDirectory(bucketCount = 64) {
  const buckets = Array.from({ length: bucketCount }, () => new Map());
  const bucketOf = (key) => buckets[hashKey(key) % bucketCount];
  return {
    claim(key, claimant) {
      const bucket = bucketOf(key);
      const existing = bucket.get(key);
      if (!existing) {
        bucket.set(key, claimant);
        return { ok: true, claimant };
      }
      if (rowRefKey(existing) === rowRefKey(claimant)) {
        return { ok: true, claimant: existing };
      }
      return { ok: false, claimant: existing };
    },
    entries() {
      return buckets.flatMap((bucket) => [...bucket.entries()]);
    },
  };
}

function collectUniqueClaimants(input, snapshot) {
  const claimants = [];
  for (const entry of input.uniqueIndex ?? []) {
    if (!isVisibleAt(entry.position, entry.shardId, snapshot)) continue;
    claimants.push({
      key: entry.key,
      shardId: entry.shardId,
      rowId: entry.rowId,
      version: entry.version,
      position: entry.position,
    });
  }
  claimants.sort((a, b) => a.position - b.position || rowRefKey(a).localeCompare(rowRefKey(b)));
  return claimants;
}

export function checkUniqueLockFree(input, snapshot) {
  const directory = createKeyDirectory();
  const conflicts = new Map();
  for (const claimant of collectUniqueClaimants(input, snapshot)) {
    const result = directory.claim(claimant.key, claimant);
    if (result.ok) continue;
    if (!conflicts.has(claimant.key)) {
      conflicts.set(claimant.key, { key: claimant.key, winner: result.claimant, losers: [] });
    }
    conflicts.get(claimant.key).losers.push(claimant);
  }
  return [...conflicts.values()].map((conflict) => ({
    ...conflict,
    claimants: [conflict.winner, ...conflict.losers],
  }));
}

function findOrphanedEntries(input, snapshot, rowByRef) {
  const orphaned = [];
  const entries = [
    ...(input.uniqueIndex ?? []).map((entry) => ({ ...entry, kind: 'unique' })),
    ...(input.secondaryIndex ?? []).map((entry) => ({ ...entry, kind: 'secondary' })),
  ];
  for (const entry of entries) {
    const rowRef = entryRowRef(entry);
    const row = rowByRef.get(rowRefKey(rowRef));
    let reason = null;
    if (!row) {
      reason = 'row-missing';
    } else if (row.state === 'aborted') {
      reason = 'row-aborted';
    } else if (entry.position < row.commitPosition) {
      reason = 'index-before-row-commit';
    } else if (isVisibleAt(entry.position, entry.shardId, snapshot) && !isRowVisible(row, snapshot)) {
      reason = 'index-visible-before-row';
    }
    if (reason) {
      orphaned.push({ kind: entry.kind, key: entry.key, rowRef, position: entry.position, reason });
    }
  }
  return orphaned;
}

function findMissingEntries(input, snapshot, rowByRef) {
  const missing = [];
  const committedRows = (input.rows ?? []).filter((row) => row.state === 'committed');
  const uniqueWinners = new Map();
  for (const row of committedRows) {
    for (const [name, value] of Object.entries(row.uniqueKeys ?? {})) {
      const key = uniqueKeyOf(name, value);
      const current = uniqueWinners.get(key);
      if (!current || row.commitPosition < current.commitPosition) {
        uniqueWinners.set(key, row);
      }
    }
  }
  const present = {
    unique: new Set((input.uniqueIndex ?? []).map((e) => `${e.key}|${rowRefKey(entryRowRef(e))}`)),
    secondary: new Set(
      (input.secondaryIndex ?? []).map((e) => `${e.key}|${rowRefKey(entryRowRef(e))}`),
    ),
  };
  const queued = new Set(
    (input.indexQueue ?? []).map((q) => `${q.kind}:${q.key}|${rowRefKey(entryRowRef(q))}`),
  );
  for (const row of committedRows) {
    const rowRef = rowRefOf(row);
    const expect = (kind, key) => {
      const id = `${key}|${rowRefKey(rowRef)}`;
      if (present[kind].has(id)) return;
      missing.push({
        kind,
        key,
        rowRef,
        position: row.commitPosition,
        status: queued.has(`${kind}:${id}`) ? 'pending' : 'absent',
      });
    };
    for (const [name, value] of Object.entries(row.uniqueKeys ?? {})) {
      const key = uniqueKeyOf(name, value);
      if (rowRefKey(uniqueWinners.get(key)) !== rowRefKey(row)) continue;
      expect('unique', key);
    }
    for (const [name, value] of Object.entries(row.secondaryKeys ?? {})) {
      expect('secondary', uniqueKeyOf(name, value));
    }
  }
  return missing;
}

export function buildRepairPlan(report) {
  const plan = [];
  const removals = new Set();
  const remove = (kind, key, rowRef, reason) => {
    const id = `${kind}|${key}|${rowRefKey(rowRef)}`;
    if (removals.has(id)) return;
    removals.add(id);
    plan.push({ op: 'remove-entry', kind, key, rowRef, reason });
  };
  for (const orphan of report.orphanedEntries) {
    remove(orphan.kind, orphan.key, orphan.rowRef, orphan.reason);
  }
  for (const conflict of report.uniqueConflicts) {
    for (const loser of conflict.losers) {
      remove('unique', conflict.key, loser, 'unique-conflict-loser');
    }
  }
  for (const entry of report.missingEntries) {
    plan.push({
      op: 'add-entry',
      kind: entry.kind,
      key: entry.key,
      rowRef: entry.rowRef,
      position: entry.position,
    });
  }
  return plan;
}

export function validateIndexConsistency(input) {
  const snapshot = input.snapshot ?? { positions: {} };
  const rowByRef = new Map();
  for (const row of input.rows ?? []) {
    rowByRef.set(rowRefKey(row), row);
  }
  const report = {
    orphanedEntries: findOrphanedEntries(input, snapshot, rowByRef),
    missingEntries: findMissingEntries(input, snapshot, rowByRef),
    uniqueConflicts: checkUniqueLockFree(input, snapshot),
  };
  report.repairPlan = buildRepairPlan(report);
  return report;
}

export function applyRepairPlan(state, plan) {
  const uniqueIndex = [...(state.uniqueIndex ?? [])];
  const secondaryIndex = [...(state.secondaryIndex ?? [])];
  const indexQueue = [...(state.indexQueue ?? [])];
  const entryId = (e) => `${e.key}|${rowRefKey(entryRowRef(e))}`;
  for (const step of plan) {
    const target = step.kind === 'unique' ? uniqueIndex : secondaryIndex;
    const id = `${step.key}|${rowRefKey(step.rowRef)}`;
    if (step.op === 'remove-entry') {
      for (let i = target.length - 1; i >= 0; i -= 1) {
        if (entryId(target[i]) === id) target.splice(i, 1);
      }
      for (let i = indexQueue.length - 1; i >= 0; i -= 1) {
        if (indexQueue[i].kind === step.kind && entryId(indexQueue[i]) === id) {
          indexQueue.splice(i, 1);
        }
      }
    } else if (step.op === 'add-entry') {
      if (!target.some((e) => entryId(e) === id)) {
        target.push({ key: step.key, ...step.rowRef, position: step.position });
      }
      for (let i = indexQueue.length - 1; i >= 0; i -= 1) {
        if (indexQueue[i].kind === step.kind && entryId(indexQueue[i]) === id) {
          indexQueue.splice(i, 1);
        }
      }
    }
  }
  return { ...state, uniqueIndex, secondaryIndex, indexQueue };
}

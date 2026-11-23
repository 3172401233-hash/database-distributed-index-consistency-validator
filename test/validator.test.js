import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateIndexConsistency,
  applyRepairPlan,
  createKeyDirectory,
  isVisibleAt,
} from '../src/validator.js';

const row = (overrides) => ({
  shardId: 's1',
  rowId: 'r1',
  version: 1,
  state: 'committed',
  commitPosition: 10,
  uniqueKeys: {},
  secondaryKeys: {},
  ...overrides,
});

test('健康状态：索引与行一致时报告为空', () => {
  const state = {
    rows: [row({ uniqueKeys: { email: 'a@x' }, secondaryKeys: { city: 'sh' } })],
    uniqueIndex: [
      { key: 'email=a@x', shardId: 's1', rowId: 'r1', version: 1, position: 12 },
    ],
    secondaryIndex: [
      { key: 'city=sh', shardId: 's1', rowId: 'r1', version: 1, position: 12 },
    ],
    indexQueue: [],
    snapshot: { positions: { s1: 100 } },
  };
  const report = validateIndexConsistency(state);
  assert.deepEqual(report.orphanedEntries, []);
  assert.deepEqual(report.missingEntries, []);
  assert.deepEqual(report.uniqueConflicts, []);
  assert.deepEqual(report.repairPlan, []);
});

test('跨分片：索引项已可见但行数据尚未提交可见时判为孤立项', () => {
  const state = {
    rows: [
      row({ shardId: 's2', rowId: 'r9', commitPosition: 50, uniqueKeys: { email: 'b@x' } }),
    ],
    uniqueIndex: [
      { key: 'email=b@x', shardId: 's1', rowShardId: 's2', rowId: 'r9', version: 1, position: 80 },
    ],
    secondaryIndex: [],
    indexQueue: [],
    snapshot: { positions: { s1: 100, s2: 30 } },
  };
  const report = validateIndexConsistency(state);
  assert.equal(report.orphanedEntries.length, 1);
  assert.equal(report.orphanedEntries[0].reason, 'index-visible-before-row');
  assert.equal(report.repairPlan[0].op, 'remove-entry');
  const repaired = applyRepairPlan(state, report.repairPlan);
  assert.equal(repaired.uniqueIndex.length, 0);
});

test('跨分片唯一键：两个分片提交相同唯一键时检出冲突并保留最早提交者', () => {
  const state = {
    rows: [
      row({ shardId: 's1', rowId: 'r1', commitPosition: 10, uniqueKeys: { email: 'dup@x' } }),
      row({ shardId: 's2', rowId: 'r2', commitPosition: 20, uniqueKeys: { email: 'dup@x' } }),
    ],
    uniqueIndex: [
      { key: 'email=dup@x', shardId: 's1', rowId: 'r1', version: 1, position: 11 },
      { key: 'email=dup@x', shardId: 's2', rowId: 'r2', version: 1, position: 21 },
    ],
    secondaryIndex: [],
    indexQueue: [],
    snapshot: { positions: { s1: 100, s2: 100 } },
  };
  const report = validateIndexConsistency(state);
  assert.equal(report.uniqueConflicts.length, 1);
  const conflict = report.uniqueConflicts[0];
  assert.equal(conflict.key, 'email=dup@x');
  assert.equal(conflict.winner.rowId, 'r1');
  assert.deepEqual(conflict.losers.map((l) => l.rowId), ['r2']);
  const repaired = applyRepairPlan(state, report.repairPlan);
  assert.equal(repaired.uniqueIndex.length, 1);
  assert.equal(repaired.uniqueIndex[0].rowId, 'r1');
  const again = validateIndexConsistency(repaired);
  assert.deepEqual(again.uniqueConflicts, []);
});

test('延迟索引：已提交行的索引项仍在维护队列中时标记为 pending 缺失', () => {
  const state = {
    rows: [
      row({ commitPosition: 5, uniqueKeys: { email: 'c@x' }, secondaryKeys: { city: 'bj' } }),
    ],
    uniqueIndex: [],
    secondaryIndex: [],
    indexQueue: [
      { kind: 'unique', key: 'email=c@x', shardId: 's1', rowId: 'r1', version: 1, position: 6 },
    ],
    snapshot: { positions: { s1: 10 } },
  };
  const report = validateIndexConsistency(state);
  assert.equal(report.missingEntries.length, 2);
  const pending = report.missingEntries.find((m) => m.kind === 'unique');
  const absent = report.missingEntries.find((m) => m.kind === 'secondary');
  assert.equal(pending.status, 'pending');
  assert.equal(absent.status, 'absent');
  const repaired = applyRepairPlan(state, report.repairPlan);
  assert.equal(repaired.uniqueIndex.length, 1);
  assert.equal(repaired.secondaryIndex.length, 1);
  assert.equal(repaired.indexQueue.length, 0);
  const again = validateIndexConsistency(repaired);
  assert.deepEqual(again.missingEntries, []);
});

test('回滚：已中止行残留的索引项判为孤立项并被清除', () => {
  const state = {
    rows: [row({ rowId: 'r1', state: 'aborted', commitPosition: 10 })],
    uniqueIndex: [
      { key: 'email=d@x', shardId: 's1', rowId: 'r1', version: 1, position: 11 },
    ],
    secondaryIndex: [
      { key: 'city=sh', shardId: 's1', rowId: 'r1', version: 1, position: 11 },
    ],
    indexQueue: [],
    snapshot: { positions: { s1: 100 } },
  };
  const report = validateIndexConsistency(state);
  assert.equal(report.orphanedEntries.length, 2);
  assert.ok(report.orphanedEntries.every((o) => o.reason === 'row-aborted'));
  const repaired = applyRepairPlan(state, report.repairPlan);
  assert.equal(repaired.uniqueIndex.length, 0);
  assert.equal(repaired.secondaryIndex.length, 0);
});

test('重复修复：修复计划幂等，二次应用不产生新变化', () => {
  const state = {
    rows: [
      row({ shardId: 's1', rowId: 'r1', commitPosition: 10, uniqueKeys: { email: 'e@x' } }),
      row({ shardId: 's2', rowId: 'r2', commitPosition: 20, uniqueKeys: { email: 'e@x' } }),
      row({ shardId: 's1', rowId: 'r3', state: 'aborted', commitPosition: 30 }),
    ],
    uniqueIndex: [
      { key: 'email=e@x', shardId: 's1', rowId: 'r1', version: 1, position: 11 },
      { key: 'email=e@x', shardId: 's2', rowId: 'r2', version: 1, position: 21 },
      { key: 'email=gone@x', shardId: 's1', rowId: 'r3', version: 1, position: 31 },
    ],
    secondaryIndex: [],
    indexQueue: [],
    snapshot: { positions: { s1: 100, s2: 100 } },
  };
  const first = validateIndexConsistency(state);
  const once = applyRepairPlan(state, first.repairPlan);
  const twice = applyRepairPlan(once, first.repairPlan);
  assert.deepEqual(twice.uniqueIndex, once.uniqueIndex);
  assert.deepEqual(twice.secondaryIndex, once.secondaryIndex);
  const second = validateIndexConsistency(once);
  assert.deepEqual(second.orphanedEntries, []);
  assert.deepEqual(second.uniqueConflicts, []);
  assert.deepEqual(second.missingEntries, []);
  assert.deepEqual(second.repairPlan, []);
});

test('无锁唯一目录：按桶独立，先到者胜出，冲突被报告', () => {
  const directory = createKeyDirectory(8);
  const a = { shardId: 's1', rowId: 'r1', version: 1 };
  const b = { shardId: 's2', rowId: 'r2', version: 1 };
  assert.equal(directory.claim('email=k@x', a).ok, true);
  assert.equal(directory.claim('email=k@x', a).ok, true);
  const conflict = directory.claim('email=k@x', b);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.claimant.rowId, 'r1');
  assert.equal(directory.claim('email=other@x', b).ok, true);
});

test('可见性：提交位点不超过快照水位才可见', () => {
  const snapshot = { positions: { s1: 50 } };
  assert.equal(isVisibleAt(50, 's1', snapshot), true);
  assert.equal(isVisibleAt(51, 's1', snapshot), false);
  assert.equal(isVisibleAt(1, 's2', snapshot), false);
});

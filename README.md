# database-distributed-index-consistency-validator
验证跨分片索引维护、唯一性和恢复状态

## 背景

跨分片表建立了唯一索引和多个二级索引。索引维护是异步的：某分片可能已完成索引项写入，而持有行数据的另一个分片尚未提交，导致查询通过索引看到尚未可见的数据。本项目提供一个纯内存的一致性校验器，用于判定索引可见性并输出修复顺序。

**本项目不连接真实数据库。** 所有输入（分片提交位置、索引维护队列、行版本、唯一键、二级索引项、查询快照）都是普通 JavaScript 对象，校验与修复完全在内存中完成，便于在测试和离线审计中复现问题。

## 输入模型

```js
{
  rows: [
    {
      shardId: 's1', rowId: 'r1', version: 1,
      state: 'committed',            // committed | aborted
      commitPosition: 10,            // 行所在分片上的提交位点
      uniqueKeys: { email: 'a@x' },
      secondaryKeys: { city: 'sh' },
    },
  ],
  uniqueIndex: [
    // shardId 为索引项所在分片；rowShardId 为行所在分片（缺省等于 shardId）
    { key: 'email=a@x', shardId: 's2', rowShardId: 's1', rowId: 'r1', version: 1, position: 12 },
  ],
  secondaryIndex: [
    { key: 'city=sh', shardId: 's1', rowId: 'r1', version: 1, position: 12 },
  ],
  indexQueue: [
    // 已生成但尚未应用到索引的维护任务
    { kind: 'unique', key: 'email=a@x', shardId: 's1', rowId: 'r1', version: 1, position: 11 },
  ],
  snapshot: { positions: { s1: 100, s2: 100 } }, // 查询快照：每个分片的可见水位
}
```

可见性规则：某个对象（行版本或索引项）在其所在分片的提交位点 `position <= snapshot.positions[shardId]` 时对查询快照可见。

## 校验规则

- **孤立索引项**：索引项引用的行版本不存在、已回滚（`aborted`）、索引项位点早于行提交位点（`index-before-row-commit`），或索引项已可见但行数据尚未可见（`index-visible-before-row`）。索引项不能早于行数据可见。
- **缺失项**：已提交行缺少对应的唯一/二级索引项。仍在维护队列中的标记为 `pending`（延迟索引），完全缺失的标记为 `absent`。唯一键冲突中的失败方不再要求补齐索引项。
- **唯一冲突**：唯一索引覆盖所有分片，同一唯一键出现多个可见索引项且指向不同行时判定冲突，提交位点最早者胜出。

## 无锁并发唯一检查

`createKeyDirectory(bucketCount)` 将唯一键按哈希分桶，每个桶是独立的 `Map`，桶间无共享状态。对不同键的认领（`claim`）不需要任何全局锁，可安全并发执行；同一键先到者胜出，后到者收到冲突报告。`validateIndexConsistency` 内部即使用该目录做跨分片唯一性检查。

## 修复顺序

`repairPlan` 按以下顺序生成，`applyRepairPlan` 幂等（重复应用结果不变）：

1. `remove-entry`：清除孤立索引项（含回滚残留、先于行可见的项）。
2. `remove-entry`：清除唯一冲突失败方的索引项，释放唯一键。
3. `add-entry`：回填缺失的索引项（先删后加，避免回填时与待清理项瞬时冲突）。

## 运行测试

```bash
node --test
```

测试覆盖：跨分片唯一键冲突、延迟索引（队列积压）、事务回滚残留、重复修复幂等性，以及索引先于行可见的跨分片场景。

## 文件结构

- `src/validator.js`：校验、无锁唯一目录、修复计划生成与应用
- `test/validator.test.js`：`node:test` 测试套件

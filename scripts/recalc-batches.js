// 重算全部批次：对比取数口径修正前后（同一探头同一时刻 自动 vs 手工更正）的结论差异。
// 用法：node scripts/recalc-batches.js
//
// 旧口径（修复前）：effectiveRecords 里判断写反——同组先入的自动记录不会被后到的手工更正替代，
//   等价于「自动采集生效、手工更正作废」。本数据集每组冲突都是「自动在前、手工在后」，
//   因此用「移除同组手工记录」即可在同一套计算代码上精确复现旧口径结果。
// 新口径（修复后）：手工更正优先；停用探头记录不参与（本数据集停用探头 pb-0005 名下无记录，此项无数值影响）。
// 两种口径都调用当前 server/coldlib 的同一套计算函数，差异只来自取数。
const fs = require('fs');
const path = require('path');
const store = require('../server/store');
const coldlib = require('../server/coldlib');

function clone(data) {
  return JSON.parse(JSON.stringify(data));
}

// 找出「同批次+同探头+同时刻」里自动与手工并存的组，返回应在旧口径下移除的手工记录 id
function manualIdsLosingUnderLegacy(data) {
  const groups = {};
  for (const r of data.records) {
    const k = r.batchId + '|' + r.probeId + '|' + r.at;
    (groups[k] = groups[k] || []).push(r);
  }
  const drop = [];
  for (const rows of Object.values(groups)) {
    const hasAuto = rows.some((r) => r.source === '自动');
    const manual = rows.filter((r) => r.source === '人工');
    // 复刻旧 bug：组内先到自动、后到手工时，自动保留。即该手工记录在旧口径下不生效。
    if (hasAuto && manual.length) {
      for (const m of manual) drop.push({ id: m.id, batchId: m.batchId, probeId: m.probeId, at: m.at });
    }
  }
  return drop;
}

function snapshot(data, batch) {
  const stats = coldlib.excursionStats(data, batch.id);
  const chain = coldlib.chainGaps(data, batch.id);
  const check = coldlib.releaseCheck(data, batch);
  return {
    recordCount: stats.recordCount, // 参与计算的有效记录条数
    segmentCount: stats.segmentCount,
    segments: stats.segments.map((s) => ({ startAt: s.startAt, endAt: s.endAt, minutes: s.minutes, peakC: s.peakC, points: s.points })),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    monthlyTotalMinutes: coldlib.monthlyExcursionMinutes(data, batch.id),
    gapCount: chain.gapCount,
    gaps: chain.gaps,
    mkt: coldlib.mktCelsius(data, batch.id),
    pass: check.pass,
    failed: check.failed.slice(),
  };
}

function diffSummary(oldS, newS) {
  const changes = [];
  const push = (name, before, after) => changes.push({ metric: name, before, after });
  if (oldS.recordCount !== newS.recordCount) push('有效记录条数', oldS.recordCount, newS.recordCount);
  if (oldS.segmentCount !== newS.segmentCount) push('超限段数', oldS.segmentCount, newS.segmentCount);
  if (oldS.longestMinutes !== newS.longestMinutes) push('最长超限(分)', oldS.longestMinutes, newS.longestMinutes);
  if (oldS.totalMinutes !== newS.totalMinutes) push('累计超限(分,全周期)', oldS.totalMinutes, newS.totalMinutes);
  if (oldS.monthlyTotalMinutes !== newS.monthlyTotalMinutes) push('累计超限(分,首月判定用)', oldS.monthlyTotalMinutes, newS.monthlyTotalMinutes);
  if (oldS.gapCount !== newS.gapCount) push('断链数', oldS.gapCount, newS.gapCount);
  if (oldS.mkt !== newS.mkt) push('MKT(℃)', oldS.mkt, newS.mkt);
  if (oldS.pass !== newS.pass) push('放行判定', oldS.pass ? '满足' : '不满足', newS.pass ? '满足' : '不满足');
  if (JSON.stringify(oldS.failed) !== JSON.stringify(newS.failed)) push('不满足条目', oldS.failed.join(',') || '无', newS.failed.join(',') || '无');
  // 段明细变化（段数相同但峰值/起止不同也算）
  if (JSON.stringify(oldS.segments) !== JSON.stringify(newS.segments) && !changes.some((c) => c.metric === '超限段数')) {
    push('超限段明细', JSON.stringify(oldS.segments), JSON.stringify(newS.segments));
  }
  return changes;
}

function main() {
  const data = store.load();
  const dropped = manualIdsLosingUnderLegacy(data);

  // 旧口径数据：移除在旧 bug 下不生效的手工更正记录
  const oldData = clone(data);
  const dropIds = new Set(dropped.map((d) => d.id));
  oldData.records = oldData.records.filter((r) => !dropIds.has(r.id));

  const report = [];
  for (const batch of data.batches) {
    const before = snapshot(oldData, batch);
    const after = snapshot(data, batch);
    const changes = diffSummary(before, after);
    report.push({ batch, before, after, changes });
  }

  const changed = report.filter((r) => r.changes.length > 0);

  process.stdout.write('=== 取数口径冲突组（同批次+同探头+同时刻，自动 vs 手工）===\n');
  if (!dropped.length) process.stdout.write('（无）\n');
  for (const d of dropped) {
    const batch = data.batches.find((b) => b.id === d.batchId);
    const probe = data.probes.find((p) => p.id === d.probeId);
    const rivals = data.records.filter((r) => r.batchId === d.batchId && r.probeId === d.probeId && r.at === d.at);
    const desc = rivals.map((r) => r.id + ' ' + r.source + ' ' + r.temperatureC + '℃' + (r.operator ? '（' + r.operator + '）' : '')).join('  vs  ');
    process.stdout.write(batch.code + ' / ' + probe.code + ' / ' + d.at + '：' + desc + '\n');
  }

  process.stdout.write('\n=== 各批次重算结果（旧口径 → 新口径）===\n');
  for (const r of report) {
    const b = r.batch;
    const flag = r.changes.length ? '★结论变化' : '  无变化';
    process.stdout.write(
      flag + '  ' + b.code + '（' + b.status + '）: ' +
      '段 ' + r.before.segmentCount + '→' + r.after.segmentCount +
      '，最长 ' + r.before.longestMinutes + '→' + r.after.longestMinutes +
      '，累计 ' + r.before.totalMinutes + '→' + r.after.totalMinutes +
      '，断链 ' + r.before.gapCount + '→' + r.after.gapCount +
      '，MKT ' + r.before.mkt + '→' + r.after.mkt +
      '，放行 ' + (r.before.pass ? '满足' : '不满足') + '→' + (r.after.pass ? '满足' : '不满足') + '\n'
    );
  }

  process.stdout.write('\n=== 因取数口径变化而结论发生变化的批次：' + changed.length + ' 个 ===\n');
  for (const r of changed) {
    process.stdout.write('\n● ' + r.batch.code + '（' + r.batch.product + '，' + r.batch.status + '）\n');
    for (const c of r.changes) {
      process.stdout.write('   - ' + c.metric + '：' + c.before + ' → ' + c.after + '\n');
    }
    // 列出受影响的超限段
    const segDiff = JSON.stringify(r.before.segments) !== JSON.stringify(r.after.segments);
    if (segDiff) {
      process.stdout.write('   旧口径超限段：' + JSON.stringify(r.before.segments) + '\n');
      process.stdout.write('   新口径超限段：' + JSON.stringify(r.after.segments) + '\n');
    }
  }

  // 放行台账快照核对（持久化的派生数据）
  process.stdout.write('\n=== 放行台账快照核对 ===\n');
  for (const rel of data.releases) {
    const batch = data.batches.find((b) => b.id === rel.batchId);
    const now = snapshot(data, batch);
    const mismatch = [];
    if (rel.mkt !== now.mkt) mismatch.push('mkt ' + rel.mkt + '→' + now.mkt);
    if (rel.longestExcursionMinutes !== now.longestMinutes) mismatch.push('longest ' + rel.longestExcursionMinutes + '→' + now.longestMinutes);
    if (rel.totalExcursionMinutes !== now.totalMinutes) mismatch.push('total ' + rel.totalExcursionMinutes + '→' + now.totalMinutes);
    if (rel.chainGapCount !== now.gapCount) mismatch.push('gaps ' + rel.chainGapCount + '→' + now.gapCount);
    process.stdout.write(rel.id + ' ' + batch.code + ' ' + rel.decision + '：' + (mismatch.length ? '快照与重算不一致 ' + mismatch.join('；') : '快照与重算一致（' + rel.mkt + '/' + rel.longestExcursionMinutes + '/' + rel.totalExcursionMinutes + '/' + rel.chainGapCount + '）') + '\n');
  }

  // 机读结果
  fs.writeFileSync(
    path.join(__dirname, 'recalc-result.json'),
    JSON.stringify({ dropped, report, changedBatchCodes: changed.map((r) => r.batch.code) }, null, 2),
    'utf8'
  );
  process.stdout.write('\n机读结果已写入 scripts/recalc-result.json\n');
}

main();

// 温控口径都集中在这里：超限段、断链、MKT、放行判定
const store = require('./store');

function toDate(text) {
  return new Date(String(text).replace(' ', 'T') + '+08:00');
}

function recordsOfBatch(data, batchId) {
  return data.records
    .filter((r) => r.batchId === batchId)
    .slice()
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

function probeOf(data, probeId) {
  return data.probes.find((p) => p.id === probeId) || null;
}

// 取数口径（README 口径第 7 条）：同一探头同一时刻可能有多条记录
// （自动采集加手工更正），判定一律只取一条「有效记录」：
//   1. 有手工更正（来源「人工」）时以人工为准，同刻自动记录不采用；
//   2. 同一来源有多条时，以登记在后的（记录编号大的）为准。
// 超限段、累计超限、断链、MKT、放行判定与页面明细全部从这里取数，
// 被顶掉的记录不参与任何判定，但 adoption 里会写清它被哪条顶掉、为什么。
function idSerial(id) {
  const matched = String(id || '').match(/(\d+)$/);
  return matched ? Number(matched[1]) : 0;
}

function recordAdoption(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const groups = new Map();
  for (const row of rows) {
    const key = row.probeId + '|' + row.at;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const effective = [];
  const adoption = {};
  for (const group of groups.values()) {
    const manual = group.filter((r) => r.source === '人工');
    const pool = manual.length ? manual : group;
    let winner = pool[0];
    for (const row of pool) {
      if (idSerial(row.id) > idSerial(winner.id)) winner = row;
    }
    for (const row of group) {
      if (row === winner) {
        adoption[row.id] = { adopted: true, byId: '', reason: '' };
      } else if (row.source !== winner.source) {
        adoption[row.id] = {
          adopted: false,
          byId: winner.id,
          reason: '同探头同时刻有手工更正记录 ' + winner.id + '（人工' + (winner.operator ? '，' + winner.operator : '') + '，' + winner.temperatureC + '℃），按口径以手工为准',
        };
      } else {
        adoption[row.id] = {
          adopted: false,
          byId: winner.id,
          reason: '同探头同时刻有多条' + row.source + '记录，以登记在后的 ' + winner.id + ' 为准',
        };
      }
    }
    effective.push(winner);
  }
  return { effective, adoption };
}

function effectiveRecords(data, batchId) {
  return recordAdoption(data, batchId).effective;
}

// 超限：连续超出上下限的时段，回到范围内即断开
function segmentStats(rows, settings) {
  const segments = [];
  let current = null;
  for (const row of rows) {
    const value = Number(row.temperatureC);
    const out = value > Number(settings.upperLimitC) || value < Number(settings.lowerLimitC);
    if (out) {
      const previous = current;
      if (previous) {
        previous.endAt = row.at;
        previous.minutes += previous.lastGapMinutes || 0;
        previous.peakC = value > previous.peakC ? value : previous.peakC;
        previous.points += 1;
      } else {
        current = { startAt: row.at, endAt: row.at, minutes: 0, peakC: value, points: 1 };
        segments.push(current);
      }
      // 与上一条记录的间隔按固定记录间隔计
      current.lastGapMinutes = Number(settings.recordIntervalMinutes);
    } else {
      current = null;
    }
  }
  const longest = segments.reduce((acc, s) => (s.minutes > acc.minutes ? s : acc), { minutes: 0, startAt: '', endAt: '', peakC: 0, points: 0 });
  const total = segments.reduce((acc, s) => acc + s.minutes, 0);
  return { segments, longestMinutes: longest.minutes, longest, totalMinutes: total, segmentCount: segments.length };
}

function excursionStats(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const stats = segmentStats(rows, data.settings);
  return Object.assign({}, stats, {
    recordCount: rows.length,
    firstAt: rows.length ? rows[0].at : '',
    lastAt: rows.length ? rows[rows.length - 1].at : '',
  });
}

// 断链：相邻记录的时刻差超过门槛
function chainGaps(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    const minutes = store.minutesBetween(rows[i - 1].at, rows[i].at);
    if (minutes > Number(settings.chainGapMinutes)) {
      gaps.push({ from: rows[i - 1].at, to: rows[i].at, minutes, countedMinutes: Number(settings.recordIntervalMinutes) });
    }
  }
  return { gaps, gapCount: gaps.length, totalGapMinutes: gaps.reduce((acc, g) => acc + g.countedMinutes, 0) };
}

// MKT：平均动力学温度
function mktCelsius(data, batchId) {
  const settings = data.settings;
  const rows = effectiveRecords(data, batchId);
  if (!rows.length) return 0;
  const sum = rows.reduce((acc, row) => acc + Number(row.temperatureC), 0);
  return store.round(sum / rows.length, 2);
}

// 探头校准有效期
function probeValidOn(probe, day) {
  if (!probe || !probe.calibratedUntil) return true;
  return String(day) <= String(probe.calibratedUntil);
}

function expiredProbes(data, batchId, day) {
  const rows = effectiveRecords(data, batchId);
  const bad = [];
  for (const row of rows) {
    const probe = probeOf(data, row.probeId);
    if (!probe) continue;
    if (!probeValidOn(probe, String(row.at).slice(0, 10))) {
      if (!bad.some((b) => b.probeCode === probe.code)) {
        bad.push({ probeId: probe.id, probeCode: probe.code, calibratedUntil: probe.calibratedUntil, at: row.at });
      }
    }
  }
  return bad;
}

// 累计超限时长：按批次周期累计，跨月不重置
function accumulatedExcursionMinutes(data, batchId) {
  return excursionStats(data, batchId).totalMinutes;
}

function monthlyExcursionMinutes(data, batchId) {
  const rows = effectiveRecords(data, batchId);
  const firstAt = rows.length ? rows[0].at : '';
  const month = firstAt.slice(0, 7);
  const scoped = rows.filter((r) => String(r.at).slice(0, 7) === month);
  return segmentStats(scoped, data.settings).totalMinutes;
}

// 放行判定：最长超限、累计超限、断链、探头校准四条
function releaseCheck(data, batch) {
  const settings = data.settings;
  const stats = excursionStats(data, batch.id);
  const chain = chainGaps(data, batch.id);
  const accumulated = monthlyExcursionMinutes(data, batch.id);
  const expired = expiredProbes(data, batch.id, batch.loadedAt ? String(batch.loadedAt).slice(0, 10) : '');
  const conditions = [
    { key: 'longest', ok: stats.longestMinutes <= Number(settings.allowExcursionMinutes), value: stats.longestMinutes, limit: Number(settings.allowExcursionMinutes), text: '单次连续超限不超过 ' + settings.allowExcursionMinutes + ' 分钟' },
    { key: 'total', ok: accumulated <= Number(settings.allowTotalExcursionMinutes), value: accumulated, limit: Number(settings.allowTotalExcursionMinutes), text: '累计超限不超过 ' + settings.allowTotalExcursionMinutes + ' 分钟' },
    { key: 'chain', ok: chain.gapCount === 0, value: chain.gapCount, limit: 0, text: '全程没有断链' },
  ];
  return {
    mkt: mktCelsius(data, batch.id),
    longestMinutes: stats.longestMinutes,
    totalMinutes: stats.totalMinutes,
    recordCount: stats.recordCount,
    firstAt: stats.firstAt,
    lastAt: stats.lastAt,
    chain,
    expiredProbes: expired,
    conditions,
    pass: conditions.every((c) => c.ok),
    failed: conditions.filter((c) => !c.ok).map((c) => c.key),
  };
}

module.exports = {
  toDate,
  probeOf,
  recordsOfBatch,
  recordAdoption,
  effectiveRecords,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  releaseCheck,
};

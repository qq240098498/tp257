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

// id 倒序：用于「多条同类记录」时取最新登记的一条
function byIdDesc(a, b) {
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// 同一批次内同一探头同一时刻可能既有自动采集又有手工更正，取数口径：
// 1) 分组键 = 批次 + 探头 + 时刻；
// 2) 组内来源优先级：人工（手工更正）＞自动（自动采集），同一时刻有手工记录就用手工，自动那条不采用；
// 3) 组内来源相同（同为自动或同为手工）属异常重复，取 id 靠后（最新登记）的一条，另一条标注重复；
// 4) 所属探头已停用的记录不参与判定；
// 5) 超限段、累计、断链、MKT、探头校准、放行四条与页面明细都只认这一份取数结果。
function isActiveProbe(data, probeId) {
  const probe = probeOf(data, probeId);
  return !probe || probe.status !== '停用';
}

// 按「探头+时刻」分组并决定每组采用哪一条，返回 { groups, excludedStopped }
function effectiveRecordGroups(data, batchId) {
  const rows = recordsOfBatch(data, batchId);
  const map = {};
  const order = [];
  for (const row of rows) {
    if (!isActiveProbe(data, row.probeId)) continue;
    const key = row.probeId + '|' + row.at;
    if (map[key] === undefined) {
      map[key] = [row];
      order.push(key);
      continue;
    }
    map[key].push(row);
  }
  const groups = order.map((key) => {
    const rowsAtKey = map[key];
    const manual = rowsAtKey.filter((r) => r.source === '人工');
    let picked;
    let reason;
    if (manual.length >= 1) {
      picked = manual.slice().sort(byIdDesc)[0];
      reason = 'manual';
    } else {
      picked = rowsAtKey.slice().sort(byIdDesc)[0];
      reason = rowsAtKey.length > 1 ? 'duplicate-auto' : 'only';
    }
    return {
      probeId: picked.probeId,
      at: picked.at,
      picked,
      notPicked: rowsAtKey.filter((r) => r.id !== picked.id),
      reason,
    };
  });
  return { groups, excludedStopped: rows.filter((r) => !isActiveProbe(data, r.probeId)) };
}

// 判定与统计统一使用的取数：每个「探头+时刻」只保留采用的一条
function effectiveRecords(data, batchId) {
  return effectiveRecordGroups(data, batchId).groups.map((g) => g.picked);
}

// 页面明细与重算用：逐条原始记录标注是否采用、同组另一条及不采用原因
function recordAdoptions(data, batchId) {
  const { groups, excludedStopped } = effectiveRecordGroups(data, batchId);
  const adoptions = [];
  for (const group of groups) {
    // 未采用的记录：被手工更正替代（自身自动、采用的是手工），或同来源重复取最新
    for (const row of group.notPicked) {
      const supersededByManual = row.source === '自动' && group.picked.source === '人工';
      adoptions.push({
        record: row,
        pickedRecord: group.picked,
        adopted: false,
        reason: supersededByManual ? 'superseded-by-manual' : 'duplicate',
        replacedBy: group.picked.id,
        note: supersededByManual
          ? '同一探头同一时刻存在手工更正记录，以手工为准，本自动记录不采用'
          : '同一探头同一时刻存在多条' + row.source + '记录，以最新登记的一条为准，本条不采用',
      });
    }
    const hasRival = group.notPicked.length > 0;
    const rivalsAuto = group.notPicked.some((r) => r.source === '自动');
    adoptions.push({
      record: group.picked,
      pickedRecord: group.picked,
      adopted: true,
      reason: !hasRival ? 'only' : rivalsAuto && group.picked.source === '人工' ? 'manual' : 'duplicate',
      replacedBy: '',
      note: !hasRival
        ? ''
        : rivalsAuto && group.picked.source === '人工'
          ? '同一探头同一时刻存在手工更正记录，以手工为准'
          : '同一探头同一时刻存在多条' + group.picked.source + '记录，以最新登记的一条为准',
    });
  }
  for (const row of excludedStopped) {
    adoptions.push({
      record: row,
      pickedRecord: null,
      adopted: false,
      reason: 'stopped-probe',
      replacedBy: '',
      note: '所属探头已停用，名下记录不参与判定',
    });
  }
  return adoptions;
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
  effectiveRecordGroups,
  effectiveRecords,
  recordAdoptions,
  excursionStats,
  chainGaps,
  mktCelsius,
  probeValidOn,
  expiredProbes,
  accumulatedExcursionMinutes,
  monthlyExcursionMinutes,
  releaseCheck,
};

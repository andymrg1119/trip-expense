/**
 * calc.test.js —— 独立验证「多家庭出游记账与分摊」核心算法。
 *
 * 约定：
 *  - 只用 Node 内置 assert + 自写极简 runner，不依赖任何 npm 包。
 *  - 期望值均为「手工独立推算」的真实算例，绝不从 calc.js 输出反推。
 *  - 全程以「整数分」为等价判定基准，验证「分币不丢」。
 *
 * 运行：node tests/calc.test.js
 */
'use strict';

var assert = require('assert');
var C = require('../calc.js');

// ---------------------------------------------------------------------------
// 极简测试运行器
// ---------------------------------------------------------------------------
var passed = 0;
var failed = 0;
var failures = [];

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('  \u2713 ' + name);
  } catch (e) {
    failed++;
    failures.push({ name: name, err: e });
    console.log('  \u2717 ' + name);
    console.log('      ' + (e && e.message ? e.message : e));
  }
}

function group(title, fn) {
  console.log('\n' + title);
  fn();
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function cents(x) { return Math.round(Number(x) * 100); }

/** 求和某笔费用的 alloc（以分为单位）。 */
function sumAllocCents(alloc) {
  var s = 0;
  Object.keys(alloc).forEach(function (k) { s += cents(alloc[k]); });
  return s;
}

/** 造一个成员。 */
function mkMember(id, familyId, name, type) {
  return { id: id, familyId: familyId, name: name, type: type };
}

/** 用给定成员集合造一份最小 data。 */
function mkData(members, families, extraCurrencies) {
  var curs = [{ code: 'CNY', name: '人民币', rate: 1 }];
  if (extraCurrencies) curs = curs.concat(extraCurrencies);
  return {
    version: 1,
    baseCurrency: 'CNY',
    currencies: curs,
    families: families,
    members: members,
    expenses: []
  };
}

// 固定随机种子（可复现）——mulberry32
function mulberry32(seed) {
  var a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ===========================================================================
// 算例 A —— 门票分档定价（精确到分）
// ===========================================================================
group('算例 A：门票分档定价（JPY 45000 @ 0.0485，三档加权恰好等于总额）', function () {
  var members = [
    mkMember('mw', 'fz', '张伟', 'adult'),
    mkMember('mt', 'fz', '张太', 'adult'),
    mkMember('mx', 'fz', '张小明', 'child'),
    mkMember('lq', 'fl', '李强', 'adult'),
    mkMember('ll', 'fl', '李老', 'elder'),
    mkMember('wf', 'fw', '王芳', 'adult'),
    mkMember('wx', 'fw', '王小雨', 'child')
  ];
  var families = [{ id: 'fz', name: '张家' }, { id: 'fl', name: '李家' }, { id: 'fw', name: '王家' }];
  var data = mkData(members, families, [{ code: 'JPY', name: '日元', rate: 0.0485 }]);
  var exp = {
    id: 'eA', title: '算例A门票', currency: 'JPY', amount: 45000, rate: 0.0485,
    payerMemberId: 'mw', splitMode: 'ticket',
    participants: ['mw', 'mt', 'mx', 'lq', 'll', 'wf', 'wx'],
    prices: { adult: 8000, elder: 5000, child: 4000 }
  };

  test('折算总额精确等于 2182.50', function () {
    assert.strictEqual(C.convertToBase(45000, 0.0485), 2182.5);
  });

  test('成人 4 人各 388.00；小孩 2 人各 194.00；老人 242.50', function () {
    var res = C.allocateExpense(exp, data);
    assert.strictEqual(res.total, 2182.5, 'total');
    assert.strictEqual(res.alloc['mw'], 388.0);
    assert.strictEqual(res.alloc['mt'], 388.0);
    assert.strictEqual(res.alloc['lq'], 388.0);
    assert.strictEqual(res.alloc['wf'], 388.0);
    assert.strictEqual(res.alloc['mx'], 194.0);
    assert.strictEqual(res.alloc['wx'], 194.0);
    assert.strictEqual(res.alloc['ll'], 242.5);
  });

  test('各条分摊之和以分为单位精确等于 218250 分', function () {
    var res = C.allocateExpense(exp, data);
    assert.strictEqual(sumAllocCents(res.alloc), 218250);
  });

  test('不应产生任何「不一致」缩放 warning（三档加权恰好等于总额）', function () {
    var res = C.allocateExpense(exp, data);
    var hasScaleWarn = res.warnings.some(function (w) { return w.indexOf('不一致') !== -1; });
    assert.ok(!hasScaleWarn, '不应有缩放提示, got: ' + JSON.stringify(res.warnings));
  });
});

// ===========================================================================
// 算例 B —— 均摊尾差分配
// ===========================================================================
group('算例 B：100.00 在 3 人间均摊的尾差分配', function () {
  var members = [mkMember('m1', 'f1', 'A', 'adult'), mkMember('m2', 'f1', 'B', 'adult'), mkMember('m3', 'f1', 'C', 'adult')];
  var data = mkData(members, [{ id: 'f1', name: '家' }]);
  var exp = { id: 'eB', title: 'B', currency: 'CNY', amount: 100, rate: 1, payerMemberId: 'm1', splitMode: 'equal', participants: ['m1', 'm2', 'm3'] };

  test('合计精确为 100.00，值域 ∈ {33.33, 33.34}', function () {
    var res = C.allocateExpense(exp, data);
    var vals = ['m1', 'm2', 'm3'].map(function (k) { return cents(res.alloc[k]); });
    vals.forEach(function (v) { assert.ok(v === 3333 || v === 3334, '值越界: ' + v); });
    assert.strictEqual(vals.reduce(function (a, b) { return a + b; }, 0), 10000);
  });

  test('恰好一人 33.34、两人 33.33', function () {
    var res = C.allocateExpense(exp, data);
    var vals = [res.alloc['m1'], res.alloc['m2'], res.alloc['m3']];
    var n34 = vals.filter(function (v) { return cents(v) === 3334; }).length;
    var n33 = vals.filter(function (v) { return cents(v) === 3333; }).length;
    assert.strictEqual(n34, 1);
    assert.strictEqual(n33, 2);
  });
});

// ===========================================================================
// 算例 C —— 酒店按房间（3 人同住）
// ===========================================================================
group('算例 C：酒店按房间（A房 36000 三人 / B房 24000 两人）', function () {
  var members = ['mw', 'lq', 'wf', 'mt', 'mx'].map(function (id) { return mkMember(id, 'f1', id, 'adult'); });
  var data = mkData(members, [{ id: 'f1', name: '家' }], [{ code: 'JPY', name: '日元', rate: 0.0485 }]);
  var exp = {
    id: 'eC', title: '住宿', currency: 'JPY', amount: 60000, rate: 0.0485,
    payerMemberId: 'mw', splitMode: 'room',
    participants: ['mw', 'lq', 'wf', 'mt', 'mx'],
    rooms: [
      { name: 'A房', price: 36000, occupants: ['mw', 'lq', 'wf'] },
      { name: 'B房', price: 24000, occupants: ['mt', 'mx'] }
    ]
  };

  test('折算总额 = 2910.00', function () {
    assert.strictEqual(C.convertToBase(60000, 0.0485), 2910.0);
  });

  test('5 人每人 582.00，合计精确 2910.00', function () {
    var res = C.allocateExpense(exp, data);
    assert.strictEqual(res.total, 2910.0);
    ['mw', 'lq', 'wf', 'mt', 'mx'].forEach(function (k) {
      assert.strictEqual(res.alloc[k], 582.0, k);
    });
    assert.strictEqual(sumAllocCents(res.alloc), 291000);
  });
});

// ===========================================================================
// 算例 D —— 按家庭均摊
// ===========================================================================
group('算例 D：300.00 按家庭均摊（张家 3 人 vs 李家 1 人）', function () {
  var members = [
    mkMember('mw', 'fz', '张伟', 'adult'),
    mkMember('mt', 'fz', '张太', 'adult'),
    mkMember('mx', 'fz', '张小明', 'child'),
    mkMember('lq', 'fl', '李强', 'adult'),
    mkMember('wf', 'fw', '王芳', 'adult') // 未参与
  ];
  var families = [{ id: 'fz', name: '张家' }, { id: 'fl', name: '李家' }, { id: 'fw', name: '王家' }];
  var data = mkData(members, families);
  var exp = { id: 'eD', title: '租车', currency: 'CNY', amount: 300, rate: 1, payerMemberId: 'mw', splitMode: 'family', participants: ['mw', 'mt', 'mx', 'lq'] };

  test('张家合计 150.00（三人各 50.00），李强 150.00', function () {
    var res = C.allocateExpense(exp, data);
    assert.strictEqual(res.alloc['mw'], 50.0);
    assert.strictEqual(res.alloc['mt'], 50.0);
    assert.strictEqual(res.alloc['mx'], 50.0);
    assert.strictEqual(res.alloc['lq'], 150.0);
    assert.strictEqual(cents(res.alloc['mw']) + cents(res.alloc['mt']) + cents(res.alloc['mx']), 15000);
  });

  test('未参与者（王芳）分摊额为 0（不出现在 alloc 或值为 0）', function () {
    var res = C.allocateExpense(exp, data);
    var v = res.alloc['wf'];
    assert.ok(v === undefined || cents(v) === 0, '未参与者应为 0/不存在, got ' + v);
  });

  test('未参与者不计入该笔家庭应分摊：warnings 不含错误级提示', function () {
    var res = C.allocateExpense(exp, data);
    assert.strictEqual(res.warnings.filter(function (w) { return w.indexOf('【错误】') === 0; }).length, 0);
    assert.strictEqual(sumAllocCents(res.alloc), 30000);
  });
});

// ===========================================================================
// 算例 E —— 部分参加 + 非参加者归零（家庭汇总口径）
// ===========================================================================
group('算例 E：部分参加，非参加者不计入家庭应分摊', function () {
  var members = [
    mkMember('m1', 'f1', '张伟', 'adult'),
    mkMember('m2', 'f1', '张太', 'adult'),
    mkMember('m3', 'f1', '张小明', 'child'),
    mkMember('m4', 'f2', '李强', 'adult')
  ];
  var families = [{ id: 'f1', name: '张家' }, { id: 'f2', name: '李家' }];
  var data = mkData(members, families);
  data.expenses = [
    { id: 'eE', title: '部分参加', category: '其他', currency: 'CNY', amount: 100, rate: 1, payerMemberId: 'm1', splitMode: 'equal', participants: ['m1', 'm4'] }
  ];

  test('alloc 只含参与者 m1/m4，各 50.00（约定：非参加者不出现于 alloc）', function () {
    var res = C.allocateExpense(data.expenses[0], data);
    assert.deepStrictEqual(Object.keys(res.alloc).sort(), ['m1', 'm4']);
    assert.strictEqual(res.alloc['m1'], 50.0);
    assert.strictEqual(res.alloc['m4'], 50.0);
  });

  test('computeResult：非参加者 m2/m3 的个人应分摊 = 0，张家应为 50.00', function () {
    var r = C.computeResult(data);
    assert.strictEqual(r.perMember['m2'].share, 0);
    assert.strictEqual(r.perMember['m3'].share, 0);
    assert.strictEqual(r.perFamily['f1'].share, 50.0);
    assert.strictEqual(r.perFamily['f2'].share, 50.0);
  });
});

// ===========================================================================
// 算例 F —— 多币种
// ===========================================================================
group('算例 F：多币种折算与按币种汇总', function () {
  var members = [mkMember('m1', 'f1', '张伟', 'adult'), mkMember('m4', 'f2', '李强', 'adult')];
  var families = [{ id: 'f1', name: '张家' }, { id: 'f2', name: '李家' }];
  var data = mkData(members, families, [
    { code: 'USD', name: '美元', rate: 7.2 },
    { code: 'JPY', name: '日元', rate: 0.0485 }
  ]);
  data.expenses = [
    { id: 'f-usd', title: '巴士', category: '交通', currency: 'USD', amount: 100, rate: 7.2, payerMemberId: 'm1', splitMode: 'equal', participants: ['m1', 'm4'] },
    { id: 'f-jpy', title: '晚餐', category: '餐饮', currency: 'JPY', amount: 20000, rate: 0.0485, payerMemberId: 'm4', splitMode: 'equal', participants: ['m1', 'm4'] }
  ];

  test('USD 100 @7.2 折算 720.00', function () {
    assert.strictEqual(C.convertToBase(100, 7.2), 720.0);
  });

  test('byCurrency 分别按原币汇总', function () {
    var r = C.computeResult(data);
    assert.strictEqual(r.byCurrency['USD'].paid, 100);
    assert.strictEqual(r.byCurrency['USD'].baseEquivalent, 720.0);
    assert.strictEqual(r.byCurrency['JPY'].paid, 20000);
    assert.strictEqual(r.byCurrency['JPY'].baseEquivalent, 970.0); // 20000*0.0485 = 970
  });

  test('grandTotalBase = 各笔折算额之和 = 1690.00', function () {
    var r = C.computeResult(data);
    assert.strictEqual(r.grandTotalBase, 1690.0);
  });
});

// ===========================================================================
// 算例 G —— 转账方案必须能平账
// ===========================================================================
group('算例 G：多家庭多付款人，转账方案能完全平账', function () {
  var members = [
    mkMember('m1', 'f1', '张伟', 'adult'),
    mkMember('m2', 'f1', '张太', 'adult'),
    mkMember('m3', 'f2', '李强', 'adult'),
    mkMember('m4', 'f3', '王芳', 'adult')
  ];
  var families = [{ id: 'f1', name: '张家' }, { id: 'f2', name: '李家' }, { id: 'f3', name: '王家' }];
  var data = mkData(members, families);
  data.expenses = [
    { id: 'g1', title: 'e1', category: '其他', currency: 'CNY', amount: 300, rate: 1, payerMemberId: 'm1', splitMode: 'equal', participants: ['m1', 'm2', 'm3', 'm4'] },
    { id: 'g2', title: 'e2', category: '其他', currency: 'CNY', amount: 120, rate: 1, payerMemberId: 'm4', splitMode: 'equal', participants: ['m1', 'm2', 'm3', 'm4'] }
  ];
  var r = C.computeResult(data);
  var famIds = Object.keys(r.perFamily);

  test('a) 所有家庭 net 之和 = 0（以分为单位）', function () {
    var s = 0;
    famIds.forEach(function (f) { s += cents(r.perFamily[f].net); });
    assert.strictEqual(s, 0);
  });

  test('b) 逐笔执行 transfers 后每个家庭 net 归零（残差 ≤ 0.01，且若有残差须在 warnings 提示）', function () {
    var net = {};
    famIds.forEach(function (f) { net[f] = cents(r.perFamily[f].net); });
    r.transfers.forEach(function (t) {
      net[t.fromFamilyId] += cents(t.amount);
      net[t.toFamilyId] -= cents(t.amount);
    });
    var maxAbs = 0;
    famIds.forEach(function (f) { maxAbs = Math.max(maxAbs, Math.abs(net[f])); });
    assert.ok(maxAbs <= 1, '残差过大: ' + maxAbs + ' 分');
    if (maxAbs > 0) {
      var hasResidualWarn = r.warnings.some(function (w) { return w.indexOf('残差') !== -1; });
      assert.ok(hasResidualWarn, '存在残差但 warnings 未提示');
    }
  });

  test('c) 每个 transfer 金额 > 0，且笔数 ≤ 家庭数 − 1', function () {
    r.transfers.forEach(function (t) { assert.ok(t.amount > 0, '存在非正金额转账'); });
    assert.ok(r.transfers.length <= famIds.length - 1, '笔数 ' + r.transfers.length + ' > ' + (famIds.length - 1));
  });

  test('d) 收款总额 = 所有正 net 之和', function () {
    var sumPositive = 0;
    famIds.forEach(function (f) { var n = cents(r.perFamily[f].net); if (n > 0) sumPositive += n; });
    var sumTransfers = r.transfers.reduce(function (a, t) { return a + cents(t.amount); }, 0);
    assert.strictEqual(sumTransfers, sumPositive);
  });

  test('e) 具体方案符合手工推导：李家→张家 90.00，李家→王家 15.00', function () {
    var got = r.transfers.map(function (t) { return [t.fromFamilyId, t.toFamilyId, cents(t.amount)]; }).sort();
    var exp = [['f2', 'f1', 9000], ['f2', 'f3', 1500]].sort();
    assert.deepStrictEqual(got, exp);
  });
});

// ===========================================================================
// 算例 H —— 分币模糊测试
// ===========================================================================
group('算例 H：2000+ 随机费用，分币不丢（固定随机种子，可复现）', function () {
  var rnd = mulberry32(20260916);
  var MODES = ['equal', 'ticket', 'room', 'family', 'custom'];
  var TYPES = ['adult', 'elder', 'child'];

  // 构造 12 名成员、4 个家庭
  var members = [];
  var families = [];
  for (var fi = 0; fi < 4; fi++) families.push({ id: 'F' + fi, name: '家' + fi });
  for (var mi = 0; mi < 12; mi++) {
    members.push(mkMember('M' + mi, 'F' + (mi % 4), '成员' + mi, TYPES[Math.floor(rnd() * 3)]));
  }
  var data = mkData(members, families, [{ code: 'JPY', name: '日元', rate: 0.0485 }, { code: 'USD', name: '美元', rate: 7.2 }]);

  function pickParticipants() {
    var n = 1 + Math.floor(rnd() * 12); // 1..12
    var pool = members.map(function (m) { return m.id; });
    // Fisher-Yates 部分洗牌
    for (var i = pool.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
    }
    var picked = pool.slice(0, n);
    // 随机去重后可能重复添加（测去重鲁棒性）
    if (rnd() < 0.3) picked.push(picked[0]);
    return picked;
  }

  function buildExpense(idx) {
    var mode = MODES[Math.floor(rnd() * MODES.length)];
    var participants = pickParticipants();
    var amount = Math.round(rnd() * 10000000) / 100; // 0 ~ 100000.00 两位小数
    var rate = Math.round((1 + rnd() * 1500)) / 1000;  // 0.001 ~ 1.501? -> 用两位/三位
    // 更真实的汇率小数
    rate = [1, 1.0, 0.0485, 7.2, 0.1937, 0.85, 4.66, 0.0013, 12.3456][Math.floor(rnd() * 9)];
    var currency = ['CNY', 'JPY', 'USD'][Math.floor(rnd() * 3)];
    var exp = {
      id: 'Z' + idx, title: 'Z' + idx, category: '其他',
      currency: currency, amount: amount, rate: rate,
      payerMemberId: members[Math.floor(rnd() * members.length)].id,
      splitMode: mode, participants: participants,
      prices: { adult: 0, elder: 0, child: 0 }, rooms: [], customAmounts: {}
    };
    if (mode === 'ticket') {
      exp.prices = {
        adult: Math.round(rnd() * 100000) / 100,
        elder: Math.round(rnd() * 100000) / 100,
        child: Math.round(rnd() * 100000) / 100
      };
    } else if (mode === 'room') {
      var rn = 1 + Math.floor(rnd() * 4);
      for (var r = 0; r < rn; r++) {
        var occN = Math.floor(rnd() * 4); // 0..3 人
        var occ = participants.slice(0, occN);
        exp.rooms.push({ name: 'R' + r, price: Math.round(rnd() * 5000000) / 100, occupants: occ });
      }
    } else if (mode === 'custom') {
      var ca = {};
      participants.forEach(function (p) {
        if (rnd() < 0.7) ca[p] = Math.round(rnd() * 5000000) / 100;
      });
      exp.customAmounts = ca;
    }
    return exp;
  }

  test('2000 笔随机费用：每笔 sum(alloc) 分为单位 === 折算总额；且所有金额非负', function () {
    var N = 2000;
    var bad = [];
    for (var i = 0; i < N; i++) {
      var exp = buildExpense(i);
      var res = C.allocateExpense(exp, data);
      var totalCents = Math.round(exp.amount * exp.rate * 100);
      var got = sumAllocCents(res.alloc);
      if (got !== totalCents) {
        bad.push({ id: exp.id, mode: exp.splitMode, amount: exp.amount, rate: exp.rate, want: totalCents, got: got });
      }
      Object.keys(res.alloc).forEach(function (k) {
        if (res.alloc[k] < 0) bad.push({ id: exp.id, negative: res.alloc[k] });
      });
    }
    assert.strictEqual(bad.length, 0, '不满足「分币不丢」的用例数: ' + bad.length + ' 例一: ' + JSON.stringify(bad[0]));
  });

  test('随机 seed 复现性：同种子重跑得到相同首笔结果', function () {
    var r1 = mulberry32(20260916);
    var r2 = mulberry32(20260916);
    assert.strictEqual(r1(), r2());
    // 2000 笔全部再算一遍求校验和
    var chest = 0;
    for (var i = 0; i < 2000; i++) { chest += Math.round((r1() * 10000000)); }
    var chest2 = 0;
    for (var j = 0; j < 2000; j++) { chest2 += Math.round((r2() * 10000000)); }
    assert.strictEqual(chest, chest2);
  });
});

// ===========================================================================
// 算例 I —— 边界与异常
// ===========================================================================
group('算例 I：边界与异常', function () {
  var members = [mkMember('m1', 'f1', '张伟', 'adult'), mkMember('m2', 'f1', '张太', 'adult')];
  var families = [{ id: 'f1', name: '张家' }];
  var base = mkData(members, families);

  test('I1 参与者为空：不抛异常，出 error 级 warning，alloc 为空对象', function () {
    var exp = { id: 'i1', title: 'i1', currency: 'CNY', amount: 100, rate: 1, payerMemberId: 'm1', splitMode: 'equal', participants: [] };
    var res = C.allocateExpense(exp, base);
    assert.deepStrictEqual(res.alloc, {});
    assert.ok(res.warnings.some(function (w) { return w.indexOf('【错误】') === 0; }), '应有 error 级 warning');
  });

  test('I2 参与者含不存在的 memberId：不抛异常、有 warning、其余人正常分摊', function () {
    var exp = { id: 'i2', title: 'i2', currency: 'CNY', amount: 100, rate: 1, payerMemberId: 'm1', splitMode: 'equal', participants: ['m1', 'm2', 'GHOST'] };
    var res = C.allocateExpense(exp, base);
    assert.ok(res.warnings.some(function (w) { return w.indexOf('不存在') !== -1; }), '应有不存在 warning');
    assert.strictEqual(res.alloc['m1'], 50.0);
    assert.strictEqual(res.alloc['m2'], 50.0);
    assert.strictEqual(sumAllocCents(res.alloc), 10000);
  });

  test('I3 汇率 ≤ 0 时 validateData 报 error', function () {
    var d = mkData(members, families);
    d.expenses = [{ id: 'i3', title: 'i3', currency: 'XXX', amount: 100, rate: 0, payerMemberId: 'm1', splitMode: 'equal', participants: ['m1'] }];
    var v = C.validateData(d);
    assert.ok(!v.ok);
    assert.ok(v.errors.some(function (e) { return e.indexOf('汇率') !== -1; }), '应报汇率错误: ' + JSON.stringify(v.errors));
  });

  test('I4 金额为负时 validateData 报 error', function () {
    var d = mkData(members, families);
    d.expenses = [{ id: 'i4', title: 'i4', currency: 'CNY', amount: -5, rate: 1, payerMemberId: 'm1', splitMode: 'equal', participants: ['m1'] }];
    var v = C.validateData(d);
    assert.ok(!v.ok);
    assert.ok(v.errors.some(function (e) { return e.indexOf('金额') !== -1; }), '应报金额错误: ' + JSON.stringify(v.errors));
  });

  test('I5 amount = 0：所有人分摊 0，不报错', function () {
    var exp = { id: 'i5', title: 'i5', currency: 'CNY', amount: 0, rate: 1, payerMemberId: 'm1', splitMode: 'equal', participants: ['m1', 'm2'] };
    var res = C.allocateExpense(exp, base);
    assert.strictEqual(res.total, 0);
    assert.strictEqual(cents(res.alloc['m1']), 0);
    assert.strictEqual(cents(res.alloc['m2']), 0);
    assert.strictEqual(res.warnings.filter(function (w) { return w.indexOf('【错误】') === 0; }).length, 0);
  });

  test('I6 单人参加、单家庭参加：不产生转账', function () {
    var d = mkData(members, families);
    d.expenses = [{ id: 'i6', title: 'i6', currency: 'CNY', amount: 200, rate: 1, payerMemberId: 'm1', splitMode: 'equal', participants: ['m1'] }];
    var r = C.computeResult(d);
    assert.strictEqual(r.transfers.length, 0);
    assert.strictEqual(cents(r.perFamily['f1'].net), 0);
  });

  test('I7 房间 occupants 为空：有 warning 且不崩', function () {
    var exp = {
      id: 'i7', title: 'i7', currency: 'CNY', amount: 100, rate: 1, payerMemberId: 'm1',
      splitMode: 'room', participants: ['m1', 'm2'],
      rooms: [{ name: 'X房', price: 100, occupants: [] }]
    };
    var res = C.allocateExpense(exp, base);
    assert.ok(res.warnings.some(function (w) { return w.indexOf('没有有效入住人') !== -1; }), '应提示无入住人: ' + JSON.stringify(res.warnings));
    assert.strictEqual(sumAllocCents(res.alloc), 10000); // 仍精确等于总额
  });

  test('I8 门票单价合计 ≠ 项目总额：按比例缩放 + 中文 warning，缩放后合计仍精确', function () {
    var exp = {
      id: 'i8', title: 'i8', currency: 'CNY', amount: 1000, rate: 1, payerMemberId: 'm1',
      splitMode: 'ticket', participants: ['m1', 'm2'],
      prices: { adult: 100, elder: 0, child: 0 } // 合计 200 ≠ 1000
    };
    var res = C.allocateExpense(exp, base);
    var scaleWarn = res.warnings.filter(function (w) { return w.indexOf('不一致') !== -1; });
    assert.strictEqual(scaleWarn.length, 1, '应有 1 条缩放 warning: ' + JSON.stringify(res.warnings));
    assert.ok(/[\u4e00-\u9fa5]/.test(scaleWarn[0]), 'warning 应为中文');
    assert.strictEqual(sumAllocCents(res.alloc), 100000); // 仍精确等于 1000.00
    assert.strictEqual(res.alloc['m1'], 500.0);
    assert.strictEqual(res.alloc['m2'], 500.0);
  });
});

// ===========================================================================
// 附加：默认示例数据（与 app.js defaultData 同构）应通过校验
// ===========================================================================
group('附加：app.js 默认示例数据结构应可通过 validateData 且无 error', function () {
  function mk(id, familyId, name, type) { return { id: id, familyId: familyId, name: name, type: type }; }
  var sample = {
    version: 1, tripName: '2026 日本亲子游', baseCurrency: 'CNY',
    currencies: [
      { code: 'CNY', name: '人民币', rate: 1 },
      { code: 'JPY', name: '日元', rate: 0.0485 },
      { code: 'USD', name: '美元', rate: 7.2 }
    ],
    families: [{ id: 'f1', name: '张家' }, { id: 'f2', name: '李家' }, { id: 'f3', name: '王家' }],
    members: [
      mk('m1', 'f1', '张伟', 'adult'), mk('m2', 'f1', '王芳', 'adult'), mk('m3', 'f1', '张小明', 'child'),
      mk('m4', 'f2', '李强', 'adult'), mk('m5', 'f2', '刘敏', 'adult'), mk('m6', 'f2', '李奶奶', 'elder'),
      mk('m7', 'f3', '王军', 'adult'), mk('m8', 'f3', '王乐乐', 'child')
    ],
    expenses: [
      { id: 'e1', date: '2026-10-01', title: '环球影城门票', category: '门票', currency: 'JPY', amount: 53000, rate: 0.0485, payerMemberId: 'm1', splitMode: 'ticket', participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], prices: { adult: 8000, elder: 5000, child: 4000 }, rooms: [], customAmounts: {}, note: '' },
      { id: 'e2', date: '2026-10-01', title: '酒店住宿（2晚）', category: '住宿', currency: 'JPY', amount: 96000, rate: 0.0485, payerMemberId: 'm4', splitMode: 'room', participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], prices: { adult: 0, elder: 0, child: 0 }, rooms: [{ name: 'A房', price: 36000, occupants: ['m1', 'm2', 'm3'] }, { name: 'B房', price: 36000, occupants: ['m4', 'm5', 'm6'] }, { name: 'C房', price: 24000, occupants: ['m7', 'm8'] }], customAmounts: {}, note: '' },
      { id: 'e3', date: '2026-10-02', title: '团队晚餐', category: '餐饮', currency: 'JPY', amount: 24000, rate: 0.0485, payerMemberId: 'm2', splitMode: 'equal', participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], prices: { adult: 0, elder: 0, child: 0 }, rooms: [], customAmounts: {}, note: '' },
      { id: 'e4', date: '2026-10-02', title: '租车费用', category: '交通', currency: 'JPY', amount: 30000, rate: 0.0485, payerMemberId: 'm7', splitMode: 'family', participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], prices: { adult: 0, elder: 0, child: 0 }, rooms: [], customAmounts: {}, note: '' },
      { id: 'e5', date: '2026-10-03', title: '药妆采购', category: '购物', currency: 'JPY', amount: 23000, rate: 0.0485, payerMemberId: 'm5', splitMode: 'custom', participants: ['m1', 'm2', 'm4', 'm5', 'm7'], prices: { adult: 0, elder: 0, child: 0 }, rooms: [], customAmounts: { m1: 5000, m2: 9000, m4: 3000, m5: 4000, m7: 2000 }, note: '' },
      { id: 'e6', date: '2026-10-03', title: '机场接送巴士', category: '交通', currency: 'USD', amount: 150, rate: 7.2, payerMemberId: 'm7', splitMode: 'equal', participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], prices: { adult: 0, elder: 0, child: 0 }, rooms: [], customAmounts: {}, note: '' },
      { id: 'e7', date: '2026-10-04', title: '景区缆车', category: '门票', currency: 'CNY', amount: 1300, rate: 1, payerMemberId: 'm1', splitMode: 'ticket', participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'], prices: { adult: 200, elder: 100, child: 100 }, rooms: [], customAmounts: {}, note: '' }
    ]
  };

  test('validateData(sample).ok === true 且 errors 为空', function () {
    var v = C.validateData(sample);
    assert.strictEqual(v.ok, true, 'errors=' + JSON.stringify(v.errors));
    assert.strictEqual(v.errors.length, 0);
  });

  test('computeResult(sample) 无 error、可平账、每笔分币不丢', function () {
    var r = C.computeResult(sample);
    assert.strictEqual(r.errors.length, 0, 'errors=' + JSON.stringify(r.errors));
    // 每家净额之和为 0
    var s = 0;
    Object.keys(r.perFamily).forEach(function (f) { s += cents(r.perFamily[f].net); });
    assert.strictEqual(s, 0);
    // 每笔费用分币不丢
    Object.keys(r.perExpense).forEach(function (k) {
      var pe = r.perExpense[k];
      assert.strictEqual(sumAllocCents(pe.alloc), cents(pe.total), 'perExpense ' + k);
    });
  });
});

// ---------------------------------------------------------------------------
// 汇总
// ---------------------------------------------------------------------------
console.log('\n====================================================');
console.log('总计：' + (passed + failed) + ' 个用例  |  通过 ' + passed + '  |  失败 ' + failed);
console.log('====================================================');
if (failed > 0) {
  console.log('\n失败明细：');
  failures.forEach(function (f, i) {
    console.log((i + 1) + ') ' + f.name);
    console.log('    ' + (f.err && f.err.message ? f.err.message : f.err));
  });
  process.exitCode = 1;
}

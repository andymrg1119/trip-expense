/**
 * calc.js —— 多家庭出游记账的「核心算法」纯逻辑模块。
 *
 * 设计目标：
 *  1. 不依赖任何 DOM / 浏览器 API，可在 Node 中直接单元测试。
 *  2. 全程使用「整数分」运算，杜绝浮点误差，保证任何一笔费用拆分后
 *     各成员分摊额之和与总额「以分为单位完全相等」（不丢 0.01、不多 0.01）。
 *  3. UMD 风格：浏览器挂到 window.TripCalc，Node 走 module.exports。
 *
 * 导出函数：validateData / allocateExpense / computeResult / convertToBase / newId
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TripCalc = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CENT = 100; // 1 元 = 100 分

  // ---------------------------------------------------------------------------
  // 基础工具
  // ---------------------------------------------------------------------------

  /** 生成一个够用的唯一 id（时间戳 + 随机串）。 */
  function newId() {
    return 'id-' + Date.now().toString(36) + '-' +
      Math.random().toString(36).slice(2, 8);
  }

  /** 金额（元）→ 整数分，四舍五入。 */
  function toCents(x) {
    return Math.round(Number(x) * CENT);
  }

  /** 整数分 → 金额（元），保留 2 位小数。 */
  function fromCents(c) {
    return Math.round(c) / CENT;
  }

  /** 保留 2 位小数。 */
  function round2(x) {
    return Math.round(Number(x) * CENT) / CENT;
  }

  /** 统一的小数展示（内部用，仅用于 warning 文案）。 */
  function num2(x) {
    var v = Number(x);
    if (!isFinite(v)) v = 0;
    return (Math.round(v * CENT) / CENT).toFixed(2);
  }

  /** 错误级提示统一前缀，UI 层可据此标红。 */
  function errorMsg(msg) {
    return '【错误】' + msg;
  }

  // ---------------------------------------------------------------------------
  // 导出函数 1：convertToBase
  // ---------------------------------------------------------------------------

  /**
   * 把「原币金额」按汇率折算成基准货币，保留 2 位小数。
   * 内部先转成「分」再计算，避免 0.1 + 0.2 这类浮点误差。
   *
   * @param {number} amount 原币金额
   * @param {number} rate   1 单位原币折合多少基准货币
   * @return {number} 基准货币金额（2 位小数）
   */
  function convertToBase(amount, rate) {
    var a = Number(amount);
    var r = Number(rate);
    if (!isFinite(a) || !isFinite(r)) return 0;
    return fromCents(Math.round(a * r * CENT));
  }

  // ---------------------------------------------------------------------------
  // 核心：按权重把「总额（分）」精确分配到各成员
  // ---------------------------------------------------------------------------

  /**
   * 最大余额法（largest remainder method）：
   * 先按权重取整（向下取整），把总额与已分配额的差额（0..n-1 分）
   * 依次补给「小数部分最大」的成员，从而保证 sum(结果) === totalCents。
   *
   * @param {number} totalCents 总额（整数分）
   * @param {Array<{id:string, weight:number}>} entries 各成员及其权重
   * @return {Object} { [memberId]: 分配到的分 }
   */
  function distributeByWeights(totalCents, entries) {
    var result = {};
    var n = entries.length;
    if (n === 0) return result;

    var sumW = 0;
    var i;
    for (i = 0; i < n; i++) {
      var w = Number(entries[i].weight);
      if (!isFinite(w) || w < 0) w = 0;
      entries[i].weight = w;
      sumW += w;
    }
    // 权重全为 0（或异常）时退化为「人头均摊」。
    if (sumW <= 0) {
      for (i = 0; i < n; i++) entries[i].weight = 1;
      sumW = n;
    }

    var floors = [];
    var allocated = 0;
    for (i = 0; i < n; i++) {
      var raw = totalCents * entries[i].weight / sumW;
      var f = Math.floor(raw);
      if (f < 0) f = 0;
      floors.push({ id: entries[i].id, floor: f, rem: raw - f });
      allocated += f;
    }

    var leftover = totalCents - allocated;
    // 按小数部分从大到小排序，依次 +1 分补齐尾差。
    var order = floors.slice().sort(function (a, b) { return b.rem - a.rem; });
    for (var k = 0; k < leftover && order.length > 0; k++) {
      order[k % order.length].floor += 1;
    }

    for (i = 0; i < floors.length; i++) {
      // 同一成员若出现多次取最后一次（去重逻辑已在调用前保证唯一）
      result[floors[i].id] = (result[floors[i].id] || 0) + floors[i].floor;
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // 各分摊方式的「权重」计算
  // ---------------------------------------------------------------------------

  /**
   * 把「原始权重合计」缩放到「项目总额」，若不一致给出 warning。
   * 仅用于 ticket / room / custom 三种「权重本身即金额」的模式。
   */
  function scaleWeights(weights, sum, amount, warnings, label) {
    if (sum <= 0) {
      for (var i = 0; i < weights.length; i++) weights[i] = 1;
      if (amount > 0) warnings.push(label + '合计为 0 或缺失，已按人头均摊处理');
      return;
    }
    var diff = Math.abs(sum - amount);
    if (diff > 0.005) {
      var ratio = amount / sum;
      for (var j = 0; j < weights.length; j++) weights[j] *= ratio;
      warnings.push(label + '合计 ' + num2(sum) + ' 与项目总额 ' +
        num2(amount) + ' 不一致，已按比例调整');
    }
  }

  /** 根据分摊方式计算每个参与成员的权重。 */
  function computeWeights(expense, parts, memberMap, amount, warnings) {
    var mode = expense.splitMode || 'equal';
    var weights = [];
    var i;

    if (mode === 'equal') {
      for (i = 0; i < parts.length; i++) weights.push(1);
      return weights;
    }

    if (mode === 'family') {
      // 「先按家庭均分、再按家庭内部均分」可等价表达为权重
      //   成员权重 = 1 / (参与家庭数 × 该家庭参与人数)
      var famCount = {};
      for (i = 0; i < parts.length; i++) {
        var fid = memberMap[parts[i]].familyId;
        famCount[fid] = (famCount[fid] || 0) + 1;
      }
      var famN = 0;
      for (var key in famCount) {
        if (famCount.hasOwnProperty(key)) famN += 1;
      }
      if (famN === 0) famN = 1;
      for (i = 0; i < parts.length; i++) {
        var f2 = memberMap[parts[i]].familyId;
        weights.push(1 / (famN * famCount[f2]));
      }
      return weights;
    }

    if (mode === 'ticket') {
      var prices = expense.prices || {};
      var sumT = 0;
      for (i = 0; i < parts.length; i++) {
        var t = memberMap[parts[i]].type || 'adult';
        var p = Number(prices[t]);
        if (!isFinite(p) || p < 0) p = 0;
        weights.push(p);
        sumT += p;
      }
      scaleWeights(weights, sumT, amount, warnings, '门票单价');
      return weights;
    }

    if (mode === 'room') {
      var rooms = Array.isArray(expense.rooms) ? expense.rooms : [];
      var w = [];
      for (i = 0; i < parts.length; i++) w.push(0);
      var roomSum = 0;
      var roomsWithOcc = 0; // 至少有一位「有效入住人」的房间数
      var emptyRooms = [];  // 「填了房价但无有效入住人」的房间名
      for (var r = 0; r < rooms.length; r++) {
        var room = rooms[r] || {};
        var occ = Array.isArray(room.occupants) ? room.occupants : [];
        var occValid = [];
        for (var o = 0; o < occ.length; o++) {
          if (parts.indexOf(occ[o]) !== -1 && occValid.indexOf(occ[o]) === -1) {
            occValid.push(occ[o]);
          }
        }
        var price = Number(room.price);
        if (!isFinite(price) || price < 0) price = 0;
        roomSum += price;
        if (occValid.length === 0) {
          if (price > 0) emptyRooms.push(room.name || '');
          continue;
        }
        roomsWithOcc++;
        var per = price / occValid.length;
        for (var q = 0; q < occValid.length; q++) {
          var idx = parts.indexOf(occValid[q]);
          if (idx !== -1) w[idx] += per;
        }
      }

      // 情形一：所有房间都没有有效入住人 → 权重全 0。
      // 行为：该费用总额按「全体参与成员」平均分摊（保持原有兜底行为不变，
      //       由 distributeByWeights 的「权重全 0 → 人头均摊」逻辑完成）。
      if (roomsWithOcc === 0) {
        warnings.push('【房间】各房间均未指定入住人（没有有效入住人），房间费用已按参与人平均分摊');
        return w;
      }

      // 情形二：部分房间没有有效入住人，其他房间有人。
      // 行为：无入住人房间的房价不单列，而是随总额按比例分摊给其他房间的入住人。
      for (var en = 0; en < emptyRooms.length; en++) {
        warnings.push('【房间】「' + emptyRooms[en] + '」未指定入住人（没有有效入住人），其房价已按比例分摊至其他入住人');
      }
      scaleWeights(w, roomSum, amount, warnings, '房间房价');
      return w;
    }

    if (mode === 'custom') {
      var ca = expense.customAmounts || {};
      var w2 = [];
      var cs = 0;
      for (i = 0; i < parts.length; i++) {
        var v = Number(ca[parts[i]]);
        if (!isFinite(v) || v < 0) v = 0;
        w2.push(v);
        cs += v;
      }
      scaleWeights(w2, cs, amount, warnings, '自定义金额');
      return w2;
    }

    // 未知分摊方式 → 退化为人头均摊
    warnings.push('未知分摊方式「' + mode + '」，已按人头均摊处理');
    for (i = 0; i < parts.length; i++) weights.push(1);
    return weights;
  }

  // ---------------------------------------------------------------------------
  // 导出函数 2：allocateExpense
  // ---------------------------------------------------------------------------

  /**
   * 计算「单笔费用」在基准货币下每个参与成员应分摊的金额。
   *
   * 返回：{ alloc: { memberId: 金额(基准币，2位小数) }, warnings: string[], total: number }
   * 硬性保证：以「分」为单位，sum(alloc) 与 total 完全相等。
   */
  function allocateExpense(expense, data) {
    var warnings = [];
    data = data || {};
    expense = expense || {};
    var members = Array.isArray(data.members) ? data.members : [];

    // ---- 汇率：优先用费用自带 rate，否则回退到币种表 ----
    var rate = Number(expense.rate);
    if (!isFinite(rate) || rate <= 0) {
      rate = lookupRate(data, expense.currency);
    }
    if (!isFinite(rate) || rate <= 0) {
      warnings.push(errorMsg('汇率无效，无法折算：' + (expense.currency || '')));
      return { alloc: {}, warnings: warnings, total: 0 };
    }

    // ---- 金额校验 ----
    var amount = Number(expense.amount);
    if (!isFinite(amount) || amount < 0) {
      warnings.push(errorMsg('金额无效：' + expense.amount));
      return { alloc: {}, warnings: warnings, total: 0 };
    }

    var totalCents = Math.round(amount * rate * CENT);

    // ---- 成员索引 ----
    var memberMap = {};
    for (var i = 0; i < members.length; i++) memberMap[members[i].id] = members[i];

    // ---- 参与人去重 + 存在性校验 ----
    var raw = Array.isArray(expense.participants) ? expense.participants : [];
    var parts = [];
    for (var j = 0; j < raw.length; j++) {
      var mid = raw[j];
      if (parts.indexOf(mid) !== -1) continue;
      if (!memberMap[mid]) {
        warnings.push('参与成员 ' + mid + ' 不存在，已跳过');
        continue;
      }
      parts.push(mid);
    }

    if (parts.length === 0) {
      warnings.push(errorMsg('本笔费用没有有效的参与成员，无法分摊'));
      return { alloc: {}, warnings: warnings, total: fromCents(totalCents) };
    }

    // ---- 权重 → 精确分配 ----
    var weights = computeWeights(expense, parts, memberMap, amount, warnings);
    var entries = [];
    for (var k = 0; k < parts.length; k++) {
      entries.push({ id: parts[k], weight: weights[k] });
    }
    var centsAlloc = distributeByWeights(totalCents, entries);

    var alloc = {};
    for (var id in centsAlloc) {
      if (centsAlloc.hasOwnProperty(id)) alloc[id] = fromCents(centsAlloc[id]);
    }
    return { alloc: alloc, warnings: warnings, total: fromCents(totalCents) };
  }

  /** 从币种表里查找汇率，找不到返回 NaN（由调用方处理）。 */
  function lookupRate(data, code) {
    var currencies = Array.isArray(data && data.currencies) ? data.currencies : [];
    for (var i = 0; i < currencies.length; i++) {
      if (currencies[i] && currencies[i].code === code) {
        var r = Number(currencies[i].rate);
        return isFinite(r) ? r : NaN;
      }
    }
    return NaN;
  }

  // ---------------------------------------------------------------------------
  // 导出函数 3：validateData
  // ---------------------------------------------------------------------------

  /**
   * 校验整份数据的完整性。
   * @return {{ok:boolean, errors:string[], warnings:string[]}}
   */
  function validateData(data) {
    var errors = [];
    var warnings = [];

    if (!data || typeof data !== 'object') {
      return { ok: false, errors: ['数据为空或格式错误'], warnings: warnings };
    }

    var base = data.baseCurrency;
    if (!base) errors.push('缺少基准货币 baseCurrency');

    // ---- 币种 ----
    var currencies = Array.isArray(data.currencies) ? data.currencies : [];
    var rateMap = {};
    for (var i = 0; i < currencies.length; i++) {
      var c = currencies[i] || {};
      if (!c.code) { warnings.push('存在缺少 code 的币种，已忽略'); continue; }
      var r = Number(c.rate);
      if (!isFinite(r) || r <= 0) {
        errors.push('币种 ' + c.code + ' 的汇率必须大于 0');
      }
      rateMap[c.code] = r;
    }
    if (base && !(base in rateMap)) {
      warnings.push('基准货币 ' + base + ' 未在币种列表中，按汇率 1 处理');
    }
    if (base) rateMap[base] = 1;

    // ---- 家庭 ----
    var families = Array.isArray(data.families) ? data.families : [];
    var famIds = {};
    for (var f = 0; f < families.length; f++) {
      var fam = families[f] || {};
      if (!fam.id) { errors.push('存在缺少 id 的家庭'); continue; }
      if (famIds[fam.id]) warnings.push('家庭 id 重复：' + fam.id);
      famIds[fam.id] = true;
    }

    // ---- 成员 ----
    var members = Array.isArray(data.members) ? data.members : [];
    var memberIds = {};
    var validTypes = { adult: 1, elder: 1, child: 1 };
    for (var m = 0; m < members.length; m++) {
      var mm = members[m] || {};
      if (!mm.id) { errors.push('存在缺少 id 的成员'); continue; }
      if (memberIds[mm.id]) warnings.push('成员 id 重复：' + mm.id);
      memberIds[mm.id] = true;
      var label = mm.name || mm.id;
      if (!mm.familyId) {
        errors.push('成员 ' + label + ' 未指定所属家庭');
      } else if (!famIds[mm.familyId]) {
        errors.push('成员 ' + label + ' 的家庭「' + mm.familyId + '」不存在（孤立引用）');
      }
      if (mm.type && !validTypes[mm.type]) {
        warnings.push('成员 ' + label + ' 的类型「' + mm.type + '」未知，按成人处理');
      }
    }

    // ---- 费用 ----
    var expenses = Array.isArray(data.expenses) ? data.expenses : [];
    var validModes = ['equal', 'ticket', 'room', 'family', 'custom'];
    for (var e = 0; e < expenses.length; e++) {
      var ex = expenses[e] || {};
      var eid = ex.title ? ('「' + ex.title + '」') : ('第 ' + (e + 1) + ' 笔');

      var amt = Number(ex.amount);
      if (!isFinite(amt) || amt < 0) errors.push('费用' + eid + '金额无效或为负');

      var er = Number(ex.rate);
      if (!isFinite(er) || er <= 0) {
        if (ex.currency && isFinite(rateMap[ex.currency]) && rateMap[ex.currency] > 0) {
          warnings.push('费用' + eid + '未填汇率，将使用币种 ' + ex.currency + ' 的默认汇率');
        } else {
          errors.push('费用' + eid + '的汇率必须大于 0');
        }
      }

      if (ex.currency && !(ex.currency in rateMap)) {
        warnings.push('费用' + eid + '使用了未登记币种 ' + ex.currency);
      }

      if (!ex.payerMemberId || !memberIds[ex.payerMemberId]) {
        errors.push('费用' + eid + '的付款人不存在（孤立引用）');
      }

      var parts = Array.isArray(ex.participants) ? ex.participants : [];
      if (parts.length === 0) errors.push('费用' + eid + '没有参与成员');
      for (var p = 0; p < parts.length; p++) {
        if (!memberIds[parts[p]]) {
          warnings.push('费用' + eid + '的参与成员 ' + parts[p] + ' 不存在，将被跳过');
        }
      }

      var mode = ex.splitMode || 'equal';
      if (validModes.indexOf(mode) === -1) {
        warnings.push('费用' + eid + '的分摊方式未知：' + mode);
      }

      if (mode === 'room') {
        var rooms = Array.isArray(ex.rooms) ? ex.rooms : [];
        if (rooms.length === 0) warnings.push('费用' + eid + '使用房间分摊但未配置房间');
        for (var rr = 0; rr < rooms.length; rr++) {
          var room = rooms[rr] || {};
          if (!Array.isArray(room.occupants) || room.occupants.length === 0) {
            warnings.push('费用' + eid + '的房间「' + (room.name || '') + '」没有入住人');
          }
        }
      }

      if (mode === 'custom') {
        if (!ex.customAmounts || typeof ex.customAmounts !== 'object') {
          warnings.push('费用' + eid + '使用自定义金额但未填写金额');
        }
      }
    }

    return { ok: errors.length === 0, errors: errors, warnings: warnings };
  }

  // ---------------------------------------------------------------------------
  // 导出函数 4：computeResult
  // ---------------------------------------------------------------------------

  /**
   * 计算完整结算结果（家庭汇总 + 转账方案 + 各类汇总）。
   *
   * 转账方案用「贪心最大债务 / 最大债权配对」，生成尽量少的笔数；
   * 由于全程整数分运算，方案可完全平账（残差恒为 0）。
   */
  function computeResult(data) {
    data = data || {};
    var v = validateData(data);
    var errors = v.errors.slice();
    var warnings = v.warnings.slice();

    var baseCurrency = data.baseCurrency || 'CNY';
    var members = Array.isArray(data.members) ? data.members : [];
    var families = Array.isArray(data.families) ? data.families : [];
    var expenses = Array.isArray(data.expenses) ? data.expenses : [];

    // 成员索引
    var memberMap = {};
    for (var mi = 0; mi < members.length; mi++) memberMap[members[mi].id] = members[mi];

    // 分（整数）累加器
    var shareCents = {};
    var paidCents = {};
    for (var m0 = 0; m0 < members.length; m0++) {
      shareCents[members[m0].id] = 0;
      paidCents[members[m0].id] = 0;
    }

    var perExpense = {};
    var byCurrency = {};
    var byCategory = {};
    var grandTotalCents = 0;

    for (var e = 0; e < expenses.length; e++) {
      var ex = expenses[e] || {};
      var res = allocateExpense(ex, data);
      var key = ex.id || String(e);
      perExpense[key] = { alloc: res.alloc, warnings: res.warnings, total: res.total };
      for (var wi = 0; wi < res.warnings.length; wi++) {
        warnings.push(prefixExpense(ex, res.warnings[wi]));
      }

      var totalCents = Math.round(res.total * CENT);
      grandTotalCents += totalCents;

      // 分摊（share）
      for (var mid in res.alloc) {
        if (!res.alloc.hasOwnProperty(mid)) continue;
        if (shareCents[mid] === undefined) shareCents[mid] = 0;
        shareCents[mid] += Math.round(res.alloc[mid] * CENT);
      }

      // 垫付（paid）：归到付款人
      if (ex.payerMemberId) {
        if (paidCents[ex.payerMemberId] === undefined) paidCents[ex.payerMemberId] = 0;
        paidCents[ex.payerMemberId] += totalCents;
      } else {
        warnings.push(prefixExpense(ex, '缺少付款人，该笔垫付未计入任何家庭'));
      }

      // 按币种汇总（原币 + 折算）
      var cur = ex.currency || baseCurrency;
      if (!byCurrency[cur]) byCurrency[cur] = { paid: 0, baseEquivalent: 0 };
      byCurrency[cur].paid = round2(byCurrency[cur].paid + (Number(ex.amount) || 0));
      byCurrency[cur].baseEquivalent = round2(byCurrency[cur].baseEquivalent + (Number(res.total) || 0));

      // 按类别汇总
      var cat = ex.category || '其他';
      if (!byCategory[cat]) byCategory[cat] = { base: 0, count: 0 };
      byCategory[cat].base = round2(byCategory[cat].base + (Number(res.total) || 0));
      byCategory[cat].count += 1;
    }

    // ---- 成员明细 ----
    var perMember = {};
    for (var pm = 0; pm < members.length; pm++) {
      var mem = members[pm];
      var s = shareCents[mem.id] || 0;
      var pd = paidCents[mem.id] || 0;
      perMember[mem.id] = {
        name: mem.name,
        familyId: mem.familyId,
        share: fromCents(s),
        paid: fromCents(pd),
        net: fromCents(pd - s)
      };
    }

    // ---- 家庭明细 ----
    // 先按 families 建骨架，再把成员归入；若成员家庭不存在则建「未分组」桶，
    // 保证「所有家庭净额之和 = 0」，转账方案才能完全平账。
    var perFamily = {};
    var famShareCents = {};
    var famPaidCents = {};
    for (var ff = 0; ff < families.length; ff++) {
      var ffid = families[ff].id;
      perFamily[ffid] = {
        name: families[ff].name,
        memberCount: 0, share: 0, paid: 0, net: 0, members: []
      };
      famShareCents[ffid] = 0;
      famPaidCents[ffid] = 0;
    }
    for (var gm = 0; gm < members.length; gm++) {
      var gmem = members[gm];
      var gid = gmem.familyId;
      if (gmem.familyId === undefined || gmem.familyId === null || gmem.familyId === '') {
        gid = '__orphan__';
      }
      if (!perFamily[gid]) {
        perFamily[gid] = { name: '（未分组）', memberCount: 0, share: 0, paid: 0, net: 0, members: [] };
        famShareCents[gid] = 0;
        famPaidCents[gid] = 0;
        warnings.push('成员「' + gmem.name + '」所属家庭不存在，已归入「（未分组）」');
      }
      var rec = perFamily[gid];
      rec.memberCount += 1;
      rec.members.push(gmem.id);
      famShareCents[gid] += shareCents[gmem.id] || 0;
      famPaidCents[gid] += paidCents[gmem.id] || 0;
    }
    for (var pf in perFamily) {
      if (!perFamily.hasOwnProperty(pf)) continue;
      perFamily[pf].share = fromCents(famShareCents[pf]);
      perFamily[pf].paid = fromCents(famPaidCents[pf]);
      perFamily[pf].net = fromCents(famPaidCents[pf] - famShareCents[pf]);
    }

    // ---- 转账方案（整数分，贪心配对）----
    var creditors = []; // 应收（net > 0）
    var debtors = [];   // 应付（net < 0）
    for (var tk in perFamily) {
      if (!perFamily.hasOwnProperty(tk)) continue;
      var netC = famPaidCents[tk] - famShareCents[tk];
      if (netC > 0) creditors.push({ fid: tk, amt: netC });
      else if (netC < 0) debtors.push({ fid: tk, amt: -netC });
    }
    creditors.sort(function (a, b) { return b.amt - a.amt; });
    debtors.sort(function (a, b) { return b.amt - a.amt; });

    var transfers = [];
    var ci = 0, di = 0, guard = 0;
    while (ci < creditors.length && di < debtors.length && guard < 1000000) {
      guard++;
      var pay = Math.min(creditors[ci].amt, debtors[di].amt);
      if (pay > 0) {
        transfers.push({
          fromFamilyId: debtors[di].fid,
          fromName: (perFamily[debtors[di].fid] || {}).name || '',
          toFamilyId: creditors[ci].fid,
          toName: (perFamily[creditors[ci].fid] || {}).name || '',
          amount: fromCents(pay)
        });
      }
      creditors[ci].amt -= pay;
      debtors[di].amt -= pay;
      if (creditors[ci].amt <= 0) ci++;
      if (debtors[di].amt <= 0) di++;
    }

    // 残差校验（整数分运算下应恒为 0）
    var residual = 0;
    for (var rc = 0; rc < creditors.length; rc++) residual += Math.max(0, creditors[rc].amt);
    for (var rd = 0; rd < debtors.length; rd++) residual += Math.max(0, debtors[rd].amt);
    if (residual > 0) {
      warnings.push('转账方案存在 ' + fromCents(residual) + ' 的舍入残差，已尽量平账');
    }

    return {
      baseCurrency: baseCurrency,
      grandTotalBase: fromCents(grandTotalCents),
      perMember: perMember,
      perFamily: perFamily,
      transfers: transfers,
      byCurrency: byCurrency,
      byCategory: byCategory,
      perExpense: perExpense,
      warnings: warnings,
      errors: errors
    };
  }

  /** 给 warning 加上费用标题前缀，便于在汇总里定位。 */
  function prefixExpense(ex, msg) {
    var name = (ex && (ex.title || ex.id)) || '费用';
    return '【' + name + '】' + msg;
  }

  // ---------------------------------------------------------------------------
  // 导出
  // ---------------------------------------------------------------------------
  return {
    validateData: validateData,
    allocateExpense: allocateExpense,
    computeResult: computeResult,
    convertToBase: convertToBase,
    newId: newId
  };
});

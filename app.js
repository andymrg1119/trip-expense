/**
 * app.js —— 多家庭出游记账与分摊的界面逻辑。
 *
 * 职责：DOM 渲染、表单增删改、localStorage 持久化、文件导入导出。
 * 算法全部委托给 calc.js（window.TripCalc），本文件只负责「展示与交互」。
 *
 * 安全约定：所有用户输入一律通过 textContent / value 写入，绝不使用
 * innerHTML 拼接用户内容，避免 XSS。
 */
(function () {
  'use strict';

  var C = window.TripCalc;
  // v2：多旅程库（{version:2, activeTripId, trips:[...]}）；v1：旧的单行程键（只读，仅用于一次性迁移，永不删除）
  var STORAGE_KEY_V2 = 'trip-expense-data-v2';
  var STORAGE_KEY_V1 = 'trip-expense-data-v1';
  // 安全备份键：每次会话首次写盘前，把上一份 v2 原文留底（只增不删）；解析异常时也存这里。
  // 目的：任何「版本更新 / 误操作 / 数据损坏」都不得让用户已录入的数据消失。
  var BACKUP_KEY = 'trip-expense-data-v2-backup';
  var backupTaken = false;             // 本次会话是否已留过底（同一会话只留一份，开销可忽略）
  var TYPE_LABELS = { adult: '成人', elder: '老人', child: '小孩' };
  var MODE_LABELS = {
    equal: '按人头均摊',
    ticket: '门票分档',
    room: '酒店房间',
    family: '按家庭均摊',
    custom: '自定义金额'
  };
  // 费用类别：仅作为「种子 / 兜底」——真正生效的列表按旅程存在 trip.categories 里
  var DEFAULT_CATEGORIES = ['门票', '住宿', '餐饮', '交通', '购物', '其他'];

  // 全局状态：
  //   state.library —— 旅程库 {version:2, activeTripId, trips:[...]}，整体持久化到 v2 键
  //   state.data    —— **恒等于「当前旅程对象本身」**（同一引用）：
  //                    state.data === findTrip(state.library, state.library.activeTripId)
  //                    因此下面所有 state.data.families/.members/.expenses/.currencies/.tripName
  //                    的渲染与操作代码完全无需改动。切换旅程只换引用 + renderAll()。
  var state = { library: null, data: null, loadBroken: false };
  // 当前正在编辑的费用草稿（弹窗内使用）
  var draft = null;

  // 瞬态 UI 标记（绝不写入费用数据、绝不参与持久化/导出）：
  // 记录当前弹窗会话中用户「确认过」的房间（房价框失焦、勾选/取消入住人、或点保存校验后）。
  // 仅用于决定红字提示的显示时机；打开/关闭弹窗时重置。
  var roomConfirmed = [];
  function isRoomConfirmed(room) { return roomConfirmed.indexOf(room) !== -1; }
  function confirmRoom(room) { if (roomConfirmed.indexOf(room) === -1) roomConfirmed.push(room); }

  // 「条目明细」相关的瞬态 UI 状态（同样不写入费用数据、不参与持久化/导出）：
  var familyEntriesExpanded = {};    // 家庭结算卡内「条目明细」的展开状态，按 familyId
  var selectedDetailFamilyId = null; // 「家庭明细」页签当前选中的家庭

  // ===========================================================================
  // 通用工具
  // ===========================================================================

  function $(id) { return document.getElementById(id); }

  /** 创建一个元素。 */
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  /** 清空子节点。 */
  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** 深拷贝（简单 JSON 结构足够）。 */
  function deepCopy(obj) { return JSON.parse(JSON.stringify(obj)); }

  /** 保留 2 位小数并加千分位。 */
  function money(n, symbol) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    var s = (Math.round(v * 100) / 100).toFixed(2);
    var neg = s.charAt(0) === '-';
    if (neg) s = s.slice(1);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    var out = (symbol || '') + parts.join('.');
    return neg ? '-' + out : out;
  }

  /** 保留 2 位小数的数字文本（不加符号）。 */
  function num2(n) {
    var v = Number(n);
    if (!isFinite(v)) v = 0;
    return (Math.round(v * 100) / 100).toFixed(2);
  }

  function typeLabel(t) { return TYPE_LABELS[t] || '成人'; }
  function modeLabel(m) { return MODE_LABELS[m] || m; }

  function todayStr() {
    var d = new Date();
    var mm = String(d.getMonth() + 1);
    var dd = String(d.getDate());
    if (mm.length < 2) mm = '0' + mm;
    if (dd.length < 2) dd = '0' + dd;
    return d.getFullYear() + '-' + mm + '-' + dd;
  }

  function memberById(id) {
    var list = state.data.members;
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function familyName(fid) {
    var list = state.data.families;
    for (var i = 0; i < list.length; i++) if (list[i].id === fid) return list[i].name;
    return '（未分组）';
  }

  function payerName(id) {
    var m = memberById(id);
    return m ? m.name : '（未指定）';
  }

  function currencyName(code) {
    var list = state.data.currencies;
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return list[i].name || code;
    return code;
  }

  function currencyRate(code) {
    var list = state.data.currencies;
    for (var i = 0; i < list.length; i++) if (list[i].code === code) return Number(list[i].rate) || 1;
    return 1;
  }

  function td(text) { return el('td', null, text); }

  // ===========================================================================
  // 页内提示（Toast）与确认对话框
  //
  // 为什么要自己实现：在嵌入式预览面板 / 沙箱 iframe 中，浏览器原生弹窗被禁用 ——
  //   原生的 prompt 直接返回 null（等同「取消」）、confirm 返回 false（等同「否」）、
  //   alert 被静默丢弃。结果是「重命名」「删除家庭」「删除费用」等操作点了没反应，
  //   而校验失败的提示用户也完全看不到。
  // 因此全应用不再调用任何原生弹窗，统一改用下面两个页内组件。
  // ===========================================================================

  var TOAST_MAX = 3; // 同屏最多保留的提示条数量，超出后移除最旧的一条
  var TOAST_DURATION = { error: 6000, success: 3000, info: 3000 };
  var confirmCallback = null;          // 当前确认框的回调
  var lastFocusedBeforeConfirm = null; // 打开确认框前的焦点，关闭后还原
  var storageWarned = false;           // localStorage 写失败只提示一次，避免刷屏

  /**
   * 显示一条页内提示条（替代浏览器原生 alert）。
   * @param {string} message 提示内容，支持 \n 换行（以 pre-line 呈现）
   * @param {string} type 'error' | 'success' | 'info'，缺省按 info 处理
   */
  function showToast(message, type) {
    var box = $('toast-container');
    if (!box) return;
    var kind = (type === 'error' || type === 'success') ? type : 'info';

    var toast = el('div', 'toast toast-' + kind);
    toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    toast.appendChild(el('div', 'toast-message', String(
      message === undefined || message === null ? '' : message)));

    var closeBtn = el('button', 'toast-close', '✕');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', '关闭提示');

    var timer = null;
    function dismiss() {
      if (timer !== null) { window.clearTimeout(timer); timer = null; }
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }
    closeBtn.addEventListener('click', dismiss);
    toast.addEventListener('click', function (ev) { if (ev.target !== closeBtn) dismiss(); });

    toast.appendChild(closeBtn);
    box.appendChild(toast);

    // 可控堆叠：只保留最近 TOAST_MAX 条，不会叠成一整屏
    while (box.children.length > TOAST_MAX) box.removeChild(box.firstChild);
    timer = window.setTimeout(dismiss, TOAST_DURATION[kind] || 3000);
  }

  /**
   * 打开页内确认对话框（替代浏览器原生 confirm）。
   * @param {{title:string, message:string, confirmText:string,
   *          cancelText:string, danger:boolean}} options
   * @param {function(boolean):void} callback 点「确定」时为 true，取消/关闭时为 false
   */
  function confirmDialog(options, callback) {
    var opt = options || {};
    var overlay = $('confirm-modal');
    var okBtn = $('confirm-ok-btn');
    var cancelBtn = $('confirm-cancel-btn');
    if (!overlay || !okBtn || !cancelBtn) {
      // 兜底：容器缺失时也不能让操作彻底卡死，按「用户已确认」继续
      callback(true);
      return;
    }

    $('confirm-modal-title').textContent = opt.title || '请确认';
    $('confirm-modal-message').textContent = opt.message || '';
    okBtn.textContent = opt.confirmText || '确定';
    cancelBtn.textContent = opt.cancelText || '取消';
    okBtn.className = 'btn ' + (opt.danger ? 'danger' : 'primary');

    confirmCallback = callback;
    lastFocusedBeforeConfirm = document.activeElement;
    overlay.classList.remove('hidden');

    // 危险操作把焦点放在「取消」上，避免回车误删；其余放在「确定」上
    try { (opt.danger ? cancelBtn : okBtn).focus(); } catch (e) { /* 忽略不支持聚焦的环境 */ }
  }

  /** 关闭确认框并把结果回调出去。 */
  function closeConfirmDialog(ok) {
    var overlay = $('confirm-modal');
    var cb = confirmCallback;
    confirmCallback = null;
    if (overlay) overlay.classList.add('hidden');
    if (lastFocusedBeforeConfirm && lastFocusedBeforeConfirm.focus) {
      try { lastFocusedBeforeConfirm.focus(); } catch (e) { /* 忽略 */ }
    }
    lastFocusedBeforeConfirm = null;
    if (typeof cb === 'function') cb(ok === true);
  }

  /** 确认框当前是否打开。 */
  function isConfirmOpen() {
    var overlay = $('confirm-modal');
    return !!overlay && !overlay.classList.contains('hidden');
  }

  // ===========================================================================
  // 示例数据 & 数据规范化
  // ===========================================================================

  function defaultData() {
    function mk(id, familyId, name, type) {
      return { id: id, familyId: familyId, name: name, type: type };
    }
    return {
      version: 1,
      tripName: '2026 日本亲子游',
      baseCurrency: 'CNY',
      categories: DEFAULT_CATEGORIES.slice(),
      currencies: [
        { code: 'CNY', name: '人民币', rate: 1 },
        { code: 'JPY', name: '日元', rate: 0.0485 },
        { code: 'USD', name: '美元', rate: 7.2 }
      ],
      families: [
        { id: 'f1', name: '张家' },
        { id: 'f2', name: '李家' },
        { id: 'f3', name: '王家' }
      ],
      members: [
        mk('m1', 'f1', '张伟', 'adult'),
        mk('m2', 'f1', '王芳', 'adult'),
        mk('m3', 'f1', '张小明', 'child'),
        mk('m4', 'f2', '李强', 'adult'),
        mk('m5', 'f2', '刘敏', 'adult'),
        mk('m6', 'f2', '李奶奶', 'elder'),
        mk('m7', 'f3', '王军', 'adult'),
        mk('m8', 'f3', '王乐乐', 'child')
      ],
      expenses: [
        {
          id: 'e1', date: '2026-10-01', title: '环球影城门票', category: '门票',
          currency: 'JPY', amount: 53000, rate: 0.0485, payerMemberId: 'm1',
          splitMode: 'ticket',
          participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
          prices: { adult: 8000, elder: 5000, child: 4000 },
          rooms: [], customAmounts: {}, note: '按成人/老人/小孩三档票价'
        },
        {
          id: 'e2', date: '2026-10-01', title: '酒店住宿（2晚）', category: '住宿',
          currency: 'JPY', amount: 96000, rate: 0.0485, payerMemberId: 'm4',
          splitMode: 'room',
          participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
          prices: { adult: 0, elder: 0, child: 0 },
          rooms: [
            { name: 'A房', price: 36000, occupants: ['m1', 'm2', 'm3'] },
            { name: 'B房', price: 36000, occupants: ['m4', 'm5', 'm6'] },
            { name: 'C房', price: 24000, occupants: ['m7', 'm8'] }
          ],
          customAmounts: {}, note: '三间房按入住人数分摊'
        },
        {
          id: 'e3', date: '2026-10-02', title: '团队晚餐', category: '餐饮',
          currency: 'JPY', amount: 24000, rate: 0.0485, payerMemberId: 'm2',
          splitMode: 'equal',
          participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
          prices: { adult: 0, elder: 0, child: 0 }, rooms: [], customAmounts: {},
          note: ''
        },
        {
          id: 'e4', date: '2026-10-02', title: '租车费用', category: '交通',
          currency: 'JPY', amount: 30000, rate: 0.0485, payerMemberId: 'm7',
          splitMode: 'family',
          participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
          prices: { adult: 0, elder: 0, child: 0 }, rooms: [], customAmounts: {},
          note: '三户家庭平分'
        },
        {
          id: 'e5', date: '2026-10-03', title: '药妆采购', category: '购物',
          currency: 'JPY', amount: 23000, rate: 0.0485, payerMemberId: 'm5',
          splitMode: 'custom',
          participants: ['m1', 'm2', 'm4', 'm5', 'm7'],
          prices: { adult: 0, elder: 0, child: 0 }, rooms: [],
          customAmounts: { m1: 5000, m2: 9000, m4: 3000, m5: 4000, m7: 2000 },
          note: '各人选购金额不同'
        },
        {
          id: 'e6', date: '2026-10-03', title: '机场接送巴士', category: '交通',
          currency: 'USD', amount: 150, rate: 7.2, payerMemberId: 'm7',
          splitMode: 'equal',
          participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
          prices: { adult: 0, elder: 0, child: 0 }, rooms: [], customAmounts: {},
          note: '美元支付'
        },
        {
          id: 'e7', date: '2026-10-04', title: '景区缆车', category: '门票',
          currency: 'CNY', amount: 1300, rate: 1, payerMemberId: 'm1',
          splitMode: 'ticket',
          participants: ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8'],
          prices: { adult: 200, elder: 100, child: 100 },
          rooms: [], customAmounts: {}, note: ''
        }
      ]
    };
  }

  /**
   * 向前兼容护栏：把 src 上「out 未声明的自有键」原样搬回 out。
   * 规范化的职责是「补默认值」，不是「白名单过滤」——否则将来某版新增的字段，
   * 被旧版逻辑一规范化就会永久丢失。加了这个，迁移与刷新都只增不减。
   */
  function preserveUnknown(src, out) {
    if (!src || typeof src !== 'object') return out;
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)
        && !Object.prototype.hasOwnProperty.call(out, k)) {
        out[k] = src[k];
      }
    }
    return out;
  }

  /** 规范化单笔费用，保证字段齐全、类型正确。 */
  function normalizeExpense(d) {
    d = d || {};
    var prices = d.prices || {};
    var custom = {};
    if (d.customAmounts && typeof d.customAmounts === 'object') {
      Object.keys(d.customAmounts).forEach(function (k) {
        var v = Number(d.customAmounts[k]);
        custom[k] = isFinite(v) ? v : 0;
      });
    }
    return preserveUnknown(d, {
      id: d.id || C.newId(),
      date: d.date || '',
      title: d.title || '',
      category: d.category || '其他',
      currency: d.currency || 'CNY',
      amount: Number(d.amount) || 0,
      rate: Number(d.rate) || 0,
      payerMemberId: d.payerMemberId || '',
      splitMode: d.splitMode || 'equal',
      participants: Array.isArray(d.participants) ? d.participants.slice() : [],
      prices: preserveUnknown(prices, {
        adult: Number(prices.adult) || 0,
        elder: Number(prices.elder) || 0,
        child: Number(prices.child) || 0
      }),
      rooms: Array.isArray(d.rooms) ? d.rooms.map(function (r) {
        r = r || {};
        return preserveUnknown(r, {
          name: r.name || '',
          price: Number(r.price) || 0,
          occupants: Array.isArray(r.occupants) ? r.occupants.slice() : []
        });
      }) : [],
      customAmounts: custom,
      note: d.note || ''
    });
  }

  /** 规范化整份数据。 */
  function normalizeData(obj) {
    obj = obj || {};
    // categories：数组且清洗后非空 → 原样保序保留（哪怕只剩 1 项）；否则补种子。
    // 这是 v1 / v2 / 导入 的唯一汇聚点，因此幂等性必须在此保证：
    // 用户把列表删减到只剩 1 项时，再次 normalize 不得把它还原成 6 项。
    var cats = Array.isArray(obj.categories)
      ? obj.categories.map(function (s) { return String(s == null ? '' : s).trim(); })
          .filter(function (s) { return s !== ''; })
      : [];
    if (!cats.length) cats = DEFAULT_CATEGORIES.slice();
    return preserveUnknown(obj, {
      version: obj.version || 1,
      tripName: obj.tripName || '我的家庭出游',
      baseCurrency: obj.baseCurrency || 'CNY',
      categories: cats,
      currencies: Array.isArray(obj.currencies) && obj.currencies.length
        ? obj.currencies.map(function (c) {
          c = c || {};
          return preserveUnknown(c, { code: c.code || 'CNY', name: c.name || c.code || '人民币', rate: Number(c.rate) || 1 });
        })
        : [{ code: 'CNY', name: '人民币', rate: 1 }],
      families: Array.isArray(obj.families) ? obj.families.map(function (f) {
        f = f || {};
        return preserveUnknown(f, { id: f.id || C.newId(), name: f.name || '未命名家庭' });
      }) : [],
      members: Array.isArray(obj.members) ? obj.members.map(function (m) {
        m = m || {};
        return preserveUnknown(m, {
          id: m.id || C.newId(),
          familyId: m.familyId || '',
          name: m.name || '未命名',
          type: (m.type === 'elder' || m.type === 'child') ? m.type : 'adult'
        });
      }) : [],
      expenses: Array.isArray(obj.expenses) ? obj.expenses.map(normalizeExpense) : []
    });
  }

  // ===========================================================================
  // 旅程库（多旅程 v2）与迁移
  //
  // 要点：
  //  · state.library 是「旅程库」，state.data 恒指向其中当前旅程对象本身（同一引用）。
  //  · 每个旅程内容字段沿用原名单行程的字段（含 tripName），仅新增 id / createdAt / updatedAt。
  //  · v1 旧键只读用于一次性迁移，绝不删除；迁移幂等（有 v2 就不再迁移）。
  // ===========================================================================

  /** 生成新 id（统一委托给 calc.js，避免引入额外依赖）。 */
  function uid() { return C.newId(); }

  /** 标记当前旅程「内容已变更」（save() 不碰 updatedAt，纯切换旅程也不调此函数）。 */
  function touchTrip() { if (state.data) state.data.updatedAt = new Date().toISOString(); }

  /** 新建一个空白旅程对象。 */
  function createEmptyTrip(name) {
    var now = new Date().toISOString();
    return {
      id: uid(), createdAt: now, updatedAt: now, version: 1,
      tripName: name || '我的旅程', baseCurrency: 'CNY',
      categories: DEFAULT_CATEGORIES.slice(),
      currencies: [{ code: 'CNY', name: '人民币', rate: 1 }],
      families: [], members: [], expenses: []
    };
  }

  /** 新建费用时的默认类别（当前旅程类别列表的首项）。 */
  function defaultCategory() { return state.data.categories[0] || DEFAULT_CATEGORIES[0]; }

  /**
   * 需要「改归」其它类别时的兜底类别：在给定（或当前生效的）列表里优先「其他」，否则取首项。
   * 删除类别时应传入「删除后的剩余列表」，避免选中正在被删的那一项。
   */
  function fallbackCategory(list) {
    list = Array.isArray(list) ? list : state.data.categories;
    return list.indexOf('其他') !== -1 ? '其他' : (list[0] || DEFAULT_CATEGORIES[0]);
  }

  /** 规范化「单个旅程」= 现有 normalizeData() + 补上 id / createdAt / updatedAt。 */
  function normalizeTrip(obj) {
    var src = obj || {};
    var t = normalizeData(src);
    t.id = src.id || uid();
    t.createdAt = src.createdAt || new Date().toISOString();
    t.updatedAt = src.updatedAt || t.createdAt;
    return t;
  }

  /** 默认旅程（内置示例内容），用于「载入示例旅程」与空库兜底。 */
  function defaultTrip() { return normalizeTrip(defaultData()); }

  /** 规范化整个旅程库：保证 trips 非空、activeTripId 一定指向存在的旅程。 */
  function normalizeLibrary(obj) {
    var lib = { version: 2, activeTripId: '', trips: [] };
    if (obj && Array.isArray(obj.trips)) {
      lib.trips = obj.trips.map(normalizeTrip);
      lib.activeTripId = obj.activeTripId || '';
    }
    if (!lib.trips.length) {
      var t = createEmptyTrip('我的旅程');
      lib.trips = [t];
      lib.activeTripId = t.id;
    }
    var ok = false;
    for (var i = 0; i < lib.trips.length; i++) {
      if (lib.trips[i].id === lib.activeTripId) { ok = true; break; }
    }
    if (!ok) lib.activeTripId = lib.trips[0].id;
    return preserveUnknown(obj, lib);
  }

  /** 按 id 查找旅程（ES5 风格，返回对象引用本身）。 */
  function findTrip(lib, id) {
    lib = lib || state.library;
    if (!lib) return null;
    for (var i = 0; i < lib.trips.length; i++) {
      if (lib.trips[i].id === id) return lib.trips[i];
    }
    return null;
  }

  /** 当前旅程对象的引用（findTrip 失败时兜底第一段）。 */
  function activeTripRef(lib) {
    lib = lib || state.library;
    if (!lib) return null;
    return findTrip(lib, lib.activeTripId) || lib.trips[0];
  }

  /** v1 单行程对象 → v2 旅程库（保留其 id 之外的内容，包成单旅程）。 */
  function migrateV1toV2(tripObj) {
    var t = normalizeTrip(tripObj);
    return { version: 2, activeTripId: t.id, trips: [t] };
  }

  // ===========================================================================
  // 持久化
  // ===========================================================================

  function save() {
    var json;
    try {
      json = JSON.stringify(state.library);
    } catch (e) {
      if (!storageWarned) {
        storageWarned = true;
        showToast('数据序列化失败，本次修改未保存。请立即用「导出全部旅程」备份。', 'error');
      }
      return;
    }
    try {
      // 安全备份：本次会话首次写盘前，把上一份 v2 原文留底，便于「恢复上次备份」
      if (!backupTaken) {
        backupTaken = true;
        var prev = window.localStorage.getItem(STORAGE_KEY_V2);
        if (prev && prev !== json) window.localStorage.setItem(BACKUP_KEY, prev);
      }
    } catch (e) { /* 备份失败不影响正常保存 */ }
    try {
      // 新键 v2：整个旅程库；旧键 v1 与备份键都只增不删、永不清理
      window.localStorage.setItem(STORAGE_KEY_V2, json);
    } catch (e) {
      // file:// 下个别浏览器会禁用 localStorage：必须给用户看得见的提示，绝不静默失败
      if (!storageWarned) {
        storageWarned = true;
        showToast('无法写入本机存储（浏览器可能禁用了本地存储）。本次修改只在当前页面生效，'
          + '刷新后会丢失，请及时用「导出 JSON」备份。', 'error');
      }
    }
  }

  /**
   * 载入：优先 v2；无 v2 时用 v1 做**一次性、幂等**迁移；两者皆无 → **空白旅程**。
   *
   * 两条铁律（版本更新绝不丢数据）：
   *  1) **绝不自动灌入示例数据**：全新地址（新 origin）首次打开只建一个空旅程；
   *     示例内容只能由用户点「载入示例数据」显式添加，且是新增、不影响已有旅程。
   *  2) **解析失败绝不覆盖原数据**：v2 存在但读不出来时，先把原文原样存进 BACKUP_KEY，
   *     再以空旅程在内存中启动；原文保留在本机，用户可导出留底。
   * 无论哪条路径，v1 键与备份键都**绝不删除**。
   */
  function load() {
    var raw2 = null;
    try { raw2 = window.localStorage.getItem(STORAGE_KEY_V2); } catch (e) { raw2 = null; }

    if (raw2) {
      var lib = null;
      try { lib = normalizeLibrary(JSON.parse(raw2)); } catch (e) { lib = null; }
      if (lib) {
        state.library = lib;
      } else {
        // 读不出来 → 备份原文 + 内存空库启动，绝不把原数据覆盖掉
        try { window.localStorage.setItem(BACKUP_KEY, raw2); } catch (e2) { /* ignore */ }
        state.library = normalizeLibrary({ version: 2, activeTripId: '', trips: [] });
        state.loadBroken = true;
      }
      state.data = activeTripRef(state.library);
      return;
    }

    // 无 v2：尝试一次性迁移 v1（迁移成功后写 v2，v1 保留不动）
    var raw1 = null;
    try { raw1 = window.localStorage.getItem(STORAGE_KEY_V1); } catch (e) { raw1 = null; }
    if (raw1) {
      var trip = null;
      try { trip = normalizeData(JSON.parse(raw1)); } catch (e) { trip = null; }
      if (trip) {
        state.library = migrateV1toV2(trip);
        state.data = activeTripRef(state.library);
        save();
        return;
      }
      // v1 存在但读不出来：同样只备份、不覆盖
      try { window.localStorage.setItem(BACKUP_KEY, raw1); } catch (e3) { /* ignore */ }
      state.loadBroken = true;
    }

    // 全新用户（本机无任何历史数据）：建**空白旅程**，绝不灌示例数据
    state.library = normalizeLibrary({ version: 2, activeTripId: '', trips: [] });
    state.data = activeTripRef(state.library);
    save();
  }

  /** 备份键里是否有内容（供「恢复上次备份」按钮做可用性判断）。 */
  function hasBackup() {
    try { return !!window.localStorage.getItem(BACKUP_KEY); } catch (e) { return false; }
  }

  /**
   * 恢复上次备份：把数据回滚到「本次打开页面时」的状态。
   * 典型用途：误删旅程/费用后一键回退。属破坏性操作，必须页内二次确认。
   */
  function restoreBackup() {
    var raw = null;
    try { raw = window.localStorage.getItem(BACKUP_KEY); } catch (e) { raw = null; }
    if (!raw) { showToast('没有可恢复的备份（备份会在你首次修改数据时自动生成）。', 'error'); return; }
    var lib = null;
    try { lib = normalizeLibrary(JSON.parse(raw)); } catch (e) { lib = null; }
    if (!lib) {
      showToast('备份内容已损坏，无法自动恢复。建议先用「导出全部旅程」把原始数据留底。', 'error');
      return;
    }
    confirmDialog({
      title: '恢复上次备份',
      message: '将把数据回滚到本次打开页面时的状态，之后未备份的改动会被覆盖。确定继续吗？',
      confirmText: '恢复',
      cancelText: '取消',
      danger: true
    }, function (ok) {
      if (!ok) return;
      state.library = lib;
      state.data = activeTripRef(state.library);
      save();
      renderAll();
      showToast('已恢复上次备份。', 'success');
    });
  }

  /** 判断某旅程是否「逐字段等同于」内置示例（用于清理早期版本自动灌入的示例数据）。 */
  function isBuiltinSampleTrip(t) {
    if (!t || t.tripName !== '2026 日本亲子游') return false;
    var fams = (t.families || []).map(function (f) { return f.name; });
    var sampleFams = ['张家', '李家', '王家'];
    if (fams.length !== sampleFams.length) return false;
    for (var i = 0; i < sampleFams.length; i++) {
      if (fams[i] !== sampleFams[i]) return false;
    }
    return (t.members || []).length === 8 && (t.expenses || []).length === 7;
  }

  /**
   * 一次性清理：删除早期版本「首次打开自动灌入」的示例旅程。
   * 触发条件极严——**整个库只有 1 个旅程**、且它逐字段等于内置示例。
   * 用户一旦改过名/增删过内容/多建了旅程，就不再匹配，绝不误删真实数据。
   * 清理前的旧状态会由 save() 自动留进备份键，可「恢复上次备份」找回。
   */
  function purgeAutoSeededSample() {
    var lib = state.library;
    if (!lib || lib.trips.length !== 1) return false;
    if (!isBuiltinSampleTrip(lib.trips[0])) return false;
    var fresh = createEmptyTrip('我的旅程');
    lib.trips = [fresh];
    lib.activeTripId = fresh.id;
    state.data = fresh;
    save();
    return true;
  }

  // ===========================================================================
  // 渲染：顶栏 / 标签
  // ===========================================================================

  function renderHeader() {
    // #header-trip-name 现在是静态小标签「当前旅程」（见 index.html），不再写旅程名
    var sel = $('trip-switcher');
    if (sel) {
      clearNode(sel);
      state.library.trips.forEach(function (t) {
        var o = el('option');
        o.value = t.id;
        o.textContent = t.tripName || '未命名旅程';
        sel.appendChild(o);
      });
      sel.value = state.library.activeTripId;
    }
  }

  function initTabs() {
    var btns = document.querySelectorAll('.tab-btn');
    Array.prototype.forEach.call(btns, function (btn) {
      btn.addEventListener('click', function () {
        var tab = btn.getAttribute('data-tab');
        Array.prototype.forEach.call(btns, function (b) {
          b.classList.toggle('active', b === btn);
        });
        ['expenses', 'summary', 'families', 'family-detail', 'data', 'trips'].forEach(function (t) {
          var panel = $('tab-' + t);
          if (panel) panel.classList.toggle('active', t === tab);
        });
      });
    });
  }

  // ===========================================================================
  // 渲染：我的旅程（旅程列表）
  // ===========================================================================

  /** 渲染「我的旅程」页签：每段旅程一张卡片，支持切换 / 内联重命名 / 删除。 */
  function renderTrips() {
    var box = $('trips-container');
    if (!box) return;
    clearNode(box);

    state.library.trips.forEach(function (t) {
      var isActive = t.id === state.library.activeTripId;
      var card = el('div', 'card trip-card' + (isActive ? ' trip-card-active' : ''));
      card.setAttribute('data-trip-id', t.id);

      var head = el('div', 'trip-card-head');
      var titleNode = el('span', 'trip-title', t.tripName || '未命名旅程');
      head.appendChild(titleNode);
      var memberCount = (t.members || []).length;
      head.appendChild(el('span', 'trip-meta',
        (t.families || []).length + ' 户 · ' + memberCount + ' 人 · ' + (t.expenses || []).length + ' 笔费用'));
      if (isActive) head.appendChild(el('span', 'trip-badge-active', '当前'));
      card.appendChild(head);

      var actions = el('div', 'trip-actions');
      if (!isActive) {
        var sw = el('button', 'btn small primary', '切换');
        sw.type = 'button';
        sw.addEventListener('click', function () { switchTrip(t.id); });
        actions.appendChild(sw);
      }
      var rn = el('button', 'btn small', '重命名');
      rn.type = 'button';
      rn.addEventListener('click', function () { startRenameTrip(head, t); });
      actions.appendChild(rn);
      var del = el('button', 'btn small danger', '删除');
      del.type = 'button';
      del.addEventListener('click', function () { deleteTrip(t.id); });
      actions.appendChild(del);
      card.appendChild(actions);

      box.appendChild(card);
    });
  }

  /**
   * 旅程重命名：内联编辑（与家庭重命名同范式，**严禁原生 prompt**）。
   * Enter = 保存，Esc = 取消，失焦不自动提交。
   */
  function startRenameTrip(head, trip) {
    if (!head || !trip) return;
    if (head.querySelector('.trip-rename')) return; // 已在编辑中
    var titleNode = head.querySelector('.trip-title');
    if (!titleNode) return;

    var box = el('span', 'trip-rename');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'trip-rename-input';
    input.value = trip.tripName || '';
    input.setAttribute('aria-label', '旅程名称');

    var saveBtn = el('button', 'btn small primary', '保存');
    saveBtn.type = 'button';
    var cancelBtn = el('button', 'btn small', '取消');
    cancelBtn.type = 'button';

    var settled = false;
    function commit() {
      if (settled) return;
      var v = input.value.trim();
      if (!v) {
        showToast('旅程名称不能为空', 'error');
        try { input.focus(); } catch (e) { /* 忽略 */ }
        return;
      }
      settled = true;
      renameTrip(trip.id, v);
    }
    function cancel() {
      if (settled) return;
      settled = true;
      renderTrips();
    }

    saveBtn.addEventListener('click', commit);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.keyCode === 13) { ev.preventDefault(); commit(); return; }
      if (ev.key === 'Escape' || ev.key === 'Esc' || ev.keyCode === 27) { ev.preventDefault(); cancel(); }
    });

    box.appendChild(input);
    box.appendChild(saveBtn);
    box.appendChild(cancelBtn);
    head.replaceChild(box, titleNode);
    try { input.focus(); input.select(); } catch (e) { /* 忽略不支持的环境 */ }
  }

  // ===========================================================================
  // 渲染：Tab 1 家庭与成员
  // ===========================================================================

  function renderFamilies() {
    var box = $('families-container');
    clearNode(box);
    var fams = state.data.families;

    if (fams.length === 0) {
      var empty = el('div', 'card hint', '还没有家庭，请先在上方「新增家庭」。');
      box.appendChild(empty);
    }

    fams.forEach(function (fam) {
      var card = el('div', 'card family-card');
      var head = el('div', 'fam-head');
      head.appendChild(el('span', 'fam-title', fam.name));
      var mems = state.data.members.filter(function (m) { return m.familyId === fam.id; });
      head.appendChild(el('span', 'fam-count', '（' + mems.length + ' 人）'));

      var actions = el('span', 'fam-actions');
      var rename = el('button', 'btn small', '重命名');
      rename.type = 'button';
      rename.addEventListener('click', function () { startRenameFamily(head, fam); });
      var del = el('button', 'btn small danger', '删除家庭');
      del.type = 'button';
      del.addEventListener('click', function () {
        // 重新数一遍，避免使用渲染时快照导致的误判
        var current = state.data.members.filter(function (m) { return m.familyId === fam.id; });
        if (current.length > 0) {
          showToast('该家庭下还有 ' + current.length + ' 名成员，请先删除或转移成员后再删除家庭。', 'error');
          return;
        }
        confirmDialog({
          title: '删除家庭',
          message: '确定删除家庭「' + fam.name + '」吗？',
          confirmText: '删除',
          cancelText: '取消',
          danger: true
        }, function (ok) {
          if (!ok) return;
          state.data.families = state.data.families.filter(function (f) { return f.id !== fam.id; });
          touchTrip();
          save();
          renderAll();
        });
      });
      actions.appendChild(rename);
      actions.appendChild(del);
      head.appendChild(actions);
      card.appendChild(head);

      var list = el('div', 'member-list');
      if (mems.length === 0) list.appendChild(el('div', 'hint', '暂无成员'));
      mems.forEach(function (m) { list.appendChild(buildMemberRow(m)); });
      card.appendChild(list);
      box.appendChild(card);
    });
  }

  /**
   * 家庭重命名：把卡片标题就地换成输入框（替代浏览器原生 prompt）。
   * Enter = 保存，Esc = 取消；**失焦不自动提交**，避免误改。
   * 名称为空或纯空格时不保存，用提示条告知用户。
   *
   * @param {HTMLElement} head 家庭卡片的 .fam-head 容器
   * @param {Object} fam 对应的家庭数据对象（原地修改其 name）
   */
  function startRenameFamily(head, fam) {
    if (!head || !fam) return;
    if (head.querySelector('.fam-rename')) return; // 已在编辑中，忽略重复点击
    var titleNode = head.querySelector('.fam-title');
    if (!titleNode) return;

    var box = el('span', 'fam-rename');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'fam-rename-input';
    input.value = fam.name;
    input.setAttribute('aria-label', '家庭名称');

    var saveBtn = el('button', 'btn small primary', '保存');
    saveBtn.type = 'button';
    var cancelBtn = el('button', 'btn small', '取消');
    cancelBtn.type = 'button';

    var settled = false;
    function commit() {
      if (settled) return;
      var v = input.value.trim();
      if (!v) {
        showToast('家庭名称不能为空', 'error');
        try { input.focus(); } catch (e) { /* 忽略 */ }
        return;
      }
      settled = true;
      if (v !== fam.name) {
        fam.name = v;
        touchTrip();
        save();
        renderAll(); // 结算汇总、家庭明细、费用表等处户名同步刷新
      } else {
        renderFamilies();
      }
    }
    function cancel() {
      if (settled) return;
      settled = true;
      renderFamilies();
    }

    saveBtn.addEventListener('click', commit);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.keyCode === 13) { ev.preventDefault(); commit(); return; }
      if (ev.key === 'Escape' || ev.key === 'Esc' || ev.keyCode === 27) { ev.preventDefault(); cancel(); }
    });
    // 失焦不自动提交：用户随时可以回来点「保存」或「取消」

    box.appendChild(input);
    box.appendChild(saveBtn);
    box.appendChild(cancelBtn);
    head.replaceChild(box, titleNode);
    try { input.focus(); input.select(); } catch (e) { /* 忽略不支持的环境 */ }
  }

  function buildMemberRow(m) {
    var row = el('div', 'member-row');
    row.appendChild(el('span', 'member-name', m.name));
    row.appendChild(el('span', 'member-type', typeLabel(m.type)));
    var acts = el('span', 'member-actions');

    var edit = el('button', 'btn small', '编辑');
    edit.addEventListener('click', function () { startEditMember(row, m); });
    acts.appendChild(edit);

    var del = el('button', 'btn small danger', '删除');
    del.type = 'button';
    del.addEventListener('click', function () {
      confirmDialog({
        title: '删除成员',
        message: '确定删除成员「' + m.name + '」吗？相关费用的参与记录也会一并移除。',
        confirmText: '删除',
        cancelText: '取消',
        danger: true
      }, function (ok) {
        if (!ok) return;
        state.data.members = state.data.members.filter(function (x) { return x.id !== m.id; });
        state.data.expenses.forEach(function (ex) {
          ex.participants = (ex.participants || []).filter(function (x) { return x !== m.id; });
          if (ex.customAmounts) delete ex.customAmounts[m.id];
          (ex.rooms || []).forEach(function (r) {
            r.occupants = (r.occupants || []).filter(function (x) { return x !== m.id; });
          });
          if (ex.payerMemberId === m.id) ex.payerMemberId = '';
        });
        touchTrip();
        save();
        renderAll();
      });
    });
    acts.appendChild(del);
    row.appendChild(acts);
    return row;
  }

  function startEditMember(row, m) {
    clearNode(row);

    var nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = m.name;

    var famSelect = document.createElement('select');
    state.data.families.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.name;
      famSelect.appendChild(o);
    });
    famSelect.value = m.familyId;

    var typeSelect = document.createElement('select');
    [['adult', '成人'], ['elder', '老人'], ['child', '小孩']].forEach(function (t) {
      var o = document.createElement('option');
      o.value = t[0];
      o.textContent = t[1];
      typeSelect.appendChild(o);
    });
    typeSelect.value = m.type;

    var saveBtn = el('button', 'btn small primary', '保存');
    saveBtn.addEventListener('click', function () {
      var nm = nameInput.value.trim();
      if (!nm) { showToast('姓名不能为空', 'error'); return; }
      m.name = nm;
      m.familyId = famSelect.value;
      m.type = typeSelect.value;
      touchTrip();
      save();
      renderAll();
    });

    var cancelBtn = el('button', 'btn small', '取消');
    cancelBtn.addEventListener('click', function () { renderFamilies(); });

    row.appendChild(nameInput);
    row.appendChild(famSelect);
    row.appendChild(typeSelect);
    row.appendChild(saveBtn);
    row.appendChild(cancelBtn);
  }

  function renderNewMemberFamilySelect() {
    var sel = $('new-member-family');
    clearNode(sel);
    state.data.families.forEach(function (f) {
      var o = document.createElement('option');
      o.value = f.id;
      o.textContent = f.name;
      sel.appendChild(o);
    });
  }

  // ===========================================================================
  // 渲染：Tab 2 费用列表
  // ===========================================================================

  function renderExpenseList() {
    var tbody = $('expense-list');
    clearNode(tbody);

    var list = state.data.expenses.slice().sort(function (a, b) {
      if ((a.date || '') === (b.date || '')) {
        return (a.title || '').localeCompare(b.title || '');
      }
      return (a.date || '') < (b.date || '') ? -1 : 1;
    });

    if (list.length === 0) {
      var tr0 = document.createElement('tr');
      var td0 = document.createElement('td');
      td0.colSpan = 9;
      td0.className = 'hint';
      td0.textContent = '还没有费用记录，点击右上角「+ 新增费用」开始记账。';
      tr0.appendChild(td0);
      tbody.appendChild(tr0);
      return;
    }

    list.forEach(function (ex) {
      var base = C.convertToBase(Number(ex.amount) || 0, Number(ex.rate) || 0);
      var tr = document.createElement('tr');
      tr.appendChild(td(ex.date || ''));
      tr.appendChild(td(ex.title || ''));
      tr.appendChild(td(ex.category || ''));
      tr.appendChild(td(num2(ex.amount) + ' ' + (ex.currency || '')));
      tr.appendChild(td(money(base, '¥')));
      tr.appendChild(td(payerName(ex.payerMemberId)));
      tr.appendChild(td((ex.participants || []).length + ' 人'));
      tr.appendChild(td(modeLabel(ex.splitMode)));

      var actTd = document.createElement('td');
      var edit = el('button', 'btn small', '编辑');
      edit.addEventListener('click', function () { openExpenseModal(ex.id); });
      actTd.appendChild(edit);
      var del = el('button', 'btn small danger', '删除');
      del.type = 'button';
      del.addEventListener('click', function () {
        confirmDialog({
          title: '删除费用',
          message: '确定删除费用「' + (ex.title || '') + '」吗？',
          confirmText: '删除',
          cancelText: '取消',
          danger: true
        }, function (ok) {
          if (!ok) return;
          state.data.expenses = state.data.expenses.filter(function (x) { return x.id !== ex.id; });
          touchTrip();
          save();
          renderAll();
        });
      });
      actTd.appendChild(del);
      tr.appendChild(actTd);

      tbody.appendChild(tr);
    });
  }

  // ===========================================================================
  // 渲染：Tab 3 结算汇总
  // ===========================================================================

  function statCard(label, value) {
    var card = el('div', 'stat-card');
    card.appendChild(el('div', 'label', label));
    card.appendChild(el('div', 'value', value));
    return card;
  }

  function frItem(k, v, cls) {
    var item = el('div', 'fr-item');
    item.appendChild(el('div', 'k', k));
    item.appendChild(el('div', 'v' + (cls ? ' ' + cls : ''), v));
    return item;
  }

  function renderSummary() {
    var res = C.computeResult(state.data);

    // ---- 提示信息 ----
    var msgBox = $('summary-messages');
    clearNode(msgBox);
    var errList = res.errors || [];
    var warnList = res.warnings || [];
    if (errList.length === 0 && warnList.length === 0) {
      msgBox.appendChild(el('div', 'hint', '数据校验通过，未发现问题。'));
    }
    errList.forEach(function (t) { msgBox.appendChild(el('div', 'msg error', t)); });
    warnList.forEach(function (t) { msgBox.appendChild(el('div', 'msg warn', t)); });

    // ---- 顶部大数字 ----
    var cards = $('summary-cards');
    clearNode(cards);
    var familyCount = Object.keys(res.perFamily).length;
    var memberCount = state.data.members.length;
    var perCapita = memberCount ? res.grandTotalBase / memberCount : 0;
    cards.appendChild(statCard('总花费（' + res.baseCurrency + '）', money(res.grandTotalBase, '¥')));
    cards.appendChild(statCard('参与户数', familyCount + ' 户'));
    cards.appendChild(statCard('总人数', memberCount + ' 人'));
    cards.appendChild(statCard('人均', money(perCapita, '¥')));

    // ---- 各家庭结算卡 ----
    var fc = $('family-cards');
    clearNode(fc);
    var famIds = Object.keys(res.perFamily);
    if (famIds.length === 0) fc.appendChild(el('div', 'hint', '暂无家庭数据。'));
    famIds.forEach(function (fid) {
      var f = res.perFamily[fid];
      var card = el('div', 'family-result');
      card.appendChild(el('div', 'fr-name', f.name));

      // ---- 「条目明细」入口：卡片内容第一行、紧接户名之后、金额网格之前，默认收起 ----
      var built = buildFamilyEntries(res, fid);
      var isOpen = !!familyEntriesExpanded[fid];
      var toggle = el('div', 'fr-entries-toggle' + (isOpen ? ' open' : ''));
      toggle.setAttribute('role', 'button');
      toggle.setAttribute('tabindex', '0');
      toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      toggle.appendChild(el('span', 'fr-entries-label', '条目明细（共 ' + built.entries.length + ' 笔）'));
      var arrow = el('span', 'fr-entries-arrow', isOpen ? '▴' : '▾');
      toggle.appendChild(arrow);

      var entriesBox = el('div', 'fr-entries');
      if (built.entries.length === 0) {
        entriesBox.appendChild(el('div', 'hint', '该户目前没有任何费用条目。'));
      } else {
        entriesBox.appendChild(buildEntriesTable(built, true));
      }
      if (!isOpen) entriesBox.hidden = true;

      function toggleEntries() {
        var nowOpen = !familyEntriesExpanded[fid];
        familyEntriesExpanded[fid] = nowOpen;
        entriesBox.hidden = !nowOpen;
        toggle.classList.toggle('open', nowOpen);
        toggle.setAttribute('aria-expanded', nowOpen ? 'true' : 'false');
        arrow.textContent = nowOpen ? '▴' : '▾';
      }
      toggle.addEventListener('click', toggleEntries);
      toggle.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ' || ev.keyCode === 13 || ev.keyCode === 32) {
          ev.preventDefault();
          toggleEntries();
        }
      });

      card.appendChild(toggle);
      card.appendChild(entriesBox);

      var grid = el('div', 'fr-grid');
      grid.appendChild(frItem('应分摊', money(f.share, '¥'), ''));
      grid.appendChild(frItem('已垫付', money(f.paid, '¥'), ''));
      var netText, netCls;
      if (f.net > 0.005) { netText = '应收 ' + money(f.net, '¥'); netCls = 'net-receive'; }
      else if (f.net < -0.005) { netText = '应付 ' + money(-f.net, '¥'); netCls = 'net-pay'; }
      else { netText = '已平账'; netCls = 'net-zero'; }
      grid.appendChild(frItem('净额', netText, netCls));
      card.appendChild(grid);

      var details = el('div', 'fr-members');
      (f.members || []).forEach(function (mid) {
        var pm = res.perMember[mid];
        if (!pm) return;
        var line = el('div', 'fr-member-line');
        line.appendChild(el('span', 'fml-name', pm.name));
        line.appendChild(el('span', null,
          '分摊 ' + money(pm.share, '¥') + ' ／ 垫付 ' + money(pm.paid, '¥') +
          ' ／ 净 ' + money(pm.net, '¥')));
        details.appendChild(line);
      });
      card.appendChild(details);
      fc.appendChild(card);
    });

    // ---- 转账方案 ----
    var tc = $('transfers-container');
    clearNode(tc);
    if (res.transfers.length === 0) {
      tc.appendChild(el('p', 'hint', '无需转账，各家庭已平账。'));
    } else {
      var tbl = document.createElement('table');
      tbl.className = 'data-table';
      var thead = document.createElement('thead');
      var htr = document.createElement('tr');
      ['付款方', '', '收款方', '金额(¥)'].forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        htr.appendChild(th);
      });
      thead.appendChild(htr);
      tbl.appendChild(thead);
      var tbody = document.createElement('tbody');
      res.transfers.forEach(function (t) {
        var tr = document.createElement('tr');
        tr.appendChild(td(t.fromName));
        tr.appendChild(td('→'));
        tr.appendChild(td(t.toName));
        tr.appendChild(td(money(t.amount, '¥')));
        tbody.appendChild(tr);
      });
      tbl.appendChild(tbody);
      tc.appendChild(tbl);
      tc.appendChild(el('p', 'hint',
        '读法：左侧「付款方」把对应金额转给「收款方」，全部转完后各家正好清账。'));
    }

    // ---- 成员明细 ----
    var mt = $('member-table');
    clearNode(mt);
    state.data.members.forEach(function (m) {
      var pm = res.perMember[m.id];
      if (!pm) return;
      var tr = document.createElement('tr');
      tr.appendChild(td(pm.name));
      tr.appendChild(td(familyName(pm.familyId)));
      tr.appendChild(td(money(pm.share, '¥')));
      tr.appendChild(td(money(pm.paid, '¥')));
      var netTd = td(money(pm.net, '¥'));
      if (pm.net > 0.005) netTd.style.color = '#dc2626';
      else if (pm.net < -0.005) netTd.style.color = '#16a34a';
      tr.appendChild(netTd);
      mt.appendChild(tr);
    });
    if (state.data.members.length === 0) {
      var trE = document.createElement('tr');
      var tdE = document.createElement('td');
      tdE.colSpan = 5;
      tdE.className = 'hint';
      tdE.textContent = '暂无成员数据。';
      trE.appendChild(tdE);
      mt.appendChild(trE);
    }

    // ---- 按币种汇总 ----
    var ct = $('currency-table');
    clearNode(ct);
    var codes = Object.keys(res.byCurrency);
    if (codes.length === 0) {
      var trC = document.createElement('tr');
      var tdC = document.createElement('td');
      tdC.colSpan = 3;
      tdC.className = 'hint';
      tdC.textContent = '暂无费用数据。';
      trC.appendChild(tdC);
      ct.appendChild(trC);
    }
    codes.forEach(function (code) {
      var info = res.byCurrency[code];
      var tr = document.createElement('tr');
      tr.appendChild(td(code + ' ' + currencyName(code)));
      tr.appendChild(td(num2(info.paid)));
      tr.appendChild(td(money(info.baseEquivalent, '¥')));
      ct.appendChild(tr);
    });

    // ---- 按类别汇总 ----
    var cat = $('category-table');
    clearNode(cat);
    var catKeys = Object.keys(res.byCategory).sort();
    if (catKeys.length === 0) {
      var trK = document.createElement('tr');
      var tdK = document.createElement('td');
      tdK.colSpan = 3;
      tdK.className = 'hint';
      tdK.textContent = '暂无费用数据。';
      trK.appendChild(tdK);
      cat.appendChild(trK);
    }
    catKeys.forEach(function (k) {
      var info = res.byCategory[k];
      var tr = document.createElement('tr');
      tr.appendChild(td(k));
      tr.appendChild(td(info.count + ' 笔'));
      tr.appendChild(td(money(info.base, '¥')));
      cat.appendChild(tr);
    });

    // ---- 每笔费用分摊明细（可折叠） ----
    var pec = $('per-expense-container');
    clearNode(pec);
    if (state.data.expenses.length === 0) {
      pec.appendChild(el('p', 'hint', '暂无费用数据。'));
    }
    state.data.expenses.forEach(function (ex, idx) {
      var detail = res.perExpense[ex.id] || res.perExpense[String(idx)];
      var det = document.createElement('details');
      det.className = 'exp-detail';
      var sum = document.createElement('summary');
      var total = detail ? detail.total : C.convertToBase(Number(ex.amount) || 0, Number(ex.rate) || 0);
      sum.textContent = (ex.date || '') + ' ' + (ex.title || '') +
        '（' + (ex.category || '') + '）合计 ' + money(total, '¥');
      det.appendChild(sum);

      var body = el('div', 'detail-body');
      body.appendChild(el('div', 'detail-line',
        '付款人：' + payerName(ex.payerMemberId) + '　原币金额：' +
        num2(ex.amount) + ' ' + (ex.currency || '')));
      var alloc = (detail && detail.alloc) ? detail.alloc : {};
      var ids = Object.keys(alloc);
      if (ids.length === 0) {
        body.appendChild(el('div', 'detail-line', '（无有效分摊）'));
      }
      ids.forEach(function (mid) {
        var m = memberById(mid);
        var line = el('div', 'detail-line');
        line.appendChild(el('span', null, (m ? m.name : mid) + '（' + familyName(m ? m.familyId : '') + '）'));
        line.appendChild(el('span', null, money(alloc[mid], '¥')));
        body.appendChild(line);
      });
      (detail && detail.warnings ? detail.warnings : []).forEach(function (w) {
        body.appendChild(el('div', 'msg warn', w));
      });
      det.appendChild(body);
      pec.appendChild(det);
    });

    // ---- 汇率 / 舍入说明 ----
    var note = $('round-note');
    clearNode(note);
    note.appendChild(el('div', null, '【汇率说明】所有费用按各自汇率折算成基准货币（' +
      res.baseCurrency + '）后参与分摊。汇率可在「数据管理」中维护。'));
    note.appendChild(el('div', null, '【四舍五入说明】分摊结果精确到「分」（0.01 元），' +
      '每笔费用的各成员分摊额之和与项目总额完全相等；转账方案按分为单位配对，可完全平账。'));
  }

  // ===========================================================================
  // 渲染：Tab 3.5 家庭明细（独立页签）与「条目明细」聚合
  // ===========================================================================

  /**
   * 计算某一户（familyId）在各笔费用中的条目明细。
   *
   * 口径（严格）：一笔费用对该户算作一条，当且仅当
   *   「该户有成员分摊额 > 0」 或 「该笔付款人属于该户」。
   *   两者都不满足的费用不列。
   *
   * 数据来源：C.computeResult() 已算好的 res.perExpense[eid].alloc（成员id -> 基准币金额）
   * 与 res.perExpense[eid].total；把同一户成员相加即得该户在该笔的分摊额。不改 calc.js。
   *
   * @return {{entries:Array, shareCents:number, paidCents:number}} 金额以整数「分」返回
   */
  function buildFamilyEntries(res, fid) {
    var famMembers = (res.perFamily[fid] && res.perFamily[fid].members) || [];
    var memberSet = {};
    famMembers.forEach(function (mid) { memberSet[mid] = true; });

    // 排序口径与「费用记录」列表一致：先按日期、再按项目名
    var expenses = state.data.expenses.slice().sort(function (a, b) {
      if ((a.date || '') === (b.date || '')) return (a.title || '').localeCompare(b.title || '');
      return (a.date || '') < (b.date || '') ? -1 : 1;
    });

    var entries = [];
    var shareTotalCents = 0;
    var paidTotalCents = 0;

    expenses.forEach(function (ex) {
      var origIdx = state.data.expenses.indexOf(ex);
      var detail = res.perExpense[ex.id] || res.perExpense[String(origIdx)];
      var total = detail ? detail.total
        : C.convertToBase(Number(ex.amount) || 0, Number(ex.rate) || 0);
      var totalCents = Math.round(total * 100);
      var alloc = (detail && detail.alloc) ? detail.alloc : {};

      // 本户分摊 = 该户成员在本笔 alloc 之和（整数分）
      var shareCents = 0;
      for (var mid in alloc) {
        if (!alloc.hasOwnProperty(mid)) continue;
        if (memberSet[mid]) shareCents += Math.round(alloc[mid] * 100);
      }

      // 付款人是否属于本户 → 决定「本笔本户垫付」
      var payer = ex.payerMemberId ? memberById(ex.payerMemberId) : null;
      var payerFamilyKey = payer ? (payer.familyId || '__orphan__') : null;
      var paidCents = (payerFamilyKey !== null && payerFamilyKey === fid) ? totalCents : 0;

      // 口径：两者都为 0 的费用不列
      if (shareCents === 0 && paidCents === 0) return;

      entries.push({
        date: ex.date || '',
        title: ex.title || '',
        category: ex.category || '',
        total: total,
        totalCents: totalCents,
        share: shareCents / 100,
        shareCents: shareCents,
        paid: paidCents / 100,
        paidCents: paidCents,
        payerLabel: payer
          ? (payer.name + '（' + familyName(payer.familyId) + '）')
          : '（未指定）'
      });
      shareTotalCents += shareCents;
      paidTotalCents += paidCents;
    });

    return { entries: entries, shareCents: shareTotalCents, paidCents: paidTotalCents };
  }

  /**
   * 构建「条目明细」表格（卡片内展开区与独立页签共用）。
   * compact=true：用于卡片内，不套滚动容器，宽度自适应，便于打印；
   * compact=false：用于独立页签，沿用 .table-wrap 滚动容器。
   */
  function buildEntriesTable(built, compact) {
    var wrap = compact ? el('div', 'entries-compact') : el('div', 'table-wrap');
    var table = document.createElement('table');
    // 两处共用同一语义类 entries-table（便于样式/测试统一识别）；
    // 版式差异由外层容器决定：compact → .entries-compact（不滚动、紧凑），
    // 独立页签 → .table-wrap（超宽时横向滚动，沿用 .data-table 默认字号/内边距）。
    table.className = 'data-table entries-table';

    var thead = document.createElement('thead');
    var htr = document.createElement('tr');
    ['日期', '项目', '类别', '本笔总额(¥)', '本户分摊(¥)', '本户占比', '付款人', '本笔本户垫付(¥)']
      .forEach(function (h) {
        var th = document.createElement('th');
        th.textContent = h;
        htr.appendChild(th);
      });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    built.entries.forEach(function (e) {
      var ratioText = e.totalCents > 0
        ? (Math.round(e.shareCents / e.totalCents * 1000) / 10) + '%'
        : '—';
      var tr = document.createElement('tr');
      tr.appendChild(td(e.date));
      tr.appendChild(td(e.title));
      tr.appendChild(td(e.category));
      tr.appendChild(td(money(e.total, '¥')));
      tr.appendChild(td(money(e.share, '¥')));
      tr.appendChild(td(ratioText));
      tr.appendChild(td(e.payerLabel));
      tr.appendChild(td(money(e.paid, '¥')));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    // 合计行：本户分摊合计 / 本户垫付合计
    var tfoot = document.createElement('tfoot');
    var ftr = document.createElement('tr');
    ftr.className = 'entries-total-row';
    var cLabel = document.createElement('td');
    cLabel.colSpan = 4;
    cLabel.textContent = '合计';
    ftr.appendChild(cLabel);
    ftr.appendChild(td(money(built.shareCents / 100, '¥')));
    ftr.appendChild(td(''));
    ftr.appendChild(td(''));
    ftr.appendChild(td(money(built.paidCents / 100, '¥')));
    tfoot.appendChild(ftr);
    table.appendChild(tfoot);

    wrap.appendChild(table);
    return wrap;
  }

  /** 渲染「家庭明细」独立页签：选择器 + 小计 + 完整条目表。 */
  function renderFamilyDetail() {
    var picker = $('family-detail-picker');
    var body = $('family-detail-body');
    if (!picker || !body) return;
    clearNode(picker);
    clearNode(body);

    var res = C.computeResult(state.data);
    var famIds = Object.keys(res.perFamily);

    if (famIds.length === 0) {
      picker.appendChild(el('span', 'hint', '还没有家庭，请先到「家庭与成员」添加。'));
      body.appendChild(el('div', 'card hint', '暂无家庭数据。'));
      return;
    }
    if (famIds.indexOf(selectedDetailFamilyId) === -1) selectedDetailFamilyId = famIds[0];

    // 家庭选择器
    famIds.forEach(function (fid) {
      var b = el('button', 'btn small' + (fid === selectedDetailFamilyId ? ' primary' : ''),
        res.perFamily[fid].name);
      b.type = 'button';
      b.addEventListener('click', function () {
        selectedDetailFamilyId = fid;
        renderFamilyDetail();
      });
      picker.appendChild(b);
    });

    var f = res.perFamily[selectedDetailFamilyId];
    var built = buildFamilyEntries(res, selectedDetailFamilyId);

    // 小计卡片
    var card = el('div', 'card');
    card.appendChild(el('div', 'fr-name', f.name + ' · 结算小计'));
    var grid = el('div', 'fr-grid');
    grid.appendChild(frItem('应分摊', money(f.share, '¥'), ''));
    grid.appendChild(frItem('已垫付', money(f.paid, '¥'), ''));
    var netText, netCls;
    if (f.net > 0.005) { netText = '应收 ' + money(f.net, '¥'); netCls = 'net-receive'; }
    else if (f.net < -0.005) { netText = '应付 ' + money(-f.net, '¥'); netCls = 'net-pay'; }
    else { netText = '已平账'; netCls = 'net-zero'; }
    grid.appendChild(frItem('净额', netText, netCls));
    card.appendChild(grid);
    body.appendChild(card);

    // 完整条目清单
    var card2 = el('div', 'card');
    card2.appendChild(el('h2', null, '条目明细（共 ' + built.entries.length + ' 笔）'));
    if (built.entries.length === 0) {
      card2.appendChild(el('p', 'hint', '该户目前没有任何费用条目。'));
    } else {
      card2.appendChild(buildEntriesTable(built, false));
      card2.appendChild(el('p', 'hint',
        '合计：本户分摊 ' + money(built.shareCents / 100, '¥') +
        '　／　本户垫付 ' + money(built.paidCents / 100, '¥')));
    }
    body.appendChild(card2);
  }

  // ===========================================================================
  // 渲染：Tab 4 数据管理
  // ===========================================================================

  function renderDataTab() {
    $('trip-name-input').value = state.data.tripName || '';

    // 基准货币下拉
    var sel = $('base-currency-select');
    clearNode(sel);
    state.data.currencies.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.code;
      o.textContent = c.code + ' ' + (c.name || '');
      sel.appendChild(o);
    });
    sel.value = state.data.baseCurrency;

    // 币种表
    var body = $('currency-manage-body');
    clearNode(body);
    state.data.currencies.forEach(function (c) {
      var tr = document.createElement('tr');
      tr.appendChild(td(c.code));

      var nameTd = document.createElement('td');
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.value = c.name || '';
      nameInput.addEventListener('change', function () {
        c.name = nameInput.value;
        touchTrip();
        save();
      });
      nameTd.appendChild(nameInput);
      tr.appendChild(nameTd);

      var rateTd = document.createElement('td');
      var rateInput = document.createElement('input');
      rateInput.type = 'number';
      rateInput.step = '0.0001';
      rateInput.value = c.rate;
      rateInput.addEventListener('change', function () {
        var v = Number(rateInput.value);
        if (isFinite(v) && v > 0) {
          c.rate = v;
          touchTrip();
          save();
          renderSummary();
        } else {
          showToast('汇率必须大于 0', 'error');
          rateInput.value = c.rate;
        }
      });
      rateTd.appendChild(rateInput);
      tr.appendChild(rateTd);

      var actTd = document.createElement('td');
      var del = el('button', 'btn small danger', '删除');
      del.type = 'button';
      del.addEventListener('click', function () {
        if (c.code === state.data.baseCurrency) { showToast('基准货币不能删除', 'error'); return; }
        confirmDialog({
          title: '删除币种',
          message: '删除币种 ' + c.code + ' 吗？已有费用的汇率不会改变。',
          confirmText: '删除',
          cancelText: '取消',
          danger: true
        }, function (ok) {
          if (!ok) return;
          state.data.currencies = state.data.currencies.filter(function (x) { return x.code !== c.code; });
          touchTrip();
          save();
          renderAll();
        });
      });
      actTd.appendChild(del);
      tr.appendChild(actTd);

      body.appendChild(tr);
    });

    renderCategoryManage();
  }

  // ===========================================================================
  // 费用类别管理（类别按旅程独立保存）
  // ===========================================================================

  /** 渲染「费用类别」管理表（每行：类别名 + 内联重命名 + 删除）。 */
  function renderCategoryManage() {
    var body = $('category-manage-body');
    if (!body) return;
    clearNode(body);

    state.data.categories.forEach(function (name) {
      var tr = document.createElement('tr');

      var nameTd = document.createElement('td');
      nameTd.className = 'cat-name';
      nameTd.appendChild(el('span', 'cat-name-text', name));
      tr.appendChild(nameTd);

      var actTd = document.createElement('td');
      var rn = el('button', 'btn small', '重命名');
      rn.type = 'button';
      rn.addEventListener('click', function () { startRenameCategory(tr, name); });
      actTd.appendChild(rn);
      var del = el('button', 'btn small danger', '删除');
      del.type = 'button';
      del.addEventListener('click', function () { deleteCategory(name); });
      actTd.appendChild(del);
      tr.appendChild(actTd);

      body.appendChild(tr);
    });
  }

  /**
   * 类别重命名：行内就地编辑（照 startRenameTrip 范式，**严禁原生 prompt**）。
   * Enter = 保存，Esc = 取消，失焦不自动提交。
   */
  function startRenameCategory(tr, oldName) {
    if (!tr || tr.querySelector('.cat-rename')) return; // 已在编辑中
    var nameTd = tr.firstChild;
    var span = nameTd ? nameTd.querySelector('.cat-name-text') : null;
    if (!span) return;

    var box = el('span', 'cat-rename');
    var input = document.createElement('input');
    input.type = 'text';
    input.className = 'cat-rename-input';
    input.value = oldName;
    input.setAttribute('aria-label', '类别名称');

    var saveBtn = el('button', 'btn small primary', '保存');
    saveBtn.type = 'button';
    var cancelBtn = el('button', 'btn small', '取消');
    cancelBtn.type = 'button';

    var settled = false;
    function commit() {
      if (settled) return;
      var v = input.value.trim();
      if (!v) {
        showToast('类别名称不能为空', 'error');
        try { input.focus(); } catch (e) { /* 忽略 */ }
        return;
      }
      var dup = state.data.categories.some(function (x) { return x !== oldName && x === v; });
      if (dup) {
        showToast('类别已存在', 'error');
        try { input.focus(); } catch (e) { /* 忽略 */ }
        return;
      }
      settled = true;
      renameCategory(oldName, v);
    }
    function cancel() {
      if (settled) return;
      settled = true;
      renderCategoryManage();
    }

    saveBtn.addEventListener('click', commit);
    cancelBtn.addEventListener('click', cancel);
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' || ev.keyCode === 13) { ev.preventDefault(); commit(); return; }
      if (ev.key === 'Escape' || ev.key === 'Esc' || ev.keyCode === 27) { ev.preventDefault(); cancel(); }
    });

    box.appendChild(input);
    box.appendChild(saveBtn);
    box.appendChild(cancelBtn);
    nameTd.replaceChild(box, span);
    try { input.focus(); input.select(); } catch (e) { /* 忽略不支持的环境 */ }
  }

  /** 新增类别。 */
  function addCategory() {
    var name = ($('new-cat-name').value || '').trim();
    if (!name) { showToast('请填写类别名称', 'error'); return; }
    if (state.data.categories.indexOf(name) !== -1) { showToast('类别已存在', 'error'); return; }
    state.data.categories.push(name);
    $('new-cat-name').value = '';
    touchTrip();
    save();
    renderAll();
  }

  /** 重命名类别：级联改写已有费用的 category。 */
  function renameCategory(oldName, newName) {
    var list = state.data.categories;
    var idx = list.indexOf(oldName);
    if (idx === -1) { renderCategoryManage(); return; }
    var v = (newName || '').trim();
    if (!v) { showToast('类别名称不能为空', 'error'); return; }
    if (v !== oldName && list.indexOf(v) !== -1) { showToast('类别已存在', 'error'); return; }
    list[idx] = v;
    state.data.expenses.forEach(function (ex) {
      if (ex.category === oldName) ex.category = v;
    });
    touchTrip();
    save();
    renderAll();
  }

  /** 删除类别：不允许删到 0；确认后把在用费用改归兜底类别。 */
  function deleteCategory(name) {
    var list = state.data.categories;
    if (list.indexOf(name) === -1) return;
    var remaining = list.filter(function (x) { return x !== name; });
    if (remaining.length === 0) { showToast('至少保留一个类别', 'error'); return; }
    var fb = fallbackCategory(remaining);
    var used = state.data.expenses.filter(function (ex) { return ex.category === name; }).length;
    confirmDialog({
      title: '删除类别',
      message: '删除类别「' + name + '」吗？已有 ' + used + ' 笔费用使用该类别，将改归「' + fb + '」。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true
    }, function (ok) {
      if (!ok) return;
      state.data.expenses.forEach(function (ex) {
        if (ex.category === name) ex.category = fb;
      });
      state.data.categories = remaining;
      touchTrip();
      save();
      renderAll();
    });
  }

  // ===========================================================================
  // 费用弹窗
  // ===========================================================================

  function blankExpense() {
    var defaultPayer = state.data.members.length ? state.data.members[0].id : '';
    return {
      id: C.newId(),
      date: todayStr(),
      title: '',
      category: defaultCategory(),
      currency: state.data.baseCurrency,
      amount: '',
      rate: currencyRate(state.data.baseCurrency),
      payerMemberId: defaultPayer,
      splitMode: 'equal',
      participants: state.data.members.map(function (m) { return m.id; }),
      prices: { adult: '', elder: '', child: '' },
      rooms: [],
      customAmounts: {},
      note: ''
    };
  }

  function populateCurrencySelect(selected) {
    var sel = $('exp-currency');
    clearNode(sel);
    state.data.currencies.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.code;
      o.textContent = c.code + ' ' + (c.name || '');
      sel.appendChild(o);
    });
    sel.value = selected || state.data.baseCurrency;
  }

  function populatePayerSelect(selected) {
    var sel = $('exp-payer');
    clearNode(sel);
    state.data.families.forEach(function (fam) {
      var og = document.createElement('optgroup');
      og.label = fam.name;
      var mems = state.data.members.filter(function (m) { return m.familyId === fam.id; });
      mems.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.name + '（' + typeLabel(m.type) + '）';
        og.appendChild(o);
      });
      if (mems.length) sel.appendChild(og);
    });
    // 未能归入任何家庭的成员
    var orphan = state.data.members.filter(function (m) {
      return !state.data.families.some(function (f) { return f.id === m.familyId; });
    });
    if (orphan.length) {
      var og2 = document.createElement('optgroup');
      og2.label = '（未分组）';
      orphan.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.id;
        o.textContent = m.name;
        og2.appendChild(o);
      });
      sel.appendChild(og2);
    }
    sel.value = selected || '';
  }

  /**
   * 填充费用弹窗的「类别」下拉（选项来自当前旅程的 categories）。
   * 若传入的历史值已不在列表中，额外补一个「X（已停用）」选项并选中它 —— 绝不丢历史值。
   */
  function populateCategorySelect(selected) {
    var sel = $('exp-category');
    clearNode(sel);
    var list = state.data.categories.slice();
    var extra = null;
    if (selected && list.indexOf(selected) === -1) extra = selected; // 历史值不在列表
    list.forEach(function (name) {
      var o = document.createElement('option');
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    });
    if (extra) {
      var o2 = document.createElement('option');
      o2.value = extra;
      o2.textContent = extra + '（已停用）';
      sel.appendChild(o2);
    }
    sel.value = (selected && (list.indexOf(selected) !== -1 || extra)) ? selected : list[0];
  }

  function openExpenseModal(id) {
    var existing = null;
    if (id) {
      for (var i = 0; i < state.data.expenses.length; i++) {
        if (state.data.expenses[i].id === id) { existing = state.data.expenses[i]; break; }
      }
    }
    draft = existing ? deepCopy(normalizeExpense(existing)) : blankExpense();
    roomConfirmed = []; // 重置瞬态标记：新会话下所有房间都「未确认」

    $('expense-modal-title').textContent = existing ? '编辑费用' : '新增费用';

    // 先填静态字段
    $('exp-date').value = draft.date || todayStr();
    $('exp-title').value = draft.title || '';
    populateCategorySelect(draft.category); // 必须先建好 option 再设 value
    $('exp-note').value = draft.note || '';
    populateCurrencySelect(draft.currency);
    populatePayerSelect(draft.payerMemberId);
    $('exp-amount').value = (draft.amount === 0 || draft.amount === '' || draft.amount === undefined) ? '' : draft.amount;
    $('exp-rate').value = draft.rate || '';
    $('exp-splitmode').value = draft.splitMode || 'equal';

    renderParticipants();
    renderTicketPrices();
    renderRooms();
    renderCustomSection();
    showSplitSections();
    updatePreview();

    $('expense-modal').classList.remove('hidden');
  }

  function closeExpenseModal() {
    $('expense-modal').classList.add('hidden');
    draft = null;
    roomConfirmed = []; // 重置瞬态标记
  }

  function showSplitSections() {
    if (!draft) return;
    $('split-ticket').classList.toggle('hidden', draft.splitMode !== 'ticket');
    $('split-room').classList.toggle('hidden', draft.splitMode !== 'room');
    $('split-custom').classList.toggle('hidden', draft.splitMode !== 'custom');
  }

  function renderParticipants() {
    var box = $('participants-container');
    clearNode(box);
    if (state.data.families.length === 0 || state.data.members.length === 0) {
      box.appendChild(el('p', 'hint', '请先在「家庭与成员」中添加家庭和成员。'));
      return;
    }

    // ---- 顶部「总全选」行 ----
    var allWrap = el('label', 'pt-all');
    var allCb = document.createElement('input');
    allCb.type = 'checkbox';
    allCb.id = 'pt-select-all';
    allCb.addEventListener('change', function () {
      // 只改已存在 checkbox 的 .checked，绝不重建（防止滚动跳动 / 事件丢失）
      var on = allCb.checked;
      Array.prototype.forEach.call(box.querySelectorAll('input.pt-check'), function (c) { c.checked = on; });
      syncDraftFromCheckboxes(box);
      syncParticipantTristates();
      renderCustomSection();
      renderRooms();
      updatePreview();
    });
    allWrap.appendChild(allCb);
    allWrap.appendChild(document.createTextNode(' 全选（共 ' + state.data.members.length + ' 人）'));
    box.appendChild(allWrap);

    state.data.families.forEach(function (fam) {
      var group = el('div', 'pt-group');
      var mems = state.data.members.filter(function (m) { return m.familyId === fam.id; });

      // ---- 家庭标题行：家庭名（保留 pt-family 类）+ 家庭全选 ----
      var headRow = el('div', 'pt-family-row');
      headRow.appendChild(el('div', 'pt-family', fam.name));
      var famAllWrap = el('label', 'pt-fam-all');
      if (mems.length) {
        var famCb = document.createElement('input');
        famCb.type = 'checkbox';
        famCb.className = 'pt-fam-check';
        famCb.setAttribute('data-family-id', fam.id);
        famCb.addEventListener('change', function () {
          var on = famCb.checked;
          mems.forEach(function (m) {
            var cell = box.querySelector('input.pt-check[value="' + m.id + '"]');
            if (cell) cell.checked = on;
          });
          syncDraftFromCheckboxes(box);
          syncParticipantTristates();
          renderCustomSection();
          renderRooms();
          updatePreview();
        });
        famAllWrap.appendChild(famCb);
      }
      famAllWrap.appendChild(document.createTextNode(' 全选'));
      headRow.appendChild(famAllWrap);
      group.appendChild(headRow);

      // ---- 该家庭的成员勾选 ----
      var row = el('div', 'pt-members');
      if (mems.length === 0) row.appendChild(el('span', 'hint', '（无成员）'));
      mems.forEach(function (m) {
        var lbl = el('label', 'pt-item');
        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'pt-check';
        cb.value = m.id;
        cb.checked = draft.participants.indexOf(m.id) !== -1;
        cb.addEventListener('change', function () {
          if (cb.checked) {
            if (draft.participants.indexOf(m.id) === -1) draft.participants.push(m.id);
          } else {
            draft.participants = draft.participants.filter(function (x) { return x !== m.id; });
          }
          renderCustomSection();
          renderRooms();
          syncParticipantTristates();
          updatePreview();
        });
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(' ' + m.name + '（' + typeLabel(m.type) + '）'));
        row.appendChild(lbl);
      });
      group.appendChild(row);
      box.appendChild(group);
    });

    syncParticipantTristates();
  }

  /** 依据当前成员 checkbox 的勾选状态回写 draft.participants（按成员表顺序）。 */
  function syncDraftFromCheckboxes(box) {
    var checked = {};
    Array.prototype.forEach.call(box.querySelectorAll('input.pt-check'), function (c) {
      if (c.checked) checked[c.value] = true;
    });
    draft.participants = state.data.members
      .map(function (m) { return m.id; })
      .filter(function (id) { return checked[id]; });
  }

  /**
   * 重算「总全选」与各「家庭全选」的三态（全选 checked / 部分 indeterminate / 全未选 都不设）。
   * 只改 checkbox 的 .checked / .indeterminate，不重建 DOM。
   */
  function syncParticipantTristates() {
    var box = $('participants-container');
    if (!box) return;

    var all = box.querySelectorAll('input.pt-check');
    var total = all.length;
    var checkedCount = 0;
    Array.prototype.forEach.call(all, function (c) { if (c.checked) checkedCount++; });

    // 家庭全选三态
    Array.prototype.forEach.call(box.querySelectorAll('.pt-fam-check'), function (fc) {
      var fid = fc.getAttribute('data-family-id');
      var mems = state.data.members.filter(function (m) { return m.familyId === fid; });
      var n = mems.length;
      var on = 0;
      mems.forEach(function (m) {
        var cell = box.querySelector('input.pt-check[value="' + m.id + '"]');
        if (cell && cell.checked) on++;
      });
      if (n > 0 && on === n) { fc.checked = true; fc.indeterminate = false; }
      else if (on > 0) { fc.checked = false; fc.indeterminate = true; }
      else { fc.checked = false; fc.indeterminate = false; }
    });

    // 总全选三态
    var sa = box.querySelector('#pt-select-all');
    if (sa) {
      if (total > 0 && checkedCount === total) { sa.checked = true; sa.indeterminate = false; }
      else if (checkedCount > 0) { sa.checked = false; sa.indeterminate = true; }
      else { sa.checked = false; sa.indeterminate = false; }
    }
  }

  function renderTicketPrices() {
    var p = draft.prices || {};
    $('price-adult').value = (p.adult === '' || p.adult === undefined) ? '' : p.adult;
    $('price-elder').value = (p.elder === '' || p.elder === undefined) ? '' : p.elder;
    $('price-child').value = (p.child === '' || p.child === undefined) ? '' : p.child;
  }

  /**
   * 房间是否「填了房价但没有任何入住人」——红字提示的唯一判据。
   * 与 calc.js room 分支的判定保持一致：仅当房价 > 0 且无有效入住人时视为无效。
   */
  function isRoomInvalid(room) {
    var p = Number(room && room.price);
    if (!isFinite(p)) p = 0;
    var occ = (room && room.occupants) ? room.occupants : [];
    return p > 0 && occ.length === 0;
  }

  function renderRooms() {
    var box = $('rooms-container');
    clearNode(box);
    if (!draft.rooms) draft.rooms = [];
    if (draft.rooms.length === 0) {
      box.appendChild(el('p', 'hint', '还没有房间，点击下方「+ 添加房间」。'));
    }
    draft.rooms.forEach(function (room, idx) {
      room.occupants = room.occupants || [];
      var card = el('div', 'room-card');
      var errEl = null; // 本行的红字提示节点（仅当无效时才存在于 DOM 中）

      // 轻量同步本行红字：仅当「该行无效 且 已被用户确认过」时插入，否则移除。
      // 只增删这一个提示节点、绝不重建整行，避免输入过程中输入框失焦、光标跳到开头。
      // 判据统一来自 isRoomInvalid()；「是否确认」来自瞬态 roomConfirmed（不写入费用数据）。
      function syncRoomError() {
        var invalid = isRoomInvalid(room) && isRoomConfirmed(room);
        if (invalid && !errEl) {
          errEl = el('div', 'room-error',
            '请为该房间选择入住人，或将该房间房价填为 0');
          card.appendChild(errEl);
        } else if (!invalid && errEl) {
          if (errEl.parentNode) errEl.parentNode.removeChild(errEl);
          errEl = null;
        }
      }

      var head = el('div', 'room-head');
      var nameInput = document.createElement('input');
      nameInput.type = 'text';
      nameInput.placeholder = '房间名（如 A房）';
      nameInput.value = room.name || '';
      nameInput.addEventListener('input', function () { room.name = nameInput.value; });
      head.appendChild(nameInput);

      var priceInput = document.createElement('input');
      priceInput.type = 'number';
      priceInput.step = '0.01';
      priceInput.placeholder = '房价（原币）';
      priceInput.value = (room.price === '' || room.price === undefined) ? '' : room.price;
      priceInput.addEventListener('input', function () {
        room.price = priceInput.value === '' ? '' : Number(priceInput.value);
        // 输入过程中不显示红字（避免"还没填完就催促"）；但若此前已显示、现已合法则立即隐藏。
        syncRoomError();
        updatePreview();
      });
      priceInput.addEventListener('blur', function () {
        // 房价框失焦 → 该行进入「已确认」状态，此后按 isRoomInvalid 正常显隐。
        confirmRoom(room);
        syncRoomError();
      });
      head.appendChild(priceInput);

      var delBtn = el('button', 'btn small danger', '删除');
      delBtn.type = 'button';
      delBtn.addEventListener('click', function () {
        draft.rooms.splice(idx, 1);
        renderRooms();
        updatePreview();
      });
      head.appendChild(delBtn);
      card.appendChild(head);

      var occBox = el('div', 'room-occ');
      occBox.appendChild(el('span', 'occ-label', '入住人：'));
      state.data.families.forEach(function (fam) {
        var famWrap = el('span', 'occ-fam');
        famWrap.appendChild(el('span', 'occ-fam-name', fam.name + '：'));
        var mems = state.data.members.filter(function (m) { return m.familyId === fam.id; });
        if (mems.length === 0) famWrap.appendChild(el('span', 'hint', '（无）'));
        mems.forEach(function (m) {
          var lbl = el('label', 'pt-item');
          var cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = m.id;
          cb.checked = room.occupants.indexOf(m.id) !== -1;
          cb.addEventListener('change', function () {
            if (cb.checked) {
              if (room.occupants.indexOf(m.id) === -1) room.occupants.push(m.id);
            } else {
              room.occupants = room.occupants.filter(function (x) { return x !== m.id; });
            }
            // 勾选/取消入住人是明确的用户动作 → 立即进入「已确认」并同步显隐。
            // 尤其是「取消最后一个入住人」必须马上看到红字。
            confirmRoom(room);
            syncRoomError();
            updatePreview();
          });
          lbl.appendChild(cb);
          lbl.appendChild(document.createTextNode(' ' + m.name));
          famWrap.appendChild(lbl);
        });
        occBox.appendChild(famWrap);
      });
      card.appendChild(occBox);

      // 首次渲染时按当前草稿状态同步红字：任何一次重渲染都能得到正确结果，
      // 且不依赖任何外部传入的错误状态。
      syncRoomError();

      box.appendChild(card);
    });
  }

  function renderCustomSection() {
    var box = $('custom-container');
    clearNode(box);
    if (!draft.customAmounts) draft.customAmounts = {};
    var members = state.data.members.filter(function (m) {
      return draft.participants.indexOf(m.id) !== -1;
    });
    if (members.length === 0) {
      box.appendChild(el('p', 'hint', '请先在上方勾选参与成员。'));
      updateCustomDiff();
      return;
    }
    members.forEach(function (m) {
      var row = el('div', 'custom-row');
      row.appendChild(el('span', 'custom-name', m.name + '（' + familyName(m.familyId) + '）'));
      var input = document.createElement('input');
      input.type = 'number';
      input.step = '0.01';
      input.value = (draft.customAmounts[m.id] === undefined || draft.customAmounts[m.id] === '')
        ? '' : draft.customAmounts[m.id];
      input.addEventListener('input', function () {
        draft.customAmounts[m.id] = input.value === '' ? '' : Number(input.value);
        updateCustomDiff();
        updatePreview();
      });
      row.appendChild(input);
      box.appendChild(row);
    });
    updateCustomDiff();
  }

  function updateCustomDiff() {
    var box = $('custom-diff');
    clearNode(box);
    if (!draft || draft.splitMode !== 'custom') return;
    var sum = 0;
    var ids = Object.keys(draft.customAmounts || {});
    ids.forEach(function (k) {
      var v = Number(draft.customAmounts[k]);
      if (isFinite(v)) sum += v;
    });
    var amount = Number(draft.amount) || 0;
    var diff = amount - sum;
    var text = '已填合计 ' + num2(sum) + ' ' + (draft.currency || '') +
      '　／　项目总额 ' + num2(amount) + ' ' + (draft.currency || '');
    if (Math.abs(diff) > 0.005) {
      text += '　→　相差 ' + num2(diff) + '（保存后会自动按比例调整并提示）';
      box.className = 'note warn-note';
    } else {
      box.className = 'note';
    }
    box.textContent = text;
  }

  function buildTempExpense() {
    return {
      id: draft.id,
      title: draft.title,
      category: draft.category,
      currency: draft.currency,
      amount: Number(draft.amount) || 0,
      rate: Number(draft.rate) || 0,
      payerMemberId: draft.payerMemberId,
      splitMode: draft.splitMode,
      participants: draft.participants.slice(),
      prices: draft.prices,
      rooms: draft.rooms,
      customAmounts: draft.customAmounts
    };
  }

  function syncDraftScalars() {
    if (!draft) return;
    draft.date = $('exp-date').value;
    draft.title = $('exp-title').value;
    draft.category = $('exp-category').value;
    draft.currency = $('exp-currency').value;
    draft.amount = $('exp-amount').value;
    draft.rate = $('exp-rate').value;
    draft.payerMemberId = $('exp-payer').value;
    draft.splitMode = $('exp-splitmode').value;
    draft.note = $('exp-note').value;
    draft.prices = {
      adult: $('price-adult').value,
      elder: $('price-elder').value,
      child: $('price-child').value
    };
  }

  function updatePreview() {
    if (!draft) return;
    syncDraftScalars();
    var box = $('expense-preview');
    clearNode(box);

    var res = C.allocateExpense(buildTempExpense(), state.data);
    box.appendChild(el('div', 'preview-title',
      '本笔分摊预览（折算为 ' + state.data.baseCurrency + '）'));

    var ids = Object.keys(res.alloc);
    if (ids.length === 0) {
      box.appendChild(el('div', 'hint', '暂无可分摊的成员（请检查参与人 / 金额 / 汇率）。'));
    } else {
      ids.forEach(function (mid) {
        var m = memberById(mid);
        var line = el('div', 'preview-line');
        line.appendChild(el('span', null, (m ? m.name : mid) + '　'));
        line.appendChild(el('span', 'preview-amt', money(res.alloc[mid], '¥')));
        box.appendChild(line);
      });
      box.appendChild(el('div', 'preview-total', '合计 ' + money(res.total, '¥')));
    }
    res.warnings.forEach(function (w) {
      box.appendChild(el('div', 'msg warn', w));
    });
  }

  function saveExpense() {
    if (!draft) return;
    syncDraftScalars();

    var errs = [];
    if (!draft.title || !draft.title.trim()) errs.push('请填写项目名称');
    var amt = Number(draft.amount);
    if (draft.amount === '' || draft.amount === undefined || !isFinite(amt) || amt < 0) {
      errs.push('请填写有效的金额（不得为空或负数）');
    }
    var rate = Number(draft.rate);
    if (draft.rate === '' || draft.rate === undefined || !isFinite(rate) || rate <= 0) {
      errs.push('请填写有效的汇率（必须大于 0）');
    }
    if (!draft.payerMemberId) errs.push('请选择付款人');
    if (!draft.participants || draft.participants.length === 0) {
      errs.push('请至少勾选一名参与成员');
    }
    if (draft.splitMode === 'room') {
      if (!draft.rooms || draft.rooms.length === 0) {
        errs.push('「酒店房间」分摊方式至少需要一间房');
      } else {
        draft.rooms.forEach(function (r, i) {
          if (isRoomInvalid(r)) {
            errs.push('第 ' + (i + 1) + ' 间房已填房价但未选择入住人（请选择入住人，或把该房房价改为 0）');
          }
        });
      }
    }
    if (draft.splitMode === 'custom') {
      var hasAny = false;
      draft.participants.forEach(function (mid) {
        if (Number(draft.customAmounts[mid]) > 0) hasAny = true;
      });
      if (!hasAny) errs.push('「自定义金额」至少要为一位参与成员填写金额');
    }
    if (errs.length) {
      // 校验失败时若处于房间模式：把当前无效的房间标记为「已确认」（兜底，即使该行从未失焦过），
      // 再重渲染房间区（草稿对象已含用户输入值，重建安全），让红字提示立刻出现，然后弹出错误汇总。
      if (draft.splitMode === 'room') {
        (draft.rooms || []).forEach(function (r) { if (isRoomInvalid(r)) confirmRoom(r); });
        renderRooms();
      }
      showToast('暂时无法保存：\n· ' + errs.join('\n· '), 'error');
      return;
    }

    var clean = normalizeExpense(draft);
    var list = state.data.expenses;
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].id === clean.id) idx = i;
    if (idx >= 0) list[idx] = clean; else list.push(clean);

    touchTrip();
    save();
    closeExpenseModal();
    renderAll();
  }

  // ===========================================================================
  // 数据管理动作
  // ===========================================================================

  /**
   * 导出「当前行程」（单个行程 JSON，格式与 v1 单行程一致，向后兼容；文件名不变）。
   * 只读操作，不 touchTrip、不改动任何数据。
   */
  function exportData() {
    var json = JSON.stringify(state.data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = (state.data.tripName || 'trip') + '-记账数据.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /** 导出「全部旅程」（整个 journey library 备份）。 */
  function exportLibrary() {
    var json = JSON.stringify(state.library, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    var d = new Date();
    var mm = String(d.getMonth() + 1); if (mm.length < 2) mm = '0' + mm;
    var dd = String(d.getDate()); if (dd.length < 2) dd = '0' + dd;
    a.download = '行程库备份-' + d.getFullYear() + mm + dd + '.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  // ===========================================================================
  // 旅程 CRUD
  // ===========================================================================

  /** 当前旅程对象（= state.data）。 */
  function currentTrip() { return state.data; }

  /** 新建旅程并切换过去。 */
  function createTrip(name) {
    var t = createEmptyTrip(name);
    state.library.trips.push(t);
    state.library.activeTripId = t.id;
    state.data = t;
    save();
    renderAll();
    showToast('已创建旅程「' + t.tripName + '」', 'success');
  }

  /** 切换当前旅程（只换引用 + 保存，**不** 刷新 updatedAt）。 */
  function switchTrip(id) {
    if (!id || id === state.library.activeTripId) return;
    if (!findTrip(state.library, id)) return;
    state.library.activeTripId = id;
    state.data = activeTripRef(state.library);
    save();
    renderAll();
  }

  /** 重命名旅程（内容变更 → 刷新 updatedAt）。 */
  function renameTrip(id, name) {
    var t = findTrip(state.library, id);
    if (!t) return;
    var v = (name || '').trim();
    if (!v || v === t.tripName) { renderTrips(); return; }
    t.tripName = v;
    touchTrip();
    save();
    renderAll();
  }

  /** 删除旅程（页内确认；至少保留一个旅程）。 */
  function deleteTrip(id) {
    var t = findTrip(state.library, id);
    if (!t) return;
    confirmDialog({
      title: '删除旅程',
      message: '确定删除旅程「' + t.tripName + '」吗？该旅程的家庭、成员和费用都会被删除，且不可恢复。',
      confirmText: '删除',
      cancelText: '取消',
      danger: true
    }, function (ok) {
      if (!ok) return;
      var idx = -1;
      for (var i = 0; i < state.library.trips.length; i++) {
        if (state.library.trips[i].id === id) { idx = i; break; }
      }
      if (idx < 0) return;
      state.library.trips.splice(idx, 1);
      if (!state.library.trips.length) state.library.trips.push(createEmptyTrip('我的旅程'));
      var next = state.library.trips[Math.min(idx, state.library.trips.length - 1)];
      state.library.activeTripId = next.id;
      state.data = activeTripRef(state.library);
      save();
      renderAll();
      showToast('已删除旅程。', 'success');
    });
  }

  /**
   * 导入：格式嗅探，**只新增、绝不覆盖或清空已有旅程**。
   *   · {trips:[...]}  → 整库：逐段规范化为旅程并强制换新 id 后追加
   *   · {families:[...]} → 单行程：包成一个新旅程追加
   */
  function importData() {
    var file = $('import-file').files[0];
    if (!file) { showToast('请先选择要导入的 JSON 文件', 'error'); return; }
    var reader = new FileReader();
    reader.onload = function (ev) {
      try {
        var obj = JSON.parse(ev.target.result);
        if (obj && typeof obj === 'object' && Array.isArray(obj.trips)) {
          // 整库导入
          var added = [];
          obj.trips.forEach(function (raw) {
            var t = normalizeTrip(raw);
            t.id = uid(); // 强制换新 id，避免与已有旅程冲突
            added.push(t);
          });
          if (!added.length) throw new Error('旅程列表为空');
          added.forEach(function (t) { state.library.trips.push(t); });
          state.library.activeTripId = added[0].id;
          state.data = activeTripRef(state.library);
          save();
          renderAll();
          showToast('已导入 ' + added.length + ' 个旅程', 'success');
          return;
        }
        if (obj && typeof obj === 'object' && Array.isArray(obj.families)) {
          // 单行程导入 → 作为新旅程追加
          var t2 = normalizeTrip(obj);
          t2.id = uid();
          state.library.trips.push(t2);
          state.library.activeTripId = t2.id;
          state.data = activeTripRef(state.library);
          save();
          renderAll();
          showToast('已导入为新旅程「' + t2.tripName + '」', 'success');
          return;
        }
        throw new Error('既不是旅程库（缺 trips），也不是单行程（缺 families）');
      } catch (err) {
        showToast('导入失败：文件不是有效的记账数据。\n' + err.message, 'error');
      }
    };
    reader.onerror = function () { showToast('读取文件失败，请重试。', 'error'); };
    reader.readAsText(file);
  }

  /** 载入示例：**新增**一个示例旅程并切过去，不影响现有旅程。 */
  function loadSample() {
    confirmDialog({
      title: '载入示例旅程',
      message: '将新增一个示例旅程（不影响现有旅程），确定继续吗？',
      confirmText: '新增示例旅程',
      cancelText: '取消'
    }, function (ok) {
      if (!ok) return;
      var t = defaultTrip();
      state.library.trips.push(t);
      state.library.activeTripId = t.id;
      state.data = t;
      save();
      renderAll();
      showToast('已新增示例旅程。', 'success');
    });
  }

  /** 只清空当前行程的费用记录，保留家庭/成员/币种/类别；两次确认 + 改文案。 */
  function clearAll() {
    var t = state.data;
    if (!t || !t.expenses || t.expenses.length === 0) {
      showToast('当前旅程没有费用记录', 'info');
      return;
    }
    confirmDialog({
      title: '清空费用记录',
      message: '将清空当前旅程「' + (t.tripName || '') + '」的全部费用记录（共 ' + t.expenses.length + ' 笔）。家庭与成员、币种汇率、费用类别均会保留。此操作不可恢复。',
      confirmText: '下一步',
      cancelText: '取消',
      danger: true
    }, function (ok1) {
      if (!ok1) return;
      confirmDialog({
        title: '再次确认',
        message: '真的要清空当前旅程的全部费用记录吗？家庭与成员会保留。',
        confirmText: '确认清空',
        cancelText: '取消',
        danger: true
      }, function (ok2) {
        if (!ok2) return;
        var tt = state.data; // 就地改，保留 id / tripName / families / members / currencies / categories
        tt.expenses = [];
        touchTrip();
        save();
        renderAll();
        showToast('已清空费用记录。', 'success');
      });
    });
  }

  function addCurrency() {
    var code = ($('new-cur-code').value || '').trim().toUpperCase();
    var name = ($('new-cur-name').value || '').trim();
    var rate = Number($('new-cur-rate').value);
    if (!code) { showToast('请填写币种代码，如 JPY', 'error'); return; }
    if (!name) { showToast('请填写币种名称，如 日元', 'error'); return; }
    if (!isFinite(rate) || rate <= 0) { showToast('汇率必须大于 0', 'error'); return; }
    var exists = state.data.currencies.some(function (c) { return c.code === code; });
    if (exists) { showToast('币种 ' + code + ' 已存在', 'error'); return; }
    state.data.currencies.push({ code: code, name: name, rate: rate });
    $('new-cur-code').value = '';
    $('new-cur-name').value = '';
    $('new-cur-rate').value = '';
    touchTrip();
    save();
    renderAll();
  }

  function addFamily() {
    var name = ($('new-family-name').value || '').trim();
    if (!name) { showToast('请填写家庭名称', 'error'); return; }
    state.data.families.push({ id: C.newId(), name: name });
    $('new-family-name').value = '';
    touchTrip();
    save();
    renderAll();
  }

  function addMember() {
    var name = ($('new-member-name').value || '').trim();
    var familyId = $('new-member-family').value;
    var type = $('new-member-type').value;
    if (!name) { showToast('请填写成员姓名', 'error'); return; }
    if (!familyId) { showToast('请先在「家庭与成员」中添加一个家庭', 'error'); return; }
    state.data.members.push({ id: C.newId(), familyId: familyId, name: name, type: type });
    $('new-member-name').value = '';
    touchTrip();
    save();
    renderAll();
  }

  // ===========================================================================
  // 事件绑定
  // ===========================================================================

  function bindEvents() {
    // Tab 1
    $('add-family-btn').addEventListener('click', addFamily);
    $('add-member-btn').addEventListener('click', addMember);

    // Tab 2
    $('add-expense-btn').addEventListener('click', function () { openExpenseModal(null); });

    // 弹窗静态字段
    $('expense-close-btn').addEventListener('click', closeExpenseModal);
    $('expense-cancel-btn').addEventListener('click', closeExpenseModal);
    $('expense-save-btn').addEventListener('click', saveExpense);

    $('exp-currency').addEventListener('change', function () {
      if (!draft) return;
      draft.currency = this.value;
      draft.rate = currencyRate(this.value);
      $('exp-rate').value = draft.rate;
      updateCustomDiff();
      updatePreview();
    });
    $('exp-splitmode').addEventListener('change', function () {
      if (!draft) return;
      draft.splitMode = this.value;
      showSplitSections();
      if (draft.splitMode === 'ticket') renderTicketPrices();
      if (draft.splitMode === 'room') renderRooms();
      if (draft.splitMode === 'custom') renderCustomSection();
      updatePreview();
    });

    ['exp-amount', 'exp-rate', 'exp-date', 'exp-title', 'exp-category', 'exp-note',
      'price-adult', 'price-elder', 'price-child'].forEach(function (id) {
      var node = $(id);
      node.addEventListener('input', updatePreview);
      node.addEventListener('change', updatePreview);
    });

    $('add-room-btn').addEventListener('click', function () {
      if (!draft) return;
      draft.rooms = draft.rooms || [];
      draft.rooms.push({ name: '房间' + (draft.rooms.length + 1), price: '', occupants: [] });
      renderRooms();
      updatePreview();
    });

    // Tab 3
    $('print-btn').addEventListener('click', function () { window.print(); });

    // Tab 4
    $('export-btn').addEventListener('click', exportData);
    $('export-lib-btn').addEventListener('click', exportLibrary);
    $('import-btn').addEventListener('click', importData);
    $('sample-btn').addEventListener('click', loadSample);
    $('restore-btn').addEventListener('click', restoreBackup);
    $('clear-btn').addEventListener('click', clearAll);
    $('add-cur-btn').addEventListener('click', addCurrency);
    $('add-cat-btn').addEventListener('click', addCategory);
    $('new-cat-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('add-cat-btn').click(); }
    });

    // 旅程切换与新建（顶栏下拉 + 「我的旅程」页签）
    $('trip-switcher').addEventListener('change', function () { switchTrip(this.value); });
    $('new-trip-btn').addEventListener('click', function () {
      var v = $('new-trip-name').value.trim();
      $('new-trip-name').value = '';
      createTrip(v);
    });
    $('new-trip-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); $('new-trip-btn').click(); }
    });

    $('trip-name-input').addEventListener('change', function () {
      state.data.tripName = this.value;
      touchTrip();
      save();
      renderHeader();
      renderTrips();
    });

    $('base-currency-select').addEventListener('change', function () {
      state.data.baseCurrency = this.value;
      state.data.currencies.forEach(function (c) {
        if (c.code === state.data.baseCurrency) c.rate = 1;
      });
      touchTrip();
      save();
      renderAll();
    });

    // 点遮罩关闭弹窗
    $('expense-modal').addEventListener('click', function (e) {
      if (e.target === $('expense-modal')) closeExpenseModal();
    });

    // ---- 页内确认对话框（替代浏览器原生 confirm）----
    $('confirm-ok-btn').addEventListener('click', function () { closeConfirmDialog(true); });
    $('confirm-cancel-btn').addEventListener('click', function () { closeConfirmDialog(false); });
    $('confirm-close-btn').addEventListener('click', function () { closeConfirmDialog(false); });
    $('confirm-modal').addEventListener('click', function (e) {
      if (e.target === $('confirm-modal')) closeConfirmDialog(false);
    });
    // Esc 取消确认框；确认框未打开时不干扰其它输入（如重命名输入框自己处理 Esc）
    document.addEventListener('keydown', function (e) {
      if (!isConfirmOpen()) return;
      if (e.key === 'Escape' || e.key === 'Esc' || e.keyCode === 27) {
        e.preventDefault();
        closeConfirmDialog(false);
      }
    });
  }

  // ===========================================================================
  // 总渲染 & 启动
  // ===========================================================================

  function renderAll() {
    renderHeader();
    renderNewMemberFamilySelect();
    renderFamilies();
    renderExpenseList();
    renderSummary();
    renderFamilyDetail();
    renderDataTab();
    renderTrips();
  }

  function init() {
    load();
    // 清理早期版本自动灌入的示例数据（仅当整库只有那一条示例时才动手）
    var purgedSample = purgeAutoSeededSample();
    initTabs();
    bindEvents();
    renderAll();
    // 启动时若已保存数据读不出来：明确告知「未做任何覆盖」，并给出留底路径
    if (state.loadBroken) {
      showToast('读取本机已保存的数据失败。为避免覆盖你的原始数据，本次启动未写入任何内容'
        + '（原数据仍留在本机）。请到「数据管理」用「导出全部旅程」先留底。', 'error');
    } else if (purgedSample) {
      showToast('已自动清除早前版本自动生成的示例数据（当前为空白旅程）。', 'success');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

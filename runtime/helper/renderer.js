/*
 * dsh-star-pet · 渲染端
 * ------------------------------------------------------------------
 * 与 workpet.py 的 Tk 版逐项对齐：几何、字号、配色、挤压帧、看板版式、
 * 右键菜单、飘字、悬停提示、贴边吸附与镜像。
 *
 * 所有坐标都是「逻辑像素」——Electron 的 CSS px 就是 DIP，和 Tk 的
 * px 缩放后的物理像素在 100% 缩放下等价；高 DPI 由 Electron 统一缩放。
 */

const S = window.starPet;

// ───────────────────────────── 主题常量（与 workpet.py 一致）
const C = {
	CARD: "#171b23",
	CARD_SOFT: "#1f2430",
	STROKE: "#2b3242",
	FG: "#e9eef8",
	DIM: "#7d8798",
	MONEY: "#3ad17f",
	ACCENT: "#5b9cff",
	BAR_BG: "#242b38",
	GOLD: "#e8c060",
};

const PAD = 9;
const GAP = 8;
const PANEL_W = 344;
const PANEL_H = 274;
const CHIP_H = 27;
const PET_SIZES = [96, 108, 135];

// 字体：Tk 的点值 → CSS px（1pt = 96/72 px）
const FONT = {
	label: 7 * (96 / 72),   // 9.333
	small: 9 * (96 / 72),   // 12
	big: 17 * (96 / 72),    // 22.667
	chip: 9 * (96 / 72),
	float: 9 * (96 / 72),
};

const FAMILY_SOFT = '"StarPetSoft", "幼圆", "YouYuan", "Yuanti SC", "Microsoft YaHei", sans-serif';
const FAMILY_PLAIN = '"幼圆", "YouYuan", "Yuanti SC", "Microsoft YaHei", "Segoe UI", sans-serif';

// 挤压帧：e 从 -0.20 到 1.20，步长 0.05，共 29 帧
const SQUISH_STEP = 0.05;
const SQUISH_E = Array.from({ length: Math.round(1.4 / SQUISH_STEP) + 1 }, (_, i) => -0.2 + SQUISH_STEP * i);
const SQUISH_DUR = 220;
const FLOAT_LIFE = 1400;
const FLOAT_RISE = 30;
const FLOAT_DEFAULT_SEC = 5; // 默认 5 秒一个（可在设置里 1–10 秒调）
/** 读取「冒钱间隔」：夹到 1–10 秒，缺省 5。 */
function floatSec() {
	const v = Math.round(Number(st.cfg && st.cfg.float_every_sec));
	return Number.isFinite(v) && v >= 1 && v <= 10 ? v : FLOAT_DEFAULT_SEC;
}
/** 读取「吐槽间隔」：夹到 5–120 秒，缺省 30。 */
function banterEverySec() {
	const v = Math.round(Number(st.cfg && st.cfg.banter_every_sec));
	return Number.isFinite(v) && v >= BANTER_MIN_SEC && v <= BANTER_MAX_SEC ? v : BANTER_DEFAULT_SEC;
}
const WD_NAMES = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];

// ── 吐槽（banter）：气泡从宠物头顶冒出、像冒钱一样上飘渐隐。
// 语句由宿主 /banter 下发（读用户配置目录里的 banter.txt），读不到时用这里的默认值兜底。
const BANTER_MIN_SEC = 5;      // 吐槽间隔下限（秒）
const BANTER_MAX_SEC = 120;    // 吐槽间隔上限（秒）
const BANTER_DEFAULT_SEC = 30; // 默认 30 秒随机出一条
const BANTER_LIFE = 3600;      // 气泡存活 ms（比冒钱久，够读完一句话）
const BANTER_RISE = 46;        // 上飘距离 px
const BANTER_MAX_W = 260;      // 气泡最大宽度 px（更大更可爱）
const BANTER_FONT = 14;        // 气泡字号 px
const DEFAULT_BANTER = {
	normal: [
		"歇一会吧", "天塌了...", "再睡五分钟...", "啊？我吗？",
		"好焦虑...怎么办", "人就不能躺一辈子吗...", "我精神好得很！", "休息一会...睡了",
		"好虚...好累", "那咋了", "然后呢，我能咋办", "biubiu你~",
		"虽然什么都没干，但还是辛苦我了", "要不问问AI？", "我最棒！", "记得喝水！",
	],
	before: [
		"明天的事交给明天的自己去处理吧！", "事已至此，先吃饭吧！",
		"等会下班吃什么？", "今晚去哪玩？", "突然不困了~",
	],
};

// ───────────────────────────── 状态
const st = {
	cfg: {},
	size: 135,
	expanded: false,
	left: false,
	soft: true,
	winW: 362,
	winH: 413,
	pet: { cx: 0, cy: 0, w: 0, h: 0, box: null },
	frameIdx: 0,
	squishE: 0,
	squish: null, // {from, to, t0}
	display: 0,
	floats: [],
	floatAcc: 0,
	floatSeed: 20261105,
	pointerInside: false,
	dragging: null, // {x, y, moved}
	lastSnap: null,
	banter: { normal: [], before: [] },
	banterAcc: 0,
	banters: [],
};

// ───────────────────────────── 派生量（对照 config_to_state / Snap）
function parseHHMM(s, dflt) {
	const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || "").trim());
	if (!m) return dflt;
	return (Math.min(23, +m[1]) * 60 + Math.min(59, +m[2])) % 1440;
}
function fmtHHMM(min) {
	const v = ((Math.round(min) % 1440) + 1440) % 1440;
	return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
}
function money(v) {
	const n = Number(v) || 0;
	if (Math.abs(n) >= 100000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
	return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function durText(sec) {
	let s = Math.max(0, Math.floor(sec));
	const h = Math.floor(s / 3600); s -= h * 3600;
	const m = Math.floor(s / 60); s -= m * 60;
	return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}
function blend(c1, c2, t) {
	const tt = Math.max(0, Math.min(1, t));
	const a = [1, 3, 5].map((i) => parseInt(c1.slice(i, i + 2), 16));
	const b = [1, 3, 5].map((i) => parseInt(c2.slice(i, i + 2), 16));
	return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * tt).toString(16).padStart(2, "0")).join("");
}

function computeState(cfg) {
	// 月薪 0 是合法设置（例如待业、只靠加班赚钱），不能被 `|| 10000` 吞成默认值，
	// 否则设置页显示 0、看板却按 1 万冒钱。只有「没填」才回退 10000。
	const monthlyFilled = cfg.monthly_wage != null && String(cfg.monthly_wage).trim() !== "";
	const monthly = monthlyFilled ? Math.max(0, Number(cfg.monthly_wage) || 0) : 10000;
	const dailyWage = cfg.daily_wage ? Number(cfg.daily_wage) : null;
	// 月计薪天数：与 lib/index.js sanitizePatch 的 Math.max(1, ...) 保持一致。
	// 之前直接 `Number(...) || 21.75` 有两个坑：0 会被当成「没填」跳回 21.75，
	// 负数会一路带到看板让金额变负。这里统一夹到 1~30（一个月最多 30 天），非法值才回退默认。
	const payDaysRaw = Number(cfg.pay_days_per_month);
	const payDays = Number.isFinite(payDaysRaw) && payDaysRaw >= 1 ? Math.min(30, payDaysRaw) : 21.75;
	const startMin = parseHHMM(cfg.work_start, 540);
	const endMin = parseHHMM(cfg.work_end, 1020);
	const lunchMin = Math.max(0, parseInt(cfg.lunch_minutes || 0, 10) || 0);
	const lunchStartMin = cfg.lunch_start ? parseHHMM(cfg.lunch_start, startMin + 150) : startMin + 150;
	const lunchAfterMin = ((lunchStartMin - startMin) % 1440 + 1440) % 1440;
	const onSite = Math.max(0, endMin - startMin);
	// 只扣「真正落在上下班区间内」的午休。之前无条件减 lunchMin，
	// 一旦午休（如 11:30–13:00）落在上班时段（如 09:00–17:00）之外，
	// 就会把计薪工时扣成 0 或负数 → perSec = 0 → 看板和飘字永远是 0。
	const lunchLo = lunchStartMin;
	const lunchHi = lunchStartMin + lunchMin;
	const lunchOverlap = Math.max(0, Math.min(endMin, lunchHi) - Math.max(startMin, lunchLo));
	const paid = Math.max(0, onSite - lunchOverlap);
	const daily = dailyWage || monthly / payDays;
	const netSec = paid * 60;
	const perSec = netSec > 0 ? daily / netSec : 0;
	// 加班是独立时段：工作日「加班开始 → 加班结束」，周末/节假日「开始 → 结束」
	// 它不接下班时间，也不占用正常工时——两者按各自费率分别累加
	const otOn = cfg.overtime_enabled === true;
	// 加班日自己选（1=周一 … 7=周日），与上班日互不影响
	const otDays = Array.isArray(cfg.overtime_weekdays) && cfg.overtime_weekdays.length
		? cfg.overtime_weekdays.map(Number)
		: [1, 2, 3, 4, 5];
	// 三档倍率：工作日 / 周末 / 节假日，各自独立（0 / 1.5 / 2 / 3）
	const rateOf = (v) => Math.max(0, Number(v) || 0);
	const otWorkRate = rateOf(cfg.overtime_rate_workday != null ? cfg.overtime_rate_workday : 1.5);
	const otRestRate = rateOf(cfg.overtime_rate_weekend != null ? cfg.overtime_rate_weekend : 2);
	const otHolidayRate = rateOf(cfg.overtime_rate_holiday != null ? cfg.overtime_rate_holiday : 3);
	const otStartWorkdayMin = parseHHMM(cfg.overtime_start_workday, 1140);
	const otEndWorkdayMin = parseHHMM(cfg.overtime_end_workday, 1260);
	const otStartWeekendMin = parseHHMM(cfg.overtime_start_weekend, 540);
	const otEndWeekendMin = parseHHMM(cfg.overtime_end_weekend, 1020);
	const otWorkMin = Math.max(0, otEndWorkdayMin - otStartWorkdayMin);
	const otRestMin = Math.max(0, otEndWeekendMin - otStartWeekendMin);
	return {
		startMin, endMin, lunchMin, lunchStartMin, lunchAfterMin,
		paidMin: paid, daily, netSec, perSec, perHour: perSec * 3600,
		weekdays: Array.isArray(cfg.work_weekdays) && cfg.work_weekdays.length ? cfg.work_weekdays.map(Number) : [1, 2, 3, 4, 5],
		holidays: Array.isArray(cfg.holidays) ? cfg.holidays : [],
		extra: Array.isArray(cfg.extra_workdays) ? cfg.extra_workdays : [],
		otOn, otDays, otWorkRate, otRestRate, otHolidayRate,
		otStartWorkdayMin, otEndWorkdayMin, otStartWeekendMin, otEndWeekendMin, otWorkMin, otRestMin,
	};
}

function ymd(d) {
	return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
}
function isWorkday(D, d) {
	const ds = ymd(d);
	// 补班日优先：即使同时是周末/节假日也强制上班；否则节假日放假。
	if (D.extra.includes(ds)) return true;
	if (D.holidays.includes(ds)) return false;
	return D.weekdays.includes(d.getDay() === 0 ? 7 : d.getDay());
}
function workedSeconds(D, now) {
	const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
	const start = D.startMin;
	const end = D.endMin;
	if (cur <= start) return 0;
	const eff = Math.min(cur, end);
	const span = eff - start;
	if (span <= 0) return 0;
	const ls = start + D.lunchAfterMin;
	const le = ls + D.lunchMin;
	const overlap = Math.max(0, Math.min(eff, le) - Math.max(start, ls));
	return Math.max(0, span - overlap) * 60;
}
function monthRemainingWorkdays(D, now) {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	let n = 0;
	const d = new Date(today);
	while (d.getMonth() === today.getMonth()) {
		if (isWorkday(D, d)) n += 1;
		d.setDate(d.getDate() + 1);
	}
	return n;
}

/** 某一天按设置能拿多少加班工资（整天口径，不含「已经过去多少」）。
 *  上班日走「上班日」那对时段并按工作日倍率；非上班日走另一对，
 *  节假日倍率优先、否则周末倍率。上班日的午休不算加班。 */
function overtimePayForDay(D, d) {
	if (!D.otOn) return 0;
	const dow = d.getDay() === 0 ? 7 : d.getDay();
	if (!D.otDays.includes(dow)) return 0;
	const workday = isWorkday(D, d);
	const ds = ymd(d);
	const isHoliday = D.holidays.includes(ds) && !D.extra.includes(ds);
	let start, end, rate;
	if (workday) {
		start = D.otStartWorkdayMin;
		end = D.otEndWorkdayMin;
		rate = D.otWorkRate;
	} else {
		start = D.otStartWeekendMin;
		end = D.otEndWeekendMin;
		rate = isHoliday ? D.otHolidayRate : D.otRestRate;
	}
	if (rate <= 0 || end <= start) return 0;
	// 午休从加班窗口里剔掉（无论上班日还是休息日，午休都不算钱）
	const ls = D.startMin + D.lunchAfterMin;
	const le = ls + D.lunchMin;
	const lunchIn = Math.max(0, Math.min(end, le) - Math.max(start, ls));
	const spanMin = Math.max(0, end - start - lunchIn);
	// 窝囊费 = 加班工资（只算「比正常工资多出来的部分」）：
	// 不含基本工资（基本工资在日薪格里）、不含午休（spanMin 已扣过午休）。
	// 倍率 1 → 一分不多 = ¥0.00；倍率 2 → 多赚一份；倍率 3 → 多赚两份。
	return Math.max(0, D.perSec * Math.max(0, rate - 1) * spanMin * 60);
}

/** 本月剩余（含今天）：基本工资天数/金额 + 这些天按当前设置能拿的加班工资。 */
function monthRemaining(D, now) {
	const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	let days = 0;
	let ot = 0;
	const d = new Date(today);
	while (d.getMonth() === today.getMonth()) {
		if (isWorkday(D, d)) days += 1;
		ot += overtimePayForDay(D, d);
		d.setDate(d.getDate() + 1);
	}
	return { days, base: days * D.daily, ot };
}
function snapshot(D, now) {
	const workday = isWorkday(D, now);
	const ds = ymd(now);
	// 节假日：在 holidays 里且不是额外补班日
	const isHoliday = D.holidays.includes(ds) && !D.extra.includes(ds);
	// 今天是加班日吗（加班日自己勾，与上班日互不影响）
	const otDay = D.otDays.includes(now.getDay() === 0 ? 7 : now.getDay());
	const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
	const ls = D.startMin + D.lunchAfterMin;
	const le = ls + D.lunchMin;
	let phase = "working";
	let worked = 0;
	// 基础工时（不含加班）：只有工作日才计，休息日的基础进度恒为 0
	let baseWorked = 0;
	// 加班时段（分钟）：上班日走「工作日」那一对，非上班日（周末/节假日）走另一对
	let otWorked = 0;
	let otRate = 0;
	let otStartMin = 0;
	let otEndMin = 0;
	if (workday) {
		if (cur < D.startMin) phase = "before";
		else if (cur >= ls && cur < le && cur < D.endMin) phase = "lunch";
		else if (cur >= D.endMin) phase = "after";
		else phase = "working";
		baseWorked = workedSeconds(D, now);
		worked = baseWorked;
		otStartMin = D.otStartWorkdayMin;
		otEndMin = D.otEndWorkdayMin;
		otRate = D.otWorkRate;
	} else {
		phase = "rest";
		otStartMin = D.otStartWeekendMin;
		otEndMin = D.otEndWeekendMin;
		// 节假日优先按节假日倍率，其余非上班日按周末倍率
		otRate = isHoliday ? D.otHolidayRate : D.otRestRate;
	}
	// 加班总开关关掉、或今天不是加班日 → 倍率归零（日薪柱、加班行、"距离加班" 全靠它判定）
	if (!otDay || !D.otOn) otRate = 0;
	// 时段写反了（结束早于开始）等于没配加班，倍率一并归零，
	// 否则看板会出现「加班窗 0 小时但倍率 ×1.5」这种自相矛盾的显示
	if (otEndMin <= otStartMin) otRate = 0;
	// 下班之后、加班开始之前：上班族视角这是在休息，单独给一个阶段
	//（窗口有效就显示"等加班"，不管倍率多少；时段写反则不算）
	if (workday && cur >= D.endMin && D.otOn && otDay && otEndMin > otStartMin && otStartMin > D.endMin && cur < otStartMin) {
		phase = "idle";
	}
	// 加班是独立时段：覆盖到当前时刻就按「窗口内已过时长」计，和正常工时分开累加
	let overlapMin = 0;
	let overlapSpanMin = 0;
	let otSpanMin = 0;
	if (D.otOn && otDay && otEndMin > otStartMin) {
		// 上班日的午休不算加班（人得吃饭）；休息日的加班窗口不扣午休。
		// 上班日把午休从加班窗口里剔掉，否则「11:00–14:00 加班」会把
		// 11:30–13:00 这 1.5 小时也按加班倍率发钱。
		const ls2 = D.startMin + D.lunchAfterMin;
		const le2 = ls2 + D.lunchMin;
		const lunchIn = (a, b) => Math.max(0, Math.min(b, le2) - Math.max(a, ls2));
		// 加班窗口「有效时长」：扣掉落在里面的午休
		const otEffMin = (upto) => {
			const lo = otStartMin;
			const hi = Math.min(upto, otEndMin);
			if (hi <= lo) return 0;
			return Math.max(0, hi - lo - lunchIn(lo, hi));
		};
		otSpanMin = otEffMin(otEndMin);
		if (cur >= otStartMin) {
			otWorked = otEffMin(cur) * 60;
			worked += otWorked;
			// 非上班日（这里只可能是「加班日」）加班时段走完了，按「已收工」显示。
			// 今天明明干了活，退回「今天休息」是错的。
			if (!workday && cur >= otEndMin) phase = "after";
			// 落在加班窗口内 → 阶段显示「加班中」（优先于 搬砖中/今天休息）。
			// 但上班日的午休落在加班窗口内时不算加班（人得吃饭），保持「午休中」，
			// 否则午休那 1.5 小时会一边显示「加班中」一边按加班倍率冒钱、金额却卡着不涨。
			if (cur < otEndMin) {
				const inLunch = workday && cur >= ls2 && cur < le2;
				phase = inLunch ? "lunch" : "overtime";
			}
			// 加班窗口压到正常上班时段时（例如 16:00–20:00），这一段既在基础工时里、
			// 又按加班倍率算了一遍，等于一份时间拿两份钱。记下重叠的已过时长，
			// 结算时把重叠段的基础工资扣掉，让每一分钟只按一个费率（加班倍率）。
			// 只在上��日做这件事：休息日的基础工时恒为 0，没有可扣的重复部分。
			if (workday) {
				const ovLo = Math.max(D.startMin, otStartMin);
				const ovHi = Math.min(D.endMin, otEndMin);
				if (ovHi > ovLo) {
					const ovElapsed = Math.max(0, Math.min(cur, ovHi) - ovLo);
					overlapMin = Math.max(0, ovElapsed - lunchIn(ovLo, ovLo + ovElapsed));
					overlapSpanMin = Math.max(0, ovHi - ovLo - lunchIn(ovLo, ovHi));
				}
			}
		}
	}
	// 进度条：上班日按「已上工时 / 应上工时」；休息日没有基本工时，
	// 改按「加班已过时长 / 加班总时长」，否则休息日加班永远停在 0%。
	const otSpanSec = otSpanMin * 60;
	const progress = workday
		? (D.netSec > 0 ? Math.max(0, Math.min(1, baseWorked / D.netSec)) : 0)
		: (otSpanSec > 0 ? Math.max(0, Math.min(1, otWorked / otSpanSec)) : 0);
	const otEarned = D.perSec * otRate * otWorked;
	// 加班窗口压进上班时段的那几分钟已经含在 daily*progress 里了，
	// 再按倍率算一次就是重复计薪；这里把重叠段按「一倍工资」扣回来。
	// 重叠段只在「加班真按倍率发钱」时才需要把基础工资扣回（避免一份时间拿两份钱）。
	// 倍率=0（白加班）时 otEarned 本来就是 0，重叠段仍应只按基础工资算，不能再扣。
	const overlapPay = otRate > 0 ? D.perSec * overlapMin * 60 : 0;
	const rem = monthRemaining(D, now);
	const remDays = rem.days;
	// 窝囊费 = 加班工资 = 「比正常时薪多出来的那部分」。
	// 不含基本工资（基本工资本来就在日薪格里）、不含午休（otSpanMin 已经扣过午休）。
	// 倍率 1 → 一分不多，窝囊费 ¥0.00；倍率 2 → 多赚一倍时长；倍率 3 → 多赚两倍时长。
	const otOverBase = otRate > 0 ? Math.max(0, D.perSec * Math.max(0, otRate - 1) * otSpanMin * 60) : 0;
	// 日薪格：上班日总有基本日薪；休息日只有「开了加班、今天是加班日、
	// 而且倍率 > 0」才算这天有工资。倍率 0 是白加班，休息日本来就没有基本工资，
	// 这时显示 0；没排加班的休息日同理。
	const dailyTotal = workday ? D.daily : D.otOn && otDay && otRate > 0 ? D.daily : 0;
	// 窝囊费 = 加班超出基本工资的那部分（差价口径，与设置窗概览的蓝字同源）。
	// 注意：它不等于「今日已赚 − 日薪格」——休息日没有基本工资，日薪格
	// 那 459.77 只是「这天按一天算」的展示口径，不进今日已赚。
	const otDaily = otOverBase;
	// otSpanMin 在上面的加班分支里已经算好（扣过午休），这里不能再声明一次。
	// 已赚 = 基本工资（只有上班日有）+ 加班工资 − 重叠段重复计的部分。
	// 休息日没有基本工资，干多久拿多少全看加班倍率：×0 白干 ¥0.00、×1 原价、
	// ×2 双倍；不能额外再叠一份 D.daily×progress，否则 ×1 会变成双倍工资。
	const earned = workday
		? Math.max(0, D.daily * progress + otEarned - overlapPay)
		: Math.max(0, otEarned);
	return {
		now, workday, phase,
		// 重叠段在 baseWorked 与 otWorked 里各算了一次，显示「已工作」时只能算一次
		worked: Math.max(0, worked - overlapMin * 60),
		progress,
		earned,
		remaining: Math.max(0, D.netSec - baseWorked),
		// 加班中：这一栏改成「距离加班结束」，显示加班还剩多久
		// 倒计时只跟「加班是否正在进行」走，与倍率无关：倍率 0 也是加班，得照常倒数。
		otRemaining: D.otOn && otDay && otEndMin > otStartMin ? Math.max(0, otSpanMin - otWorked / 60) * 60 : 0,
		remDays,
		// 「本月还可赚」拆成两段：基本工资（绿色）+ 本月剩余那些天的加班工资（蓝色）
		monthBase: rem.base,
		monthOt: rem.ot,
		monthLeft: rem.base + rem.ot,
		// 彩蛋：开着加班，但三档加班倍率全是 0（工作日/周末/节假日）——
		// 三档都设成 0 就是"白加班"，不管实际本月加班费算出来是多少
		otAllZero: D.otOn && D.otWorkRate <= 0 && D.otRestRate <= 0 && D.otHolidayRate <= 0,
		otWorked, otRate, otEarned, otSpanMin,
		// 今天实际生效的那一对加班时段（工作日走上班日那对，非上班日走另一对），
		// 看板上的「加班 18:00→21:00」必须显示今天真正在用的这一对
		otStartMin, otEndMin,
		// 窝囊费：非重叠部分按满倍率、与上班时段重叠的部分只补倍率差额。
		// 化简后 = 每秒 × (倍率 × 有效时长 − 重叠时长) × 60。
		// 不能写成「(倍率−1) × (有效时长 − 重叠时长)」——那样非重叠的加班只按
		// 0.5 倍发钱（19:00-21:00 ×1.5 会少给 141.47），是之前的实际 bug。
		otDaily,
		// 日薪柱：上班日显示基本日薪；休息日只有「开了加班且今天确实是加班日」
		// 才算这天有工资，且夹到今天实际能赚到的金额以内。
		dailyTotal,
	};
}

// ───────────────────────────── 布局
function layout() {
	const a = st.size;
	st.winW = Math.max(PANEL_W, a) + 2 * PAD;
	st.winH = PAD + PANEL_H + GAP + a + PAD;
	// Tk _avatar_center_in：窗口在屏幕左半边时，宠物画在窗口左侧（m + a/2），否则右侧。
	const ax = st.left ? PAD : st.winW - PAD - a;
	const ay = st.winH - PAD - a;
	st.pet = { cx: ax + a / 2, cy: ay + a / 2, w: a, h: a, box: [ax, ay, ax + a, ay + a] };
	document.documentElement.style.width = st.winW + "px";
	document.documentElement.style.height = st.winH + "px";
	document.body.style.width = st.winW + "px";
	document.body.style.height = st.winH + "px";
	document.getElementById("stage").style.width = st.winW + "px";
	document.getElementById("stage").style.height = st.winH + "px";
	layoutPet();
	layoutPanel();
}

/** 把 cfg.soft_font 真正落到已经建好的元素上（大金额、胶囊、提示条、面板）。 */
function applyFont() {
	const fam = st.soft ? FAMILY_SOFT : FAMILY_PLAIN;
	document.body.style.fontFamily = fam;
	for (const el of [P.money, document.getElementById("chip"), document.getElementById("tip")]) {
		if (el) el.style.fontFamily = fam;
	}
	const panel = document.getElementById("panel");
	if (panel) panel.style.fontFamily = fam;
}

/** 选最接近的雪碧图档位；按目标尺寸缩放（等价于 Tk 的 zoom）。
 *  屏幕上按 2× 渲染时用 @2x 素材（1:1 设备像素，边缘不虚），
 *  1× 屏幕仍用原图；两者几何一致，只是像素密度不同。 */
const SHEETS = [
	{ size: 135, w: 145, h: 135 },
	{ size: 216, w: 231, h: 216 },
	{ size: 324, w: 345, h: 324 },
];
const HIRES = (window.devicePixelRatio || 1) >= 1.5;
function sheetFor(a) {
	let best = SHEETS[0];
	for (const s of SHEETS) if (Math.abs(s.size - a) < Math.abs(best.size - a)) best = s;
	return best;
}

function layoutPet() {
	const { cx, cy, w, h } = st.pet;
	const sh = sheetFor(st.size);
	const scale = st.size / sh.size;
	const fw = sh.w * scale;
	const fh = sh.h * scale;
	const img = document.getElementById("petImg");
	img.style.width = fw + "px";
	img.style.height = fh + "px";
	img.style.backgroundImage = 'url("../../assets/skins/pet-' + sh.size + (HIRES ? "@2x" : "") + '.webp")';
	img.style.backgroundSize = sh.w * SQUISH_E.length * scale + "px " + fh + "px";
	img._frameW = fw;
	img._sheetW = sh.w;
	img._sheetScale = scale;

	const wrap = document.getElementById("petWrap");
	wrap.style.width = fw + "px";
	wrap.style.height = fh + "px";
	wrap.style.left = cx - fw / 2 + "px";
	wrap.style.top = cy - fh / 2 + "px";
	wrap.style.transform = st.left ? "scaleX(-1)" : "none";
	if (!st.squish) st.frameIdx = frameFor(st.squishE);
	applyFrame();
}

/** 把形变量 e 映射到最接近的一帧。静止时必须停在 e≈0 的正面帧上，
 *  否则默认 0 号帧是挤压到 -0.20 的极端帧，几乎看不见（曾经的"桌宠不出来"就是这个）。 */
function frameFor(e) {
	return SQUISH_E.reduce((acc, v, i) => (Math.abs(v - e) < Math.abs(SQUISH_E[acc] - e) ? i : acc), 0);
}

function applyFrame() {
	const img = document.getElementById("petImg");
	const fw = img._frameW || st.size;
	img.style.backgroundPosition = -st.frameIdx * fw + "px 0px";
}

// ───────────────────────────── 看板
let panelBuilt = false;
function layoutPanel() {
	const p = document.getElementById("panel");
	p.style.left = PAD + "px";
	p.style.top = PAD + "px";
	p.style.width = PANEL_W + "px";
	p.style.height = PANEL_H + "px";
	if (!panelBuilt) buildPanel();
}

function mkEl(parent, style, text) {
	const d = document.createElement("div");
	d.className = "abs";
	Object.assign(d.style, style);
	if (text != null) d.textContent = text;
	parent.appendChild(d);
	return d;
}

const P = {}; // 需要反复改文字的元素

function buildPanel() {
	const p = document.getElementById("panel");
	// 面板相对坐标 = Tk 绝对坐标 - PAD(9)：left 16 / right 328 / mid 172
	const left = 16, right = PANEL_W - 16, mid = (left + right) / 2;
	const LABEL = st.soft ? FAMILY_SOFT : FAMILY_PLAIN, PLAIN = "inherit";

	// ① 状态行：左组右对齐、右组左对齐，各自贴中轴
	P.phase = mkEl(p, { right: PANEL_W - (mid - 11) + "px", top: "19px", transform: "translateY(-50%)", color: C.DIM, fontSize: FONT.label + "px", fontFamily: PLAIN }, "—");
	P.clock = mkEl(p, { left: mid + 11 + "px", top: "19px", transform: "translateY(-50%)", color: C.DIM, fontSize: FONT.label + "px", fontFamily: PLAIN }, "");
	P.phase.style.textAlign = "right";

	// ② 大金额
	P.money = mkEl(p, { left: mid + "px", top: "45px", transform: "translate(-50%,-50%)", color: C.MONEY, fontSize: FONT.big + "px", fontWeight: "700", fontFamily: LABEL }, "¥0.00");

	// ③ 副标题
	P.sub = mkEl(p, { left: mid + "px", top: "71px", transform: "translate(-50%,-50%)", color: C.DIM, fontSize: FONT.label + "px" }, "今日已赚 · 每秒 ¥0.0000");

	// ④ 进度条
	const bar = document.createElement("div");
	bar.className = "abs";
	Object.assign(bar.style, { left: left + "px", top: "88px", width: right - left + "px", height: "7px", background: C.BAR_BG, borderRadius: "3px" });
	p.appendChild(bar);
	const fill = document.createElement("div");
	Object.assign(fill.style, { position: "absolute", left: "0", top: "0", height: "100%", width: "1px", background: C.ACCENT, borderRadius: "3px" });
	bar.appendChild(fill);
	P.barFill = fill;
	P.pct = mkEl(p, { right: PANEL_W - right + "px", top: "78px", transform: "translateY(-50%)", color: C.ACCENT, fontSize: FONT.small + "px" }, "0%");

	// ⑤ 三行两列（四个列心）
	const half = (right - left) / 2;
	const labCx = [left + half * 0.3, left + half * 1.22];
	const valCx = [left + half * 0.72, left + half * 1.62];
	const grid = [
		[124, "时薪", "perhour", C.MONEY, "日薪", "daily", C.MONEY],
		[146, "已工作", "worked", C.GOLD, "距离下班", "remaining", C.GOLD],
		[168, "上班", "startat", C.GOLD, "下班", "endat", C.GOLD],
		// 加班时段与窝囊费：加班关掉时显示「关闭」/「—」
		[190, "加班", "otspan", C.ACCENT, "窝囊费", "otrate", C.ACCENT],
	];
	for (const [yy, la, ka, ca, lb, kb, cb] of grid) {
		mkEl(p, { left: labCx[0] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: C.DIM, fontSize: FONT.label + "px" }, la);
		P[ka] = mkEl(p, { left: valCx[0] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: ca, fontSize: FONT.small + "px" }, "—");
		const labB = mkEl(p, { left: labCx[1] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: C.DIM, fontSize: FONT.label + "px" }, lb);
		P[kb] = mkEl(p, { left: valCx[1] + "px", top: yy + "px", transform: "translate(-50%,-50%)", color: cb, fontSize: FONT.small + "px" }, "—");
		// 第二列的标签在加班时会被换掉（距离下班 → 距离加班结束）
		if (kb === "remaining") P.remainingLabel = labB;
	}

	// ⑥ 分隔线
	const line = document.createElement("div");
	line.className = "abs";
	Object.assign(line.style, { left: left + "px", top: "209px", width: right - left + "px", height: "1px", background: C.STROKE });
	p.appendChild(line);

	// ⑦ 两行通栏（整组居中）
	for (const [yy, label, key, color] of [[230, "本月剩余工作日", "remdays", C.GOLD], [254, "本月还可赚", "monthleft", C.MONEY]]) {
		const row = document.createElement("div");
		row.className = "abs";
		Object.assign(row.style, {
			left: mid + "px", top: yy + "px", transform: "translate(-50%,-50%)",
			display: "flex", alignItems: "center", gap: "10px", whiteSpace: "nowrap",
		});
		const lab = document.createElement("span");
		lab.textContent = label;
		Object.assign(lab.style, { color: C.DIM, fontSize: FONT.label + "px" });
		const val = document.createElement("span");
		val.textContent = "—";
		Object.assign(val.style, { color, fontSize: FONT.small + "px" });
		row.append(lab, val);
		// 「本月还可赚」要做成「基本工资（绿）+ 加班工资（蓝）」两段，
		// 再挂一个不占位的第二个 span，颜色单独设
		if (key === "monthleft") {
			const ot = document.createElement("span");
			ot.textContent = "";
			Object.assign(ot.style, { color: C.ACCENT, fontSize: FONT.small + "px", marginLeft: "-4px" });
			row.appendChild(ot);
			P.monthleftOt = ot;
		}
		p.appendChild(row);
		P[key] = val;
	}

	panelBuilt = true;
}

function refreshPanel(snap) {
	const target = snap.earned;
	if (st.cfg.roll_numbers !== false) {
		if (Math.abs(target - st.display) < 0.02) st.display = target;
		else st.display += (target - st.display) * 0.32;
	} else st.display = target;

	const v = Math.round(st.display * 100) / 100;
	const moneyTxt = "¥" + money(v);
	if (P.money.textContent !== moneyTxt) P.money.textContent = moneyTxt;

	const phaseTxt = { working: "搬砖中", lunch: "午休中", before: "还没上班", after: "已收工", rest: "今天休息", idle: "休息中", overtime: "加班中" }[snap.phase] || "—";
	const wd = WD_NAMES[(snap.now.getDay() + 6) % 7];
	P.phase.textContent = phaseTxt + " · " + wd;
	const clk = String(snap.now.getMonth() + 1).padStart(2, "0") + "-" + String(snap.now.getDate()).padStart(2, "0") + " " + String(snap.now.getHours()).padStart(2, "0") + ":" + String(snap.now.getMinutes()).padStart(2, "0");
	if (P.clock.textContent !== clk) P.clock.textContent = clk;

	const D = snap.D;
	// 每秒速度：上班日非加班时段按基本时薪；加班时段按倍率。
	// 休息日没有基本工资，只有加班时段在进账，其余时段速度就是 0
	//（否则「已收工」还写着每秒 ¥0.0360，和不动的大金额自相矛盾）。
	const secRate = snap.phase === "overtime"
		? D.perSec * snap.otRate
		: snap.workday
			? D.perSec
			: 0;
	const sub = snap.phase === "overtime"
		? "加班 ×" + snap.otRate + " · 每秒 ¥" + secRate.toFixed(4)
		: "今日已赚 · 每秒 ¥" + (secRate || 0).toFixed(4);
	if (P.sub.textContent !== sub) P.sub.textContent = sub;

	const pct = Math.round(snap.progress * 100);
	if (P.pct.textContent !== pct + "%") P.pct.textContent = pct + "%";
	const wpx = snap.progress > 0 ? Math.max(3, (PANEL_W - 32) * snap.progress) : 1;
	P.barFill.style.width = wpx + "px";

	P.perhour.textContent = "¥" + money(D.perHour);
	// 日薪保持常规排版（不拆两段）：只有「日薪」这一格文字长度正常，
	// 拆成 505.75+350.13 会顶到左边标签上，用户明确要求保持原样。
	// 日薪一栏：开了加班就把今天的加班工资加进去，显示「今天这一天总共能拿多少」
	P.daily.textContent = "¥" + money(snap.dailyTotal);
	P.worked.textContent = durText(snap.worked);
	// 加班中 → 「距离加班结束」；下班到加班开始之间 → 「距离加班」；
	// 其余时段保持「距离下班」
	if (snap.phase === "overtime") {
		if (P.remainingLabel && P.remainingLabel.textContent !== "距离加班结束") P.remainingLabel.textContent = "距离加班结束";
		P.remaining.textContent = durText(snap.otRemaining);
	} else if (snap.phase === "idle") {
		if (P.remainingLabel && P.remainingLabel.textContent !== "距离加班") P.remainingLabel.textContent = "距离加班";
		const cur = snap.now.getHours() * 60 + snap.now.getMinutes() + snap.now.getSeconds() / 60;
		P.remaining.textContent = durText(Math.max(0, (snap.otStartMin - cur) * 60));
	} else {
		if (P.remainingLabel && P.remainingLabel.textContent !== "距离下班") P.remainingLabel.textContent = "距离下班";
		// 休息日没有「下班」这回事：加班日干完显示「—」，非加班日也显示「—」，
		// 否则会一直挂着「距离下班 6:30:00」和一个不动的金额自相矛盾。
		P.remaining.textContent = snap.workday ? durText(snap.remaining) : "—";
	}
	// 「上班 / 下班」显示今天真正生效的那一对时段：
	// 上班日 → 上下班时间；加班日 → 加班时段（工作日那对或非上班日那对）；
	// 非上班日又不加班 → 今天没有时段可言，显示「—」，
	// 否则会出现「今天休息」却还写着 09:00 / 17:00 的矛盾显示。
	const dow = snap.now.getDay() === 0 ? 7 : snap.now.getDay();
	const spanOtToday = D.otOn && D.otDays.includes(dow) && snap.otEndMin > snap.otStartMin;
	if (snap.workday) {
		P.startat.textContent = fmtHHMM(D.startMin);
		P.endat.textContent = fmtHHMM(D.endMin);
	} else if (spanOtToday) {
		P.startat.textContent = fmtHHMM(snap.otStartMin);
		P.endat.textContent = fmtHHMM(snap.otEndMin);
	} else {
		P.startat.textContent = "—";
		P.endat.textContent = "—";
	}
	// 加班时段 + 窝囊费：窝囊费就是今天的加班工资（加班多受的那份气换来的钱）。
	// 不加班就是 0。和上面的「日薪」（基础日薪 + 加班工资）一对看，
	// 日薪 − 窝囊费 = 不含加班的基础日薪。
	// 时段显示：只要加班开着且窗口有效就显示时间（倍率 0 也显示，否则"加班中"却"关闭"矛盾）
	const otWinOn = D.otOn && snap.otEndMin > snap.otStartMin;
	const a1 = otWinOn ? fmtHHMM(snap.otStartMin) : "—";
	const a2 = otWinOn ? fmtHHMM(snap.otEndMin) : "—";
	const spanTxt = otWinOn ? a1 + "→" + a2 : "关闭";
	if (P.otspan.textContent !== spanTxt) P.otspan.textContent = spanTxt;
	const pouchTxt = "¥" + money(snap.otDaily);
	if (P.otrate.textContent !== pouchTxt) P.otrate.textContent = pouchTxt;
	P.remdays.textContent = snap.remDays + " 天";
	// 「本月还可赚」= 基本工资（绿）+ 加班工资（蓝）。
	// 加班工资是把本月剩余每一天按当前设置单独算一遍再加总
	//（工作日/周末/节假日倍率不同，加班日也不一定等于上班日）。
	// 加班关掉或本月剩余没有加班时，蓝色段不显示，只留绿色基本工资。
	P.monthleft.textContent = "¥" + money(snap.monthBase);
	if (P.monthleftOt) {
		// 彩蛋：开了加班却三档倍率全 0，加班一分钱不给 → 蓝色段显示「+ 0 (太窝囊了)」
		const otTxt = snap.otAllZero
			? "+ 0 (太窝囊了)"
			: snap.monthOt > 0.005
				? "+¥" + money(snap.monthOt)
				: "";
		if (P.monthleftOt.textContent !== otTxt) P.monthleftOt.textContent = otTxt;
		// 彩蛋状态用更暗的蓝灰，像是在自嘲，而不是正常的收入高亮
		const otColor = snap.otAllZero ? "#6b7488" : C.ACCENT;
		if (P.monthleftOt.style.color !== otColor) P.monthleftOt.style.color = otColor;
	}
}

function refreshChip(snap) {
	const chip = document.getElementById("chip");
	// 设置里勾上「胶囊」后要立刻出现在头顶（否则要展开再收起一次才显示）
	if (chip.style.display !== "flex") chip.style.display = "flex";
	const txt = "¥" + money(snap.earned) + " · " + Math.round(snap.progress * 100) + "%";
	chip.textContent = txt;
	const a = st.size;
	const pad = 9;
	const hh = CHIP_H;
	const x1 = st.pet.cx - a / 2 - pad;
	const x2 = st.pet.cx + a / 2 + pad;
	const cy2 = st.pet.box[1] - 7;
	chip.style.left = x1 + "px";
	chip.style.width = x2 - x1 + "px";
	chip.style.top = cy2 - hh + "px";
	chip.style.height = hh + "px";
	chip.style.fontSize = FONT.chip + "px";
}

// ───────────────────────────── 挤压动画
function bezier(t) {
	// cubic-bezier(.34,1.56,.64,1) 的 y(t)：用牛顿法反解 x
	const x1 = 0.34, y1 = 1.56, x2 = 0.64, y2 = 1.0;
	const cx = (u) => 3 * (1 - u) * (1 - u) * u * x1 + 3 * (1 - u) * u * u * x2 + u * u * u;
	const cy = (u) => 3 * (1 - u) * (1 - u) * u * y1 + 3 * (1 - u) * u * u * y2 + u * u * u;
	let lo = 0, hi = 1;
	for (let i = 0; i < 24; i++) {
		const mid = (lo + hi) / 2;
		if (cx(mid) < t) lo = mid; else hi = mid;
	}
	return cy((lo + hi) / 2);
}

function squishTo(to) {
	st.squish = { from: st.squishE, to, t0: performance.now() };
}

function tickSquish(now) {
	if (!st.squish) return;
	const p = Math.min(1, (now - st.squish.t0) / SQUISH_DUR);
	const e = st.squish.from + (st.squish.to - st.squish.from) * bezier(p);
	st.squishE = e;
	// e → 帧号（带迟滞，避免相邻两档抖动）
	const best = SQUISH_E.reduce((acc, v, i) => (Math.abs(v - e) < Math.abs(SQUISH_E[acc] - e) ? i : acc), 0);
	if (best !== st.frameIdx) {
		const dNew = Math.abs(SQUISH_E[best] - e);
		const dCur = Math.abs(SQUISH_E[st.frameIdx] - e);
		if (best === 0 || st.frameIdx === 0 || dNew + 0.018 < dCur) {
			st.frameIdx = best;
			applyFrame();
		}
	}
	// 帧本身已经画了形变，这里只做兜底微调（保证边缘手感）
	const wrap = document.getElementById("petWrap");
	wrap.style.transform = (st.left ? "scaleX(-1) " : "") + "none";
	if (p >= 1) {
		const target = st.squish.to;
		st.squish = null;
		st.squishE = target;
		st.frameIdx = frameFor(st.squishE);
		applyFrame();
	}
}

// ───────────────────────────── 飘字
function rand(span) {
	st.floatSeed = (st.floatSeed * 1103515245 + 12345) & 0x7fffffff;
	return st.floatSeed % Math.max(1, span);
}

function spawnFloat(D, snap) {
	// 加班时段按倍率折算（0 倍率 = 0 元），其他时段就是正常每秒收入
	const rate = snap && snap.phase === "overtime" ? snap.otRate : 1;
	const step = D.perSec * rate * floatSec();
	if (step <= 0) return;
	const box = st.pet.box;
	if (!box) return;
	const span = Math.max(1, Math.floor((box[2] - box[0]) / 3));
	const x = (box[0] + box[2]) / 2 - span / 2 + rand(span);
	const y0 = box[1] + 6;
	const el = document.createElement("div");
	el.className = "float";
	el.style.left = x + "px";
	el.style.top = y0 + "px";
	el.style.fontSize = FONT.float + "px";
	el.style.fontFamily = st.soft ? FAMILY_SOFT : FAMILY_PLAIN;
	el.textContent = "+¥" + step.toFixed(4);
	document.getElementById("stage").appendChild(el);
	st.floats.push({ el, x, y: y0, ms: 0 });
}

function tickFloats(dt) {
	const alive = [];
	for (const f of st.floats) {
		f.ms += dt;
		if (f.ms > FLOAT_LIFE) {
			f.el.remove();
			continue;
		}
		const p = f.ms / FLOAT_LIFE;
		const rise = (1 - Math.pow(1 - p, 2)) * FLOAT_RISE;
		f.el.style.transform = "translate(-50%, " + -rise + "px)";
		if (p > 0.62) {
			const shade = Math.max(0, 1 - (p - 0.62) / 0.38);
			f.el.style.color = blend(C.CARD, C.MONEY, shade);
		}
		alive.push(f);
	}
	st.floats = alive;
}

// ───────────────────────────── 吐槽气泡
async function loadBanter() {
	try {
		const r = await S.req("GET", "/banter");
		if (r && Array.isArray(r.normal) && r.normal.length) st.banter.normal = r.normal;
		if (r && Array.isArray(r.before)) st.banter.before = r.before;
	} catch (e) {
		/* 宿主没有 /banter（旧版/独立版兜底）→ 用内置默认 */
	}
	if (!st.banter.normal.length) st.banter.normal = DEFAULT_BANTER.normal.slice();
}

/** 距离「下班」或「加班结束」还有 60 分钟内 → 用「下班前」那组。 */
function banterBeforeOffWork(D, now) {
	const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
	const workday = isWorkday(D, now);
	const dow = now.getDay() === 0 ? 7 : now.getDay();
	const otDay = D.otDays.includes(dow);
	if (workday && cur >= D.endMin - 60 && cur < D.endMin) return true;
	if (D.otOn && otDay) {
		const s = workday ? D.otStartWorkdayMin : D.otStartWeekendMin;
		const e = workday ? D.otEndWorkdayMin : D.otEndWeekendMin;
		if (e > s && cur >= e - 60 && cur < e) return true;
	}
	return false;
}

function pickBanterLine() {
	const now = new Date();
	let pool = st.banter.normal.length ? st.banter.normal : DEFAULT_BANTER.normal;
	if (banterBeforeOffWork(D, now) && st.banter.before.length) pool = st.banter.before;
	if (!pool.length) return "……";
	return pool[Math.floor(Math.random() * pool.length)];
}

function spawnBanter() {
	const box = st.pet.box;
	if (!box) return;
	const cx = (box[0] + box[2]) / 2;
	// 从宠物「头部侧面」冒出来（说话泡泡），不是头顶正上方：头部约在宠物顶部 20% 处
	const headY = box[1] + box[3] - box[1] > 0 ? box[1] + (box[3] - box[1]) * 0.2 : box[1];
	const el = document.createElement("div");
	el.className = "banter";
	el.textContent = pickBanterLine();
	// 气泡固定用 108 档的尺寸（不再随星星人大小缩放）：
	// 108 档下气泡单行完整显示在窗口内不被裁切。
	const scale = 108 / 135;
	el.style.setProperty("--bt-scale", String(scale));
	el.style.fontSize = Math.round(BANTER_FONT * scale) + "px";
	el.style.fontFamily = st.soft ? FAMILY_SOFT : FAMILY_PLAIN;
	el.style.maxWidth = "none";           // 单行不换行，宽度由文字长度决定
	document.getElementById("stage").appendChild(el);
	const bw = el.offsetWidth;
	const bh = el.offsetHeight;
	// 锚点侧固定：贴宠物那一侧永不脱锚，字越多向远离宠物方向延伸越长。
	// 宠物在窗口右半边 → 气泡在它左边，右端贴宠物左边缘向左延伸（锚点=最后一个字）；
	// 宠物在左半边 → 气泡在它右边，左端贴宠物右边缘向右延伸（锚点=第一个字）。
	const gap = Math.round(6 * scale);
	const petOnRight = (box[0] + box[2]) / 2 > st.winW / 2;
	let x = petOnRight ? box[0] - gap - bw : box[2] + gap;
	let y = headY - bh / 2;
	// 不做任何 clamp：锚点侧由上面公式固定，远离侧随文字自然延伸（短句短、长句长）。
	y = Math.max(2, Math.min(y, st.winH - bh - 2));
	el.style.left = x + "px";
	el.style.top = y + "px";
	st.banters.push({ el, x, y, ms: 0 });
}

function tickBanters(dt) {
	const alive = [];
	for (const b of st.banters) {
		b.ms += dt;
		if (b.ms > BANTER_LIFE) {
			b.el.remove();
			continue;
		}
		const p = b.ms / BANTER_LIFE;
		// 气泡不动，只做逐渐消失
		if (p > 0.7) b.el.style.opacity = String(Math.max(0, 1 - (p - 0.7) / 0.3));
		alive.push(b);
	}
	st.banters = alive;
}

// ───────────────────────────── 悬停提示
function moveTip(e) {
	const tip = document.getElementById("tip");
	if (!st.pointerInside) {
		tip.style.display = "none";
		return;
	}
	const text = "困困星人";
	tip.textContent = text;
	tip.style.display = "flex";
	tip.style.fontSize = FONT.small + "px";
	tip.style.height = "26px";
	tip.style.padding = "0 11px";
	tip.style.fontFamily = st.soft ? FAMILY_SOFT : FAMILY_PLAIN;
	const pw = tip.offsetWidth;
	const ph = 26;
	let x = e.clientX + 14;
	let y = e.clientY - ph - 12;
	x = Math.max(4, Math.min(x, st.winW - pw - 4));
	y = Math.max(4, Math.min(y, st.winH - ph - 4));
	tip.style.left = x + "px";
	tip.style.top = y + "px";
}

function inPet(x, y) {
	const box = st.pet.box;
	return !!box && x >= box[0] && x <= box[2] && y >= box[1] && y <= box[3];
}

function hitTest(x, y) {
	if (inPet(x, y)) return true;
	if (st.expanded) {
		return x >= PAD && x <= PAD + PANEL_W && y >= PAD && y <= PAD + PANEL_H;
	}
	if (st.cfg.show_chip) {
		const chip = document.getElementById("chip");
		if (chip.style.display !== "none") {
			const r = chip.getBoundingClientRect();
			if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) return true;
		}
	}
	return false;
}

// ───────────────────────────── 声音
let clickAudio = null;
function playClick() {
	if (st.cfg.sound === false) return;
	try {
		if (!clickAudio) {
			clickAudio = new Audio("../../assets/click.wav");
			clickAudio.volume = 0.35;
		}
		clickAudio.currentTime = 0;
		clickAudio.play().catch(() => {});
	} catch (e) {
		/* ignore */
	}
}

// ───────────────────────────── 展开 / 收起
function setExpanded(on) {
	on = !!on;
	if (on === st.expanded) return;
	st.expanded = on;
	const panel = document.getElementById("panel");
	const chip = document.getElementById("chip");
	panel.style.display = on ? "block" : "none";
	chip.style.display = !on && st.cfg.show_chip ? "flex" : "none";
	if (!on) document.getElementById("tip").style.display = "none";
}

// ───────────────────────────── 主循环
let lastTick = performance.now();
let lastRefresh = 0;
let failCount = 0;

function tick(now) {
	const dt = Math.min(64, now - lastTick);
	lastTick = now;
	tickSquish(now);
	tickFloats(dt);
	tickBanters(dt);
	requestAnimationFrame(tick);
}

let D = null;
function refresh() {
	const now = new Date();
	if (!D) return;
	const snap = snapshot(D, now);
	snap.D = D;

	// 休息日隐藏 → 整窗穿透；但加班中要露出来（周末加班也是上班）
	const restHidden = !snap.workday && st.cfg.hide_on_rest_day === true && snap.phase !== "overtime";
	document.getElementById("stage").style.opacity = restHidden ? "0" : "1";
	// 休息日隐藏 → 整窗穿透；否则只在指针不在宠物/面板上时穿透
	S.ignore(restHidden || !st.pointerInside);

	if (st.expanded) refreshPanel(snap);
	else if (st.cfg.show_chip) refreshChip(snap);
	else document.getElementById("chip").style.display = "none";

	// 飘字节奏：搬砖中或加班中才冒；间隔取配置（1–10 秒，250ms 一轮），金额 = 这 N 秒赚到的钱
	if (st.cfg.show_float !== false && (snap.phase === "working" || snap.phase === "overtime")) {
		st.floatAcc += 1;
		if (st.floatAcc >= floatSec() * 4) {
			st.floatAcc = 0;
			spawnFloat(D, snap);
		}
	} else {
		st.floatAcc = 0;
	}

	// 吐槽：默认只在「上班/加班」时冒（banter_mode === "workday"）；「全天」则只要可见就冒。
	// 「下班前」那组由 banterBeforeOffWork 按时间自动切换。
	const banterMode = st.cfg.banter_mode || "workday";
	const banterAllowed = st.cfg.show_banter !== false && !restHidden &&
		(banterMode === "allday" || snap.phase === "working" || snap.phase === "overtime");
	if (banterAllowed) {
		st.banterAcc += 1;
		if (st.banterAcc >= banterEverySec() * 4) {
			st.banterAcc = 0;
			spawnBanter();
		}
	} else {
		st.banterAcc = 0;
	}
}

let hitTestPointer = false;

// ───────────────────────────── 指针与交互
function bindPointer() {
	const stage = document.getElementById("stage");

	// 用捕获阶段拿 mousemove：即使整窗处于「穿透」状态，forward:true 也会送进来
	window.addEventListener("mousemove", (e) => {
		if (st.dragging) {
			if (Math.abs(e.screenX - st.dragging.sx) > 3 || Math.abs(e.screenY - st.dragging.sy) > 3) st.dragging.moved = true;
			return;
		}
		const over = hitTest(e.clientX, e.clientY);
		if (over !== st.pointerInside) {
			st.pointerInside = over;
			S.ignore(!over);
			if (over && inPet(e.clientX, e.clientY)) moveTip(e);
			else document.getElementById("tip").style.display = "none";
		} else if (over && inPet(e.clientX, e.clientY)) {
			moveTip(e);
		}
		hitTestPointer = over;
	});

	window.addEventListener("mouseleave", () => {
		if (st.dragging) return;
		st.pointerInside = false;
		hitTestPointer = false;
		document.getElementById("tip").style.display = "none";
		S.ignore(true);
	});

	// 拖拽：pointer 事件 + 指针捕获，位移直接在 move 里发给主进程（对齐 dsh-pet 的做法）。
	window.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		if (!hitTest(e.clientX, e.clientY)) return;
		if (!inPet(e.clientX, e.clientY)) return;
		st.dragging = { sx: e.screenX, sy: e.screenY, moved: false, id: e.pointerId };
		playClick();
		squishTo(1);
		// 拖拽期间必须保持「可交互」，否则穿透会吞掉后续 pointermove/pointerup
		S.ignore(false);
		try {
			stage.setPointerCapture(e.pointerId);
		} catch (err) {
			/* 某些环境下不支持捕获，退回普通事件流 */
		}
		S.dragStart();
	});

	window.addEventListener("pointermove", (e) => {
		if (!st.dragging) return;
		const dx = e.screenX - st.dragging.sx;
		const dy = e.screenY - st.dragging.sy;
		if (!st.dragging.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) st.dragging.moved = true;
		if (st.dragging.moved) S.dragMove(dx, dy);
	});

	function finishDrag(e) {
		if (!st.dragging) return;
		if (e && e.pointerId !== undefined && st.dragging.id !== e.pointerId) return;
		const wasDrag = st.dragging.moved;
		const id = st.dragging.id;
		st.dragging = null;
		squishTo(0);
		try {
			stage.releasePointerCapture(id);
		} catch (err) {
			/* ignore */
		}
		S.dragEnd();
		if (!wasDrag) setExpanded(!st.expanded);
	}

	window.addEventListener("pointerup", finishDrag);
	window.addEventListener("pointercancel", finishDrag);

	window.addEventListener("contextmenu", (e) => {
		e.preventDefault();
		if (!inPet(e.clientX, e.clientY) && !(st.expanded && e.clientY > PAD && e.clientY < PAD + PANEL_H)) return;
		S.ignore(false);
		S.menu({ kind: "menu" });
	});
}

// 菜单窗口里选中后回调：主窗只负责应用结果
window.addEventListener("DOMContentLoaded", () => {
	bindPointer();
	requestAnimationFrame(tick);
});

// ───────────────────────────── 启动
S.boot(async (payload) => {
	let res = null;
	try {
		res = await S.req("GET", "/config");
	} catch (e) {
		/* 宿主未就绪 */
	}
	const cfg = (res && res.config) || payload.cfg || {};
	st.cfg = cfg;
	st.soft = cfg.soft_font !== false;
	st.left = payload.left === true && cfg.flip_on_left !== false;
	const idx = Number.isInteger(cfg.pet_size_index) ? cfg.pet_size_index : 1;
	st.size = PET_SIZES[Math.max(0, Math.min(PET_SIZES.length - 1, idx))];
	D = computeState(cfg);
	layout();
	applyFont();
	S.resize(st.size);
	document.getElementById("chip").style.display = cfg.show_chip ? "flex" : "none";
	setExpanded(false);
	loadBanter();
	setInterval(loadBanter, 30000); // 每 30 秒重读 banter.txt，改文件无需重启
	refresh();
	refresh();

	// 250ms 数据刷新；同时兼作宿主存活探测
	setInterval(async () => {
		try {
			const r = await S.req("GET", "/config");
			failCount = 0;
			if (r && r.config) {
				st.cfg = r.config;
				const newIdx = Number.isInteger(r.config.pet_size_index) ? r.config.pet_size_index : 1;
				const newSize = PET_SIZES[Math.max(0, Math.min(PET_SIZES.length - 1, newIdx))];
				if (newSize !== st.size) {
					st.size = newSize;
					layout();
					S.resize(st.size);
				}
				const soft = r.config.soft_font !== false;
				if (soft !== st.soft) {
					st.soft = soft;
					applyFont();
				}
				D = computeState(r.config);
			}
		} catch (e) {
			failCount += 1;
			if (failCount >= 8) {
				// 宿主连续 2 秒不可达 → 自己退出，避免留下孤儿窗口
				S.quit();
			}
		}
		refresh();
	}, 250);

	S.onFlip(({ left }) => {
		// Tk _draw()：left = _flip_now() or _on_left_half()
		const next = !!left && st.cfg.flip_on_left !== false;
		if (next === st.left) return;
		st.left = next;
		layout();
	});
	S.onDragged(() => {
		/* 位置已经由主进程落盘 */
	});
});

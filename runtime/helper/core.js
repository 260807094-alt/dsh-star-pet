/*
 * 困困星人 · 共享核心（core）
 * ------------------------------------------------------------------
 * 这是插件的**唯一**数据源。默认配置、时间解析、配置校验、计薪快照
 * 全部只在这里实现一次，其它文件一律从这里取。
 *
 * 为什么是一个 UMD 小文件而不是 ESM 模块：
 *   - lib/index.js 是 ESM（package.json "type": "module"），可以 import 它；
 *   - runtime/helper/* 是 CommonJS（runtime/helper/package.json 写死 commonjs），
 *     main.js 要 require 它；
 *   - renderer.js / settings.js / menu.js 是**没有打包器**的普通 <script>，
 *     只能从全局拿。
 *   UMD 是同时满足三者的最小代价。改这里的任何一个常量，三端自动同步。
 * ------------------------------------------------------------------
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === "object" && module.exports) module.exports = api;
	else root.StarPetCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
	"use strict";

	const DAY_MIN = 1440;

	/* ------------------------------------------------------------------
	 * 默认配置 —— 全插件唯一的定义处
	 * ------------------------------------------------------------------ */
	const DEFAULT_CONFIG = {
		// 薪资
		monthly_wage: 10000,
		pay_days_per_month: 21.75,
		// 作息（四个时间点，步长 15 分钟）
		work_start: "09:00",
		work_end: "17:00",
		lunch_start: "11:30",
		lunch_minutes: 90,
		// 上班日：可以为空 = 这周一天班都不上
		work_weekdays: [1, 2, 3, 4, 5],
		// 外观
		pet_size_index: 1,
		snap_enabled: true,
		snap_px: 28,
		flip_on_left: true,
		sound: true,
		soft_font: true,
		show_chip: false,
		// 吐槽
		show_banter: true,
		banter_every_sec: 30,
		banter_mode: "workday",
		// 飘字
		show_float: true,
		float_every_sec: 5,
		// 加班：独立时段，不接下班时间；加班日可以为空
		overtime_enabled: false,
		overtime_weekdays: [1, 2, 3, 4, 5],
		overtime_start_workday: "19:00",
		overtime_end_workday: "21:00",
		overtime_start_weekend: "09:00",
		overtime_end_weekend: "17:00",
		overtime_rate_workday: "1.5",
		overtime_rate_weekend: "2",
	};

	/** 加班倍率的合法取值（字符串，与设置页按钮一一对应）。
	 *  只有四档：0 = 白干，1 = 一份时薪，1.5 = 一份半，2 = 两份。
	 *  「3 倍」与「节假日档」一起砍掉了（需求⑥）。 */
	const OVERTIME_RATES = ["0", "1", "1.5", "2"];
	/** 两档倍率字段，顺序即设置页显示顺序。 */
	const OVERTIME_RATE_KEYS = ["overtime_rate_workday", "overtime_rate_weekend"];

	/** 可写键白名单：前端只能改这些，防止塞进任意字段。 */
	const CONFIG_KEYS = Object.keys(DEFAULT_CONFIG);

	/* ------------------------------------------------------------------
	 * 宠物尺寸表 —— 原来 main.js / renderer.js / settings.js / menu.js
	 * 各写了一份，改一档要同时改四处，现在只在 core 里定义。
	 *   size  : 屏幕上显示的 CSS 像素边长（pet_size_index 直接索引）
	 *   frameW: 雪碧图单帧宽度
	 *   frameH: 雪碧图单帧高度（比 frameW 高一点，留出下压时的余量）
	 * ------------------------------------------------------------------ */
	const PET_SIZES = [96, 108, 135];
	// 29 帧横排的雪碧图。实测像素（assets/skins/*.webp）：
	//   pet-135  4205×135  = 145×29 宽、135 高
	//   pet-216  6699×216  = 231×29 宽、216 高
	//   pet-324 10005×324  = 345×29 宽、324 高
	// 帧高恒等于 size（宠物是正方形），帧宽多一点点，是挤压帧留的余量。
	const PET_SHEETS = [
		{ size: PET_SIZES[0], frameW: 145, frameH: 135 },
		{ size: PET_SIZES[1], frameW: 231, frameH: 216 },
		{ size: PET_SIZES[2], frameW: 345, frameH: 324 },
	];
	const PET_SIZE_INDEX = 1; // 默认档 = PET_SIZES[1] = 108px（与 DEFAULT_CONFIG.pet_size_index 一致）

	/** pet_size_index → 实际像素边长（越界一律回退默认档）。 */
	function petSizeOf(index) {
		const i = clamp(Math.round(num(index, PET_SIZE_INDEX)), 0, PET_SIZES.length - 1);
		return PET_SIZES[i];
	}
	/** pet_size_index → 雪碧图档位（含单帧尺寸）。 */
	function sheetOf(index) {
		const i = clamp(Math.round(num(index, PET_SIZE_INDEX)), 0, PET_SHEETS.length - 1);
		return PET_SHEETS[i];
	}
	/** 雪碧图文件名：档位 0/1/2 → pet-135.webp / pet-216.webp / pet-324.webp。
	 *  文件名里的数字是**单帧高度**（= 显示边长基准），不是帧宽。 */
	function skinFile(index, hires) {
		const i = clamp(Math.round(num(index, PET_SIZE_INDEX)), 0, PET_SHEETS.length - 1);
		return "pet-" + PET_SHEETS[i].frameH + (hires ? "@2x" : "") + ".webp";
	}

	/* ------------------------------------------------------------------
	 * 基础工具
	 * ------------------------------------------------------------------ */
	const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
	const num = (v, dflt) => {
		const n = Number(v);
		return Number.isFinite(n) ? n : dflt;
	};

	/** "HH:MM" → 0..1439；格式非法一律回退 dflt（不做任何猜测性夹取）。 */
	function parseHHMM(s, dflt) {
		const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s == null ? "" : s).trim());
		return m ? Number(m[1]) * 60 + Number(m[2]) : dflt;
	}
	/** 0..1439 → "HH:MM"（按 24 小时环绕）。 */
	function fmtHHMM(min) {
		const v = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
		return String(Math.floor(v / 60)).padStart(2, "0") + ":" + String(v % 60).padStart(2, "0");
	}
	/** 金额格式化：≥10 万取整，否则两位小数。 */
	function money(v) {
		const n = Number(v) || 0;
		if (Math.abs(n) >= 100000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
		return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
	}
	/** 秒 → "H:MM:SS"。 */
	function durText(sec) {
		let s = Math.max(0, Math.floor(sec));
		const h = Math.floor(s / 3600);
		s -= h * 3600;
		const m = Math.floor(s / 60);
		s -= m * 60;
		return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
	}
	/** 周几：JS 的 0=周日 → 我们的 7；其余不变。 */
	const dowOf = (d) => (d.getDay() === 0 ? 7 : d.getDay());

	/* ------------------------------------------------------------------
	 * 配置净化（服务端最后一道防线）
	 * ------------------------------------------------------------------ */
	function sanitizePatch(patch) {
		const out = {};
		if (!patch || typeof patch !== "object") return out;
		for (const key of CONFIG_KEYS) {
			if (Object.prototype.hasOwnProperty.call(patch, key)) out[key] = patch[key];
		}

		if (out.monthly_wage != null) out.monthly_wage = Math.max(0, num(out.monthly_wage, 0));
		if (out.pay_days_per_month != null) {
			const n = num(out.pay_days_per_month, NaN);
			// 分母不能是 0 或负数；1~30 之外一律回退默认。
			out.pay_days_per_month = Number.isFinite(n) ? clamp(n, 1, 30) : DEFAULT_CONFIG.pay_days_per_month;
		}
		if (out.lunch_minutes != null) out.lunch_minutes = clamp(Math.round(num(out.lunch_minutes, 0)), 0, 300);
		if (out.pet_size_index != null) out.pet_size_index = clamp(Math.round(num(out.pet_size_index, 1)), 0, 2);
		if (out.snap_px != null) out.snap_px = clamp(Math.round(num(out.snap_px, 0)), 0, 200);
		if (out.banter_every_sec != null) out.banter_every_sec = clamp(Math.round(num(out.banter_every_sec, 30)), 5, 120);
		if (out.float_every_sec != null) out.float_every_sec = clamp(Math.round(num(out.float_every_sec, 5)), 1, 10);
		if (out.banter_mode != null) out.banter_mode = out.banter_mode === "allday" ? "allday" : "workday";

		// 周几数组：过滤非法值 + 去重排序。**允许为空**（空 = 这周不上班）。
		const cleanDays = (v) =>
			Array.from(new Set((Array.isArray(v) ? v : []).map((d) => Math.round(Number(d)))))
				.filter((d) => d >= 1 && d <= 7)
				.sort((a, b) => a - b);
		if (out.work_weekdays != null) out.work_weekdays = cleanDays(out.work_weekdays);
		if (out.overtime_weekdays != null) out.overtime_weekdays = cleanDays(out.overtime_weekdays);

		for (const key of OVERTIME_RATE_KEYS) {
			if (out[key] == null) continue;
			const rate = String(out[key]);
			out[key] = OVERTIME_RATES.includes(rate) ? rate : DEFAULT_CONFIG[key];
		}
		for (const key of [
			"work_start",
			"work_end",
			"lunch_start",
			"overtime_start_workday",
			"overtime_end_workday",
			"overtime_start_weekend",
			"overtime_end_weekend",
		]) {
			if (out[key] == null) continue;
			const text = String(out[key]).trim();
			out[key] = /^([01]\d|2[0-3]):([0-5]\d)$/.test(text) ? text : DEFAULT_CONFIG[key];
		}
		return out;
	}

	/* ------------------------------------------------------------------
	 * 配置校验（设置页与宿主共用同一套规则与文案）
	 * ------------------------------------------------------------------ */
	function validateConfig(cfg) {
		const t = (k, d) => parseHHMM(cfg[k], d);
		const ws = t("work_start", 540);
		const we = t("work_end", 1020);
		const ls = t("lunch_start", 690);
		const lm = clamp(Math.round(num(cfg.lunch_minutes, 0)), 0, 300);
		const le = ls + lm;
		if (we <= ws) return "下班时间必须晚于上班时间。";
		// 需求②：四段是**开区间**，任何一段长度 0 都不算合法。
		// 只有真的要午休（lm > 0）时才要求它严格夹在上下班之间；
		// lm = 0 表示「不午休」，此时午休开始时间没有意义，不参与校验。
		if (lm > 0 && ls <= ws) return "午休开始必须晚于上班时间。";
		if (lm > 0 && le >= we) return "午休结束（午休开始 + 午休时长）必须早于下班时间。";
		const otWS = t("overtime_start_workday", 1140);
		const otWE = t("overtime_end_workday", 1260);
		if (otWE <= otWS) return "上班日加班结束必须晚于开始。";
		// 加班是独立时段，必须整体落在下班之后。不再额外限制 17:00 —— 下班时间
		// 用户可以设成 16:00，此时 16:30 开始加班是合法的。
		if (otWS < we) return "上班日加班开始必须晚于下班时间。";
		const otRS = t("overtime_start_weekend", 540);
		const otRE = t("overtime_end_weekend", 1020);
		if (otRE <= otRS) return "非上班日加班结束必须晚于开始。";
		// 周六、周日一天只能算「上班日」或「加班日」之一。两组都重叠会让同一天
		// 既发日薪又发加班费，而且会按「上班日的加班时段」算钱，把用户设的
		// 「非上班日时段」丢掉。周一到周五允许共存（白天上班、晚上加班）。
		const wd = Array.isArray(cfg.work_weekdays) ? cfg.work_weekdays.map(Number) : [];
		const od = Array.isArray(cfg.overtime_weekdays) ? cfg.overtime_weekdays.map(Number) : [];
		for (const day of [6, 7]) {
			if (wd.includes(day) && od.includes(day)) {
				return (day === 6 ? "周六" : "周日") + "不能同时选成上班日和加班日。";
			}
		}
		return null;
	}

	/* ------------------------------------------------------------------
	 * 派生模型：把配置编译成一份「算钱用的常量表」
	 * ------------------------------------------------------------------ */
	function deriveModel(cfg) {
		const c = cfg || {};
		// 月薪 0 是合法值（待业 / 只靠加班），只有「没填」才回退默认。
		const monthlyFilled = c.monthly_wage != null && String(c.monthly_wage).trim() !== "";
		const monthly = monthlyFilled ? Math.max(0, num(c.monthly_wage, 0)) : DEFAULT_CONFIG.monthly_wage;
		// 计薪天数：日薪 = 月薪 ÷ 它。夹 1~30，非法回退默认。
		const payDaysRaw = num(c.pay_days_per_month, NaN);
		const payDays = Number.isFinite(payDaysRaw) && payDaysRaw >= 1 ? Math.min(30, payDaysRaw) : DEFAULT_CONFIG.pay_days_per_month;

		const startMin = parseHHMM(c.work_start, 540);
		const endMin = parseHHMM(c.work_end, 1020);
		const lunchMin = clamp(Math.round(num(c.lunch_minutes, 0)), 0, 300);
		const lunchStartMin = parseHHMM(c.lunch_start, startMin + 150);
		// 午休开始相对上班的偏移（跨零点也成立）
		const lunchAfterMin = ((lunchStartMin - startMin) % DAY_MIN + DAY_MIN) % DAY_MIN;

		const onSite = Math.max(0, endMin - startMin);
		// 只扣「真正落在上下班区间内」的午休：午休设在上班时段外时不该把工时扣成负数。
		const lunchLo = lunchStartMin;
		const lunchHi = lunchStartMin + lunchMin;
		const lunchOverlap = Math.max(0, Math.min(endMin, lunchHi) - Math.max(startMin, lunchLo));
		const paidMin = Math.max(0, onSite - lunchOverlap);

		const daily = monthly / payDays;
		const netSec = paidMin * 60;
		const perSec = netSec > 0 ? daily / netSec : 0;

		const rateOf = (v, dflt) => Math.max(0, num(v, dflt));
		// 上班日的加班窗口不允许压进上班时段（设置页已拦，这里兜手改 JSON 的情况）：
		// 压进去的话同一段时间既算基础工时又算加班，等于一份时间两份钱。
		const otStartWorkdayMin = Math.max(endMin, parseHHMM(c.overtime_start_workday, 1140));
		const otEndWorkdayMin = parseHHMM(c.overtime_end_workday, 1260);
		const otStartWeekendMin = parseHHMM(c.overtime_start_weekend, 540);
		const otEndWeekendMin = parseHHMM(c.overtime_end_weekend, 1020);

		return {
			startMin,
			endMin,
			lunchMin,
			lunchStartMin,
			lunchAfterMin,
			paidMin,
			daily,
			netSec,
			perSec,
			perHour: perSec * 3600,
			weekdays: Array.isArray(c.work_weekdays) ? c.work_weekdays.map(Number) : DEFAULT_CONFIG.work_weekdays.slice(),
			otOn: c.overtime_enabled === true,
			// 兜底：手改 JSON 时周末可能同时出现在两个列表里。那样同一天会既发日薪
			// 又发加班费，所以这里把冲突的周末从加班日里剔掉（上班日优先）。
			// 正常保存路径由 validateConfig 提前拦下，走不到这里。
			otDays: (Array.isArray(c.overtime_weekdays) ? c.overtime_weekdays.map(Number) : DEFAULT_CONFIG.overtime_weekdays.slice())
				.filter((d) => !(d >= 6 && (c.work_weekdays || []).map(Number).includes(d))),
			otWorkRate: rateOf(c.overtime_rate_workday, 1.5),
			otRestRate: rateOf(c.overtime_rate_weekend, 2),
			otStartWorkdayMin,
			otEndWorkdayMin,
			otStartWeekendMin,
			otEndWeekendMin,
		};
	}

	/* ------------------------------------------------------------------
	 * 判定与累计
	 * ------------------------------------------------------------------ */
	/** 今天是不是上班日 —— 只看周几，工作日的集合可以为空。 */
	function isWorkday(model, d) {
		return model.weekdays.includes(dowOf(d));
	}

	/** 基础工时（不含加班）：今天已经上了多少秒，午休不算。 */
	function workedSeconds(model, now) {
		const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
		if (cur <= model.startMin) return 0;
		const eff = Math.min(cur, model.endMin);
		const span = eff - model.startMin;
		if (span <= 0) return 0;
		const ls = model.startMin + model.lunchAfterMin;
		const le = ls + model.lunchMin;
		const overlap = Math.max(0, Math.min(eff, le) - Math.max(model.startMin, ls));
		return Math.max(0, span - overlap) * 60;
	}

	/** 今天生效的加班窗口与倍率（上班日走工作日那对，非上班日走另一对）。 */
	function overtimeWindow(model, d) {
		const workday = isWorkday(model, d);
		if (!workday) {
			return { start: model.otStartWeekendMin, end: model.otEndWeekendMin, rate: model.otRestRate };
		}
		return { start: model.otStartWorkdayMin, end: model.otEndWorkdayMin, rate: model.otWorkRate };
	}

	/** 加班窗口里「不算钱」的午休分钟数。
	 *  按既定口径：**上班日和非上班日都扣**（非上班日那天本来没有午休工资）。 */
	function lunchInside(model, a, b) {
		const ls = model.startMin + model.lunchAfterMin;
		const le = ls + model.lunchMin;
		return Math.max(0, Math.min(b, le) - Math.max(a, ls));
	}

	/**
	 * 加班窗口在 [start, upto) 之间的「有效秒数」：扣掉落在里面的午休。
	 * 唯一一处时间口径，otPay 与进度条都从这里取。
	 */
	function otSec(model, startMin, uptoMin, endMin) {
		const hi = Math.min(uptoMin, endMin);
		if (hi <= startMin) return 0;
		return Math.max(0, hi - startMin - lunchInside(model, startMin, hi)) * 60;
	}

	/**
	 * 全插件唯一一处「加班费」算法。
	 *
	 *   加班费 = 时薪 × 倍率 × 加班有效秒数
	 *
	 * 倍率就是字面倍数：0 = 没钱，1 = 拿一份时薪，2 = 拿两份时薪。
	 * 三个调用点只差「算到哪一刻」：
	 *   今天全额度 → upto = end（整段）
	 *   今日已赚   → upto = 此刻
	 *   本月每天   → upto = end（整段，逐日累加）
	 */
	function otPay(model, startMin, uptoMin, endMin, rate) {
		if (rate <= 0) return 0;
		return model.perSec * rate * otSec(model, startMin, uptoMin, endMin);
	}

	/** 某天按设置能拿多少加班费（整天口径，不含「已经过去多少」）。 */
	function otPayForDay(model, d) {
		if (!model.otOn || !model.otDays.includes(dowOf(d))) return 0;
		const w = overtimeWindow(model, d);
		return otPay(model, w.start, w.end, w.end, w.rate);
	}

	/** 本月剩余（含今天）的上班天数与金额。 */
	function monthRemaining(model, now) {
		const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
		let days = 0;
		let ot = 0;
		const d = new Date(today);
		while (d.getMonth() === today.getMonth()) {
			if (isWorkday(model, d)) days += 1;
			ot += otPayForDay(model, d);
			d.setDate(d.getDate() + 1);
		}
		return { days, base: days * model.daily, ot };
	}

	/* ------------------------------------------------------------------
	 * 快照：看板要显示的全部数字
	 * ------------------------------------------------------------------ */
	function snapshot(model, now) {
		const workday = isWorkday(model, now);
		const otDay = model.otDays.includes(dowOf(now));
		const cur = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
		const ls = model.startMin + model.lunchAfterMin;
		const le = ls + model.lunchMin;

		let phase = "working";
		let baseWorked = 0;
		let otWorked = 0;
		let otRate = 0;
		let otStartMin = 0;
		let otEndMin = 0;

		if (workday) {
			if (cur < model.startMin) phase = "before";
			else if (cur >= ls && cur < le && cur < model.endMin) phase = "lunch";
			else if (cur >= model.endMin) phase = "after";
			baseWorked = workedSeconds(model, now);
			otStartMin = model.otStartWorkdayMin;
			otEndMin = model.otEndWorkdayMin;
			otRate = model.otWorkRate;
		} else {
			phase = "rest";
			otStartMin = model.otStartWeekendMin;
			otEndMin = model.otEndWeekendMin;
			otRate = model.otRestRate;
		}
		// 加班总开关关掉 / 今天不是加班日 / 时段写反 → 倍率归零。
		if (!otDay || !model.otOn) otRate = 0;
		if (otEndMin <= otStartMin) otRate = 0;
		// 下班之后、加班开始之前：上班族视角在休息，单独一个阶段。
		const otWindowValid = model.otOn && otDay && otEndMin > otStartMin;
		if (workday && cur >= model.endMin && otWindowValid && otStartMin > model.endMin && cur < otStartMin) {
			phase = "idle";
		}

		let otSpanSec = 0; // 加班窗口的有效总秒数（扣午休）
		if (otWindowValid) {
			otSpanSec = otSec(model, otStartMin, otEndMin, otEndMin);
			if (cur >= otStartMin) {
				otWorked = otSec(model, otStartMin, cur, otEndMin);
				if (!workday && cur >= otEndMin) phase = "after";
				if (cur < otEndMin) {
					const inLunch = cur >= ls && cur < le;
					phase = inLunch ? "lunch" : "overtime";
				}
			}
		}
		const worked = baseWorked + otWorked;

		// 进度条：上班日按应上工时；非上班日没有基础工时，改按加班进度。
		const progress = workday
			? model.netSec > 0
				? clamp(baseWorked / model.netSec, 0, 1)
				: 0
			: otSpanSec > 0
				? clamp(otWorked / otSpanSec, 0, 1)
				: 0;

		const rem = monthRemaining(model, now);

		/* 六个金额，命名规则：前缀 = 时间范围，后缀 = 是不是加班费。
		 *   day   今天这一天总共能拿多少（全额度）
		 *   earned 今天到此刻已经赚到多少
		 *   month  本月剩余（含今天）还能赚多少
		 *   Base = 基本工资（绿）；Ot = 加班费（蓝）。两者相加没有重复项。
		 */
		const dayBase = workday ? model.daily : 0;
		const dayOt = otPayForDay(model, now);
		const earnedBase = workday ? model.daily * progress : 0;
		const earnedOt = otWindowValid ? otPay(model, otStartMin, cur, otEndMin, otRate) : 0;

		/* Q8：今天已经赚到的那部分要从「本月还可赚」里扣掉。
		 * 不扣的话同一天会被算两遍 —— 格子写着「还可赚」，却把上午已经进账的钱
		 * 又算了一次，而且一天之内这个数还会往上飘。
		 * 同理，今天彻底干完之后（基本工时已满），「本月剩余工作日」也要减 1，
		 * 否则会出现「16 天 × 日薪 ≠ 还可赚」的自相矛盾。 */
		const monthBase = Math.max(0, rem.base - earnedBase);
		const monthOt = Math.max(0, rem.ot - earnedOt);
		const todayDone = workday && model.daily > 0 && earnedBase >= model.daily - 1e-9;
		const remDays = Math.max(0, rem.days - (todayDone ? 1 : 0));

		return {
			now,
			model,
			workday,
			phase,
			progress,
			// 时间
			worked,
			remaining: Math.max(0, model.netSec - baseWorked),
			otRemaining: otWindowValid ? Math.max(0, otSpanSec - otWorked) : 0,
			otStartMin,
			otEndMin,
			otWindowValid,
			otRate,
			// 钱（3 组 × 绿/蓝）
			dayBase,
			dayOt,
			dayTotal: dayBase + dayOt,
			earnedBase,
			earnedOt,
			earned: earnedBase + earnedOt,
			monthBase,
			monthOt,
			monthTotal: monthBase + monthOt,
			remDays,
			// 彩蛋：开着加班，但两档倍率全是 0 —— 白加班。
			otAllZero: model.otOn && model.otWorkRate <= 0 && model.otRestRate <= 0,
			// 这一刻每秒进账多少：只有真正在计时（上班 / 加班）才有速度。
			secRate: phase === "overtime" ? model.perSec * otRate : phase === "working" ? model.perSec : 0,
		};
	}

	return {
		DEFAULT_CONFIG,
		CONFIG_KEYS,
		OVERTIME_RATES,
		OVERTIME_RATE_KEYS,
		PET_SIZES,
		PET_SIZE_INDEX,
		petSizeOf,
		sheetOf,
		skinFile,
		parseHHMM,
		fmtHHMM,
		money,
		durText,
		sanitizePatch,
		validateConfig,
		deriveModel,
		isWorkday,
		overtimeWindow,
		// otSec 只给单测校验口径用；otPay / otPayForDay 是内部实现，不对外暴露。
		otSec,
		snapshot,
	};
});

/*
 * core.js 自测：把「用户 12 条决策」逐条落成断言。
 * 运行：node test/core.test.js   （任何一条失败都会打印 FAIL 并以退出码 1 结束）
 */
const Core = require("../runtime/helper/core.js");

let pass = 0;
const fails = [];

function ok(name, cond, detail) {
	if (cond) {
		pass += 1;
	} else {
		fails.push(name + (detail ? "  →  " + detail : ""));
	}
}
function eq(name, actual, expect, tol) {
	if (typeof expect === "number" && typeof actual === "number") {
		const t = tol == null ? 0.005 : tol;
		ok(name, Math.abs(actual - expect) <= t, `实际 ${actual}，期望 ${expect}`);
		return;
	}
	ok(name, Object.is(actual, expect), `实际 ${String(actual)}，期望 ${String(expect)}`);
}
function near(name, actual, expect, tol) {
	eq(name, actual, expect, tol);
}

/* ---------------- 基础口径 ---------------- */
const D = Core.DEFAULT_CONFIG;
eq("默认月薪", D.monthly_wage, 10000);
eq("默认计薪天数", D.pay_days_per_month, 21.75);
eq("默认不含 daily_wage", D.daily_wage, undefined);
eq("默认不含 holidays", D.holidays, undefined);
eq("默认不含 extra_workdays", D.extra_workdays, undefined);
eq("默认不含 snap_sides", D.snap_sides, undefined);
eq("默认不含 overtime_rate_holiday", D.overtime_rate_holiday, undefined);
eq("配置键总数", Core.CONFIG_KEYS.length, 27);

const now = new Date(2026, 10, 9, 14, 0, 0); // 2026-11-09 周一 14:00
const m = Core.deriveModel(D);
eq("日薪 10000/21.75", m.daily, 10000 / 21.75);
// 9:00-17:00 = 480 分钟，午休 11:30-13:00 完全落在上班时段内 → 扣 90 分钟
eq("净工作时长(分)", m.paidMin, 390);
eq("每秒", m.perSec, 10000 / 21.75 / (390 * 60));
near("时薪", m.perHour, 70.7279, 0.01);

/* ---------------- 决策③：允许全空 = 全是休息日 ---------------- */
const emptyDays = Core.sanitizePatch({ work_weekdays: [] });
ok("work_weekdays 允许空数组", Array.isArray(emptyDays.work_weekdays) && emptyDays.work_weekdays.length === 0, JSON.stringify(emptyDays.work_weekdays));
const mEmpty = Core.deriveModel({ ...D, work_weekdays: [] });
for (let i = 0; i < 7; i++) {
	const d = new Date(2026, 10, 9 + i); // 周一起连续 7 天
	ok(`全空时 ${i} 天不是上班日`, Core.isWorkday(mEmpty, d) === false);
}

/* ---------------- 决策④：删掉 17:00 / 05:00 两条硬下限 ---------------- */
ok("下班 16:00 + 加班 16:30 起 合法", Core.validateConfig({ ...D, work_end: "16:00", overtime_start_workday: "16:30", overtime_end_workday: "18:00" }) === null);
ok("非上班日加班从 01:00 开始 合法", Core.validateConfig({ ...D, overtime_start_weekend: "01:00", overtime_end_weekend: "03:00" }) === null);
ok("上班日加班开始早于下班时间 报错", typeof Core.validateConfig({ ...D, overnight: 1, overtime_start_workday: "16:00" }) === "string");
ok("加班结束早于开始 报错", typeof Core.validateConfig({ ...D, overtime_end_workday: "18:00", overtime_start_workday: "19:00" }) === "string");
ok("下班早于上班 报错", typeof Core.validateConfig({ ...D, work_end: "08:00" }) === "string");
ok("午休开始早于上班 报错", typeof Core.validateConfig({ ...D, lunch_start: "08:00" }) === "string");
ok("午休结束晚于下班 报错", typeof Core.validateConfig({ ...D, lunch_start: "16:00", lunch_minutes: 120 }) === "string");
ok("默认配置校验通过", Core.validateConfig(D) === null);

/* ---------------- 决策②：非上班日加班照样扣午休 ---------------- */
const resto = { ...D, work_weekdays: [], overtime_enabled: true, overtime_weekdays: [1], overtime_start_weekend: "11:00", overtime_end_weekend: "14:00", overtime_rate_weekend: "2" };
const mRest = Core.deriveModel(resto);
const mon = new Date(2026, 10, 9, 14, 0, 0); // 周一，非上班日
const snapRest = Core.snapshot(mRest, mon);
eq("非上班日加班窗口有效 90 分钟", Core.otSec(mRest, snapRest.otStartMin, snapRest.otEndMin, snapRest.otEndMin) / 60, 90, 0.01); // 11:00-14:00 与午休 11:30-13:00 完全重叠 → 扣 90
ok("非上班日加班日判定", snapRest.otWindowValid === true);

/* ---------------- 决策⑦：倍率 0 只影响加班工资 ---------------- */
const workdayCfg = { ...D, overtime_enabled: true, overtime_weekdays: [1], overtime_rate_workday: "0" };
const mW0 = Core.deriveModel(workdayCfg);
const at14 = new Date(2026, 10, 9, 14, 0, 0);
const sW0 = Core.snapshot(mW0, at14);
eq("倍率0 上班日 绿=日薪", sW0.dayBase, mW0.daily);
eq("倍率0 上班日 蓝=0", sW0.dayOt, 0);
eq("倍率0 上班日 合计=日薪", sW0.dayTotal, mW0.daily);

const restZero = { ...D, work_weekdays: [], overtime_enabled: true, overtime_weekdays: [1], overtime_rate_workday: "0", overtime_rate_weekend: "0", overtime_start_weekend: "09:00", overtime_end_weekend: "12:00" };
const sRestZero = Core.snapshot(Core.deriveModel(restZero), new Date(2026, 10, 9, 10, 0, 0));
eq("倍率0 非上班日 绿=0", sRestZero.dayBase, 0);
eq("倍率0 非上班日 蓝=0", sRestZero.dayOt, 0);
eq("倍率0 非上班日 合计=0", sRestZero.dayTotal, 0);
ok("倍率0 且两档都0 → 太窝囊了", sRestZero.otAllZero === true);

/* 倍率 1（Q7 口径）：加班费 = 时薪 × 1 × 加班时长，全部记蓝；绿只有日薪 */
const s1 = Core.snapshot(Core.deriveModel({ ...D, overtime_enabled: true, overtime_weekdays: [1], overtime_rate_workday: "1", overtime_start_workday: "18:00", overtime_end_workday: "20:00" }), at14);
const mm1 = Core.deriveModel({ ...D, overtime_enabled: true, overtime_weekdays: [1], overtime_rate_workday: "1", overtime_start_workday: "18:00", overtime_end_workday: "20:00" });
eq("倍率1 上班日 蓝=1倍加班费", s1.dayOt, mm1.perSec * 120 * 60, 0.01);
eq("倍率1 上班日 绿=纯日薪", s1.dayBase, mm1.daily, 0.01);

/* 倍率 2：蓝 = 2 倍时薪的加班费，绿仍是纯日薪 */
const cfg2 = { ...D, overtime_enabled: true, overtime_weekdays: [1], overtime_rate_workday: "2", overtime_start_workday: "18:00", overtime_end_workday: "20:00" };
const m2 = Core.deriveModel(cfg2);
const s2 = Core.snapshot(m2, at14);
eq("倍率2 蓝=2倍加班费", s2.dayOt, 2 * m2.perSec * 120 * 60, 0.01);
eq("倍率2 绿=纯日薪", s2.dayBase, m2.daily, 0.01);

/* ---------------- 决策⑧：基础绿 + 加班蓝（字段必须都在） ---------------- */
ok("snapshot 有 dayBase", typeof s2.dayBase === "number");
ok("snapshot 有 dayOt", typeof s2.dayOt === "number");
eq("dayTotal = dayBase + dayOt", s2.dayTotal, s2.dayBase + s2.dayOt, 0.001);

/* ---------------- 已赚 / 进度 ---------------- */
const cfgPlain = { ...D };
const sPlain = Core.snapshot(Core.deriveModel(cfgPlain), new Date(2026, 10, 9, 13, 30, 0));
// 09:00-13:30 = 270 分钟，其中 11:30-13:00 午休 90 分钟 → 有效 180 分钟
eq("13:30 已工作(秒)", sPlain.worked, 180 * 60, 0.5);
eq("13:30 已赚", sPlain.earned, (10000 / 21.75) * (180 / 390), 0.01);
eq("13:30 剩余(秒)", sPlain.remaining, (390 - 180) * 60, 0.5);

/* ---------------- 阶段判定 ---------------- */
const phaseAt = (hh, mm, cfg) => Core.snapshot(Core.deriveModel(cfg || D), new Date(2026, 10, 9, hh, mm, 0)).phase;
ok("08:00 还没上班", phaseAt(8, 0) === "before");
ok("10:00 搬砖中", phaseAt(10, 0) === "working");
ok("12:00 午休中", phaseAt(12, 0) === "lunch");
ok("14:00 搬砖中", phaseAt(14, 0) === "working");
ok("17:30 已收工", phaseAt(17, 30) === "after");

/* idle：下班后、加班开始前 */
ok("18:30 休息中(idle)", phaseAt(18, 30, { ...D, overtime_enabled: true, overtime_weekdays: [1], overtime_start_workday: "19:00", overtime_end_workday: "21:00" }) === "idle");
ok("19:30 加班中", phaseAt(19, 30, { ...D, overtime_enabled: true, overtime_weekdays: [1], overtime_start_workday: "19:00", overtime_end_workday: "21:00" }) === "overtime");

/* ---------------- 决策⑨：彩蛋挪到窝囊费格（数据侧只有 otAllZero） ---------------- */
const allZero = Core.snapshot(Core.deriveModel({ ...D, overtime_enabled: true, overtime_weekdays: [1], overtime_rate_workday: "0", overtime_rate_weekend: "0" }), at14);
ok("两档全0 → otAllZero", allZero.otAllZero === true);
const notAllZero = Core.snapshot(Core.deriveModel({ ...D, overtime_enabled: true, overtime_weekdays: [1], overtime_rate_workday: "1.5" }), at14);
ok("有一档非0 → 不触发彩蛋", notAllZero.otAllZero === false);
const otOff = Core.snapshot(Core.deriveModel({ ...D, overtime_enabled: false }), at14);
ok("加班关掉 → 不触发彩蛋", otOff.otAllZero === false);

/* ---------------- 边界：非法时间 ---------------- */
ok("parseHHMM 24:00 不合法→回退", Core.parseHHMM("24:00", 540) === 540);
ok("parseHHMM 09:5 不合法→回退", Core.parseHHMM("09:5", 540) === 540);
ok("parseHHMM 空串→回退", Core.parseHHMM("", 540) === 540);
ok("parseHHMM 09:05", Core.parseHHMM("09:05", 0) === 545);
ok("fmtHHMM 1440→00:00", Core.fmtHHMM(1440) === "00:00");
ok("fmtHHMM -60→23:00", Core.fmtHHMM(-60) === "23:00");

/* ---------------- 边界：月薪 0 / 空 ---------------- */
eq("月薪 0 → 日薪 0", Core.deriveModel({ ...D, monthly_wage: 0 }).daily, 0);
eq("月薪空 → 回退默认", Core.deriveModel({ ...D, monthly_wage: "" }).daily, 10000 / 21.75);

/* ---------------- 边界：计薪天数夹取 ---------------- */
eq("计薪天数 0 → 回退默认", Core.deriveModel({ ...D, pay_days_per_month: 0 }).daily, 10000 / 21.75);
eq("计薪天数 40 → 夹到 30", Core.deriveModel({ ...D, pay_days_per_month: 40 }).daily, 10000 / 30);

/* ---------------- 周末互斥：两个列表的周六/周日不能重叠 ---------------- */
const weekendCases = [
	["周六", { work_weekdays: [1, 2, 3, 4, 5, 6], overtime_weekdays: [6] }],
	["周日", { work_weekdays: [7], overtime_weekdays: [6, 7] }],
	["周六+周日", { work_weekdays: [6, 7], overtime_weekdays: [6, 7] }],
];
for (const [name, patch] of weekendCases) {
	const err = Core.validateConfig({ ...D, overtime_enabled: true, ...patch });
	ok(`${name} 同时选成上班日和加班日 → 报错`, typeof err === "string" && err.includes("不能同时"));
}
ok("周六只在上班日 合法", Core.validateConfig({ ...D, work_weekdays: [1, 6], overtime_weekdays: [7] }) === null);
ok("周一/周五 两组都选 合法", Core.validateConfig({ ...D, work_weekdays: [1, 2, 3, 4, 5], overtime_weekdays: [1, 5] }) === null);
ok("两组都全空 合法", Core.validateConfig({ ...D, work_weekdays: [], overtime_weekdays: [] }) === null);

/* ---------------- 兜底：手改 JSON 让周末重叠时，加班日剔除冲突项 ---------------- */
const bothSat = Core.deriveModel({ ...D, work_weekdays: [6], overtime_weekdays: [6], overtime_enabled: true });
ok("冲突的周六按上班日算", Core.isWorkday(bothSat, new Date(2026, 10, 14)) === true);
ok("冲突的周六已从加班日剔除", bothSat.otDays.includes(6) === false);
ok("冲突的周六不再发加班费", Core.snapshot(bothSat, new Date(2026, 10, 14, 20, 0)).dayOt === 0);

/* ---------------- monthRemaining：全空时 0 ---------------- */
eq("全空 → 本月剩余 0 天", Core.snapshot(mEmpty, mon).remDays, 0);
eq("全空 → 本月还可赚 0", Core.snapshot(mEmpty, mon).monthTotal, 0);

/* ---------------- 尺寸表 ---------------- */
eq("PET_SIZES", Core.PET_SIZES.length, 3);
eq("petSizeOf(-1) 夹到 96", Core.petSizeOf(-1), 96);
eq("petSizeOf(99) 夹到 135", Core.petSizeOf(99), 135);
eq("skinFile(0,false)", Core.skinFile(0, false), "pet-135.webp");
eq("skinFile(2,true)", Core.skinFile(2, true), "pet-324@2x.webp");
eq("sheetOf(1).frameW", Core.sheetOf(1).frameW, 231);

/* ---------------- 结果 ---------------- */
console.log(`\n通过 ${pass} / ${pass + fails.length}`);
if (fails.length) {
	console.log("\n失败项：");
	for (const f of fails) console.log("  ✗ " + f);
	process.exit(1);
}
console.log("全部通过");

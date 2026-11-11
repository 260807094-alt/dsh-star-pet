/*
 * dsh-star-pet · 贴边躲藏（独立模块）
 * ------------------------------------------------------------------
 * 设计原则：**不改动 renderer.js 的既有逻辑**。本文件只做三件事：
 *   1. 提供一个纯函数 petTransform()，产出完整的 transform 字符串；
 *      renderer.js 原来那两处写法（layoutPet / tickSquish）改为调用它，
 *      未启用躲藏时产出与改前逐字节相同（"none" 或 "scaleX(-1)"）。
 *   2. 维护躲藏状态机与关键帧插值，每帧算出 {tx, ty, rot, sx, sy}。
 *   3. 提供热区命中、触发判定等纯查询函数。
 *
 * 所有副作用（改 DOM、发 IPC）都由 controller 单点完成，便于整体开关。
 * 关掉 dock_hide 后 current() 恒为 null，既有渲染路径完全不受影响。
 *
 * 坐标约定：tx/ty 是相对「宠物居中位置」的位移（px），正值向右/向下；
 *          rot 是 CSS rotate 的角度（deg，正=顺时针）；
 *          sx/sy 是叠加在雪碧图形变之上的比例（1 = 原样）。
 */
(function (global) {
	"use strict";

	// ── 关键帧：tx, ty, rot, sx, sy, ease（本段 → 下一段所用缓动）
	// tx=0 表示「贴边静止位」，tx=SLIDE 表示「只留星星」。实际数值由
	// 控制器按当前尺寸把 0/1 归一值映射到像素，见 controller 里的 sx 换算。
	const JUMP_IN = [
		{ u: 0, ty: 0, rot: 0, sx: 1.0, sy: 1.0, utx: 0, ease: "out" }, // 静止贴边
		{ u: 80, ty: 7, rot: 0, sx: 1.09, sy: 0.89, utx: 0, ease: "out" }, // 蓄力下压
		{ u: 280, ty: -26, rot: -40, sx: 0.93, sy: 1.07, utx: -0.12, ease: "out" }, // 弹起+起旋
		{ u: 350, ty: -35, rot: -90, sx: 1.0, sy: 1.0, utx: -0.18, ease: "in" }, // 顶点（停 70ms）
		{ u: 550, ty: 0, rot: -90, sx: 1.02, sy: 0.99, utx: 1, ease: "out" }, // 坠落入边
		{ u: 640, ty: 0, rot: -90, sx: 1.1, sy: 0.92, utx: 1, ease: "spring" }, // 挤入门缝
		{ u: 730, ty: 0, rot: -90, sx: 1.0, sy: 1.0, utx: 1, ease: "out" }, // 回弹定住
	];

	const JUMP_OUT = [
		{ u: 0, ty: 0, rot: -90, sx: 1.1, sy: 0.94, utx: 1, ease: "out" }, // 星星抖两下
		{ u: 120, ty: -2, rot: -62, sx: 1.08, sy: 0.96, utx: 0.79, ease: "out" }, // 挤出门缝
		{ u: 260, ty: -14, rot: -28, sx: 1.02, sy: 1.0, utx: 0.49, ease: "in" }, // 侧身钻出
		{ u: 360, ty: 6, rot: -4, sx: 1.09, sy: 0.9, utx: 0.05, ease: "spring" }, // 落地压扁
		{ u: 440, ty: -9, rot: 3, sx: 0.96, sy: 1.05, utx: -0.03, ease: "spring" }, // 回弹过冲
		{ u: 540, ty: 0, rot: 0, sx: 1.0, sy: 1.0, utx: 0, ease: "out" }, // 站稳
	];

	const EASE = {
		linear: (p) => p,
		out: (p) => 1 - Math.pow(1 - p, 3),
		in: (p) => p * p,
		inout: (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2),
		// 回弹：过冲后回落，用于「挤门缝 / 落地压扁」
		spring: (p) => {
			if (p >= 1) return 1;
			const c1 = 1.70158;
			const c3 = c1 + 1;
			return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2);
		},
	};

	const lerp = (a, b, p) => a + (b - a) * p;
	const POSE_KEYS = ["ty", "rot", "sx", "sy", "utx"];

	/** 在关键帧表上取时刻 ms 的插值（返回归一化的 utx，未映射成像素）。 */
	function sample(frames, ms) {
		const zero = { ty: 0, rot: 0, sx: 1, sy: 1, utx: 0 };
		if (!frames || !frames.length) return zero;
		if (ms <= frames[0].u) return pick(frames[0]);
		const last = frames[frames.length - 1];
		if (ms >= last.u) return pick(last);
		for (let i = 0; i < frames.length - 1; i++) {
			const a = frames[i];
			const b = frames[i + 1];
			if (ms >= a.u && ms < b.u) {
				const span = Math.max(1, b.u - a.u);
				const p = (EASE[a.ease] || EASE.out)((ms - a.u) / span);
				const o = {};
				for (const k of POSE_KEYS) o[k] = lerp(a[k], b[k], p);
				return o;
			}
		}
		return pick(last);
	}

	function pick(f) {
		return { ty: f.ty, rot: f.rot, sx: f.sx, sy: f.sy, utx: f.utx };
	}

	const durationOf = (frames) => (frames && frames.length ? frames[frames.length - 1].u : 0);

	/**
	 * 产出 #petWrap 的完整 transform 字符串 —— 唯一允许拼 transform 的地方。
	 * 既有代码里 layoutPet 与 tickSquish 各写各的，曾导致 v1.2 的「镜像丢失」
	 * bug（"scaleX(-1) none" 是非法值，整条 transform 被丢弃）。
	 *
	 * @param {{mirror:boolean, dock:object|null}} o
	 */
	function petTransform(o) {
		o = o || {};
		const parts = [];
		if (o.mirror) parts.push("scaleX(-1)");
		const d = o.dock;
		if (d) {
			const tx = Number(d.tx) || 0;
			const ty = Number(d.ty) || 0;
			const rot = Number(d.rot) || 0;
			const sx = Number.isFinite(d.sx) ? d.sx : 1;
			const sy = Number.isFinite(d.sy) ? d.sy : 1;
			if (tx || ty) parts.push("translate(" + tx.toFixed(2) + "px," + ty.toFixed(2) + "px)");
			if (rot) parts.push("rotate(" + rot.toFixed(2) + "deg)");
			if (sx !== 1 || sy !== 1) parts.push("scale(" + sx.toFixed(4) + "," + sy.toFixed(4) + ")");
		}
		return parts.length ? parts.join(" ") : "none";
	}

	/**
	 * 热区命中：宠物沿屏幕边的一条竖带，宽 zoneW、高 = 宠物高。
	 * @param {{box:number[]}} pet  st.pet
	 * @param {number} winW 窗口宽
	 * @param {number} zoneW 热区宽度
	 * @param {boolean} onLeft 宠物贴左边缘？（否则按右边缘）
	 */
	function inZone(x, y, pet, winW, zoneW, onLeft) {
		if (!pet || !pet.box) return false;
		const box = pet.box;
		const w = Math.max(1, Number(zoneW) || 26);
		const x0 = onLeft ? 0 : winW - w;
		const x1 = onLeft ? w : winW;
		return x >= x0 && x <= x1 && y >= box[1] && y <= box[3];
	}

	// ───────────────────────────── 状态机
	const IDLE = "idle";
	const IN = "jumping-in";
	const TUCKED = "tucked";
	const OUT = "jumping-out";

	/** 隐藏后重新躲回的延迟（ms）：鼠标离开后 0.6s 才收 */
	const HIDE_DELAY = 600;

	/**
	 * 创建一个躲藏控制器。
	 * @param {object} hooks
	 * @param {(transform:string)=>void} hooks.apply  把 transform 写到 #petWrap
	 * @param {()=>number} hooks.slidePx              当前尺寸下「只留星星」所需位移（正数）
	 * @param {()=>boolean} hooks.mirror              宠物是否镜像（屏幕左半边）
	 */
	function create(hooks) {
		const H = hooks || {};
		const S = {
			enabled: false,
			edge: null, // "left" | "right" | null
			state: IDLE,
			anim: null, // {kind:"in"|"out", pos, dir}
			hover: false,
			armed: false, // 躲好后必须先移开一次，才允许再弹出（防止刚躲进去就弹出来）
			hideAt: 0,
			last: 0,
		};

		const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

		function applyNow() {
			if (typeof H.apply === "function") H.apply(poseTransform());
		}

		/** 当前姿态 → {-1..1 的 utx 映射成像素} */
		function currentPose() {
			if (!S.enabled || !S.edge) return null;
			if (S.state === TUCKED) return sample(JUMP_IN, durationOf(JUMP_IN));
			if (!S.anim) return null;
			const frames = S.anim.kind === "in" ? JUMP_IN : JUMP_OUT;
			const p = sample(frames, S.anim.pos);
			// 「跳出来」开场 100ms 内星星抖两下（±2px），增强「被戳醒」的感觉
			if (S.anim.kind === "out" && S.anim.pos < 100) {
				p.utx += (Math.sin((S.anim.pos / 100) * Math.PI * 4) * 2) / Math.max(1, Math.abs(H.slidePx ? H.slidePx() : 1));
			}
			return p;
		}

		/** 把归一化姿态换算成实际像素 / 角度。
		 *  关键帧表里的 rot 一律按「局部 −90°」写：局部旋转 −90° 后星星落在
		 *  旋转图的**左缘**，于是「往右滑、只留最左那条」就只剩星星。
		 *  贴左边缘时 transform 最外层有 scaleX(-1)，它把整张图连位置带角度
		 *  一起镜像 —— 局部 −90° 就变成屏幕上的「星星在宠物右侧」，再往局部
		 *  +slide 平移（屏幕上是向左），留下的同样是最靠边的那条 = 星星。
		 *  所以 tx / rot 在两条边上取值完全相同，镜像自动处理方向，
		 *  这里不需要任何 sign 分支。 */
		function toDock(pose) {
			if (!pose) return null;
			const slide = Math.abs(Number(H.slidePx ? H.slidePx() : 0)) || 0;
			return {
				tx: pose.utx * slide,
				ty: pose.ty,
				rot: pose.rot,
				sx: pose.sx,
				sy: pose.sy,
			};
		}

		function poseTransform() {
			const mirror = typeof H.mirror === "function" ? !!H.mirror() : false;
			return petTransform({ mirror, dock: toDock(currentPose()) });
		}

		/** 起播。两张关键帧表都以「起点在 u=0」书写：
		 *  JUMP_IN  u=0 是露出态 → u=末 是躲好态；
		 *  JUMP_OUT u=0 是躲好态 → u=末 是露出态。
		 *  所以两个方向都从 pos=0 正向推进，"in" 走 JUMP_IN、"out" 走 JUMP_OUT。
		 *  倒放（中途反悔）只把 dir 取反，不改起点。 */
		function startAnim(kind, fromPos) {
			const frames = kind === "in" ? JUMP_IN : JUMP_OUT;
			const dur = durationOf(frames);
			const pos = fromPos === undefined ? 0 : fromPos;
			S.anim = { kind, pos, dur, dir: 1 };
			S.state = kind === "in" ? IN : OUT;
		}

		function finish(kind, reachedEnd) {
			S.anim = null;
			// reachedEnd：正向播到末尾（或倒放回到 0）。两种完成态由「哪张表 + 顺序」决定。
			if (kind === "in") {
				// JUMP_IN：0=露出 → 末=躲好
				if (reachedEnd) {
					S.state = TUCKED;
					S.armed = !S.hover; // 躲好时鼠标已不在热区 → 下次进来就能弹；还在热区里则要求先移开，防止刚躲进去又弹出来
				} else {
					S.state = IDLE;
				}
			} else {
				// JUMP_OUT：0=躲好 → 末=露出
				if (reachedEnd) {
					S.state = IDLE;
				} else {
					S.state = TUCKED;
				}
			}
			applyNow();
		}

		/** 关掉功能：立刻恢复显示，不留中间态。 */
		function setEnabled(on) {
			const next = !!on;
			if (next === S.enabled) return;
			S.enabled = next;
			S.anim = null;
			S.state = IDLE;
			S.hideAt = 0;
			S.armed = false;
			if (!next) S.edge = null;
			applyNow();
		}

		/** 贴边状态由主进程在拖拽结束时给出（"left"/"right"/null）。 */
		function setEdge(edge, opts) {
			const next = edge === "left" || edge === "right" ? edge : null;
			if (next === S.edge) return;
			S.edge = next;
			if (!next) {
				// 拖离吸附边缘 → 解除躲藏，直接恢复（不需要动画）
				S.anim = null;
				S.state = IDLE;
				S.hideAt = 0;
				S.armed = false;
				applyNow();
				return;
			}
			if (!S.enabled) return;
			// 新贴边 → 立刻播放「跳进去」（用户要求松手就播）
			S.hideAt = 0;
			S.armed = false;
			startAnim("in");
			applyNow();
		}

		/** 鼠标是否在热区内（由渲染端每次 mousemove 调用）。 */
		function pointer(inside) {
			const next = !!inside;
			if (next === S.hover) return;
			S.hover = next;
			if (!S.enabled || !S.edge) return;

			if (next) {
				// 进入热区 → 弹出来（除非还在往里躲且刚好没躲完，也照样反向）
				if (S.state === TUCKED && S.armed) {
					startAnim("out");
					applyNow();
				} else if (S.state === IN && S.anim) {
					// 躲到一半被叫住 → 就地把「跳进去」倒放回去，
					// 不换关键帧表，否则姿态会从当前帧突跳到另一张表的同一时刻。
					S.anim.dir = -1;
					applyNow();
				}
				S.hideAt = 0;
			} else {
				// 离开热区
				S.armed = true;
				if (S.state === OUT && S.anim) {
					// 弹到一半走了 → 就地把「跳出来」倒放回洞里
					S.anim.dir = -1;
					applyNow();
				} else if (S.state === IDLE && S.edge) {
					// 已经露出来了，离开后稍等再躲回去
					S.hideAt = now() + HIDE_DELAY;
				}
			}
		}

		/** 每帧推进（由渲染端 tick 调用）。 */
		function tick(t) {
			const at = typeof t === "number" ? t : now();
			const dt = S.last ? Math.min(64, at - S.last) : 16;
			S.last = at;
			if (!S.enabled || !S.edge) return;

			if (S.anim) {
				const frames = S.anim.kind === "in" ? JUMP_IN : JUMP_OUT;
				const dur = S.anim.dur || durationOf(frames);
				S.anim.pos += dt * S.anim.dir;
				if (S.anim.pos >= dur) {
					S.anim.pos = dur;
					const kind = S.anim.kind;
					finish(kind, true);
					return;
				}
				if (S.anim.pos <= 0) {
					S.anim.pos = 0;
					const kind = S.anim.kind;
					finish(kind, false);
					return;
				}
				applyNow();
				return;
			}

			// 露着且鼠标走了很久 → 自己躲回去
			if (S.state === IDLE && S.hideAt && at >= S.hideAt && !S.hover) {
				S.hideAt = 0;
				startAnim("in");
				applyNow();
			}
		}

		return {
			setEnabled,
			setEdge,
			pointer,
			tick,
			/** 当前 dock 变换（null = 不启用，走原有渲染路径） */
			current: () => toDock(currentPose()),
			/** 供 petTransform 直接用的完整字符串 */
			transform: poseTransform,
			/** 躲藏相关的一切非 idle 态都要隐藏逻辑（不可点、不飘字） */
			hidden: () => S.state !== IDLE,
			state: () => S.state,
			tucked: () => S.state === TUCKED,
			snapshot: () => ({ enabled: S.enabled, edge: S.edge, state: S.state, hover: S.hover, armed: S.armed }),
		};
	}

	global.StarPetDock = {
		JUMP_IN,
		JUMP_OUT,
		EASE,
		sample,
		durationOf,
		petTransform,
		inZone,
		create,
		HIDE_DELAY,
	};
})(typeof window !== "undefined" ? window : globalThis);

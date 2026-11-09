/*
 * dsh-star-pet · 一条命令跑完全部自检
 *
 *   node tools/check.cjs          # 语法 + 核心单测 + 跨文件审计
 *   node tools/check.cjs --quick  # 只跑语法检查
 *
 * 注意：Windows 沙箱下子进程不能开管道（spawn EPERM），所以子进程一律用
 * stdio: "inherit"，不要改成 pipe。
 */
const { spawnSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");

const SYNTAX = [
	"runtime/helper/core.js",
	"runtime/helper/main.js",
	"runtime/helper/preload.js",
	"runtime/helper/renderer.js",
	"runtime/helper/settings.js",
	"runtime/helper/menu.js",
	"lib/index.js",
	"lib/client.js",
	"test/core.test.cjs",
	"test/audit.cjs",
	"test/smoke-host.cjs",
	"tools/check.cjs",
];

let failed = 0;

function run(label, args) {
	process.stdout.write(`\n=== ${label} ===\n`);
	const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit" });
	if (r.error) {
		failed += 1;
		console.error(`启动失败：${r.error.code || r.error.message}`);
		return;
	}
	if (r.status !== 0) {
		failed += 1;
		console.error(`${label} 失败（退出码 ${r.status}）`);
	}
}

// 1) 语法：node --check 能同时覆盖 CJS 与 ESM（按文件扩展名/.mjs 规则判断）
for (const file of SYNTAX) {
	if (!existsSync(path.join(ROOT, file))) {
		failed += 1;
		console.error(`缺少文件：${file}`);
		continue;
	}
	process.stdout.write(`检查语法 ${file} … `);
	const r = spawnSync(process.execPath, ["--check", file], { cwd: ROOT, stdio: "inherit" });
	if (r.status === 0 && !r.error) process.stdout.write("ok\n");
	else {
		failed += 1;
		console.error(`语法错误：${file}`);
	}
}

if (!process.argv.includes("--quick")) {
	run("核心单测（计薪口径）", ["test/core.test.cjs"]);
	run("跨文件静态审计", ["test/audit.cjs"]);
}

console.log(failed === 0 ? "\n全部通过" : `\n有 ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);

# dsh-star-pet

「上班鼓励宠物」的桌面版插件：一个透明、置顶、可拖动的小星人，实时显示今天赚了多少钱。

和原来的独立 exe 版本画面完全一致（同一批帧、同一套配色与排版），但做成了 **DSH 插件**：

- 跟着 DSH 一起启动，不用单独开程序；
- 右键桌宠 → **设置**，改薪资、上下班时间、午休、外观，即时生效；
- 可以在插件市场里分享给别人（对方装完即用，不需要本地 exe）。

## 截图

展开看板：今日已赚、时薪 / 日薪、下班倒计时、本月剩余工作日。

![看板](docs/screenshots/board.png)

收起时的桌宠（可拖拽、贴边吸附、按剩余秒数冒「+¥」）：

![桌宠](docs/screenshots/pet.png)

右键「设置」打开的外观与薪资配置：

![设置](docs/screenshots/settings.png)

## 安装

```bash
dsh plugin add dsh-star-pet        # 或从插件市场点安装
```

首次运行时需要一个 Electron 可执行文件来承载置顶窗口：

| 情况 | 行为 |
| --- | --- |
| 已经装过 `dsh-pet` | 直接复用 `~/.dsh/electron/electron.exe`，零下载 |
| 设了 `DSH_STAR_PET_ELECTRON_PATH` | 用你指定的那个 |
| 都没有 | 设置页会提示，把 Electron 放到 `~/.dsh/electron` 即可 |

## 用法

| 操作 | 结果 |
| --- | --- |
| 单击宠物 | 展开 / 收起今日看板 |
| 按住拖动 | 移动宠物；松手自动贴边（贴左半边时镜像转身） |
| 右键 | 字体、大小、贴边吸附、设置、退出 五项菜单 |
| 悬停 | 显示「困困星人」提示 |

看板内容：工作状态、今日已赚、每秒收入、进度、时薪、日薪、已工作时长、距下班、上下班时间、本月剩余工作日、本月还可赚。

## 设置项

- **薪资**：月薪、月计薪天数（日薪 = 月薪 ÷ 月计薪天数）
- **时间**：上班、下班、午休开始、午休时长（午休不计薪）
- **上班日**：周一…周日多选
- **外观**：宠物大小（108–324 px 九档）、贴边吸附范围、六个开关（贴边吸附 / 贴左镜像 / 点击音效 / 胶囊 / 数字滚动 / 赚到飘字）

配置保存在 `%APPDATA%\dsh-star-pet\config.json`（macOS/Linux 走各自的配置目录），升级插件不会覆盖。

## 宿主路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/dsh-star-pet/config` | 读配置 + 宠物进程状态 |
| POST | `/dsh-star-pet/config` | 合并写配置（白名单字段） |
| POST | `/dsh-star-pet/window` | 记住窗口位置 |
| GET | `/dsh-star-pet/pet/state` | 进程是否在跑 / Electron 路径 / 端口 |
| POST | `/dsh-star-pet/pet/start` \| `/pet/stop` | 手动启停 |
| GET | `/dsh-star-pet/assets/*` | 皮肤雪碧图、字体、音效 |

## 结构

```
lib/index.js            宿主：配置读写、素材服务、拉起 Electron helper
lib/client.js           设置页（settings.section）
runtime/helper/main.js  主进程：透明置顶窗口、拖动吸附、菜单/设置子窗
runtime/helper/renderer.js  画面与计薪逻辑（与 exe 同源）
runtime/helper/menu.*       右键菜单
runtime/helper/settings.*   桌宠自带的设置窗（右键「设置」）
assets/skins/*.webp     29 帧雪碧图（135 / 216 / 324 三档）
assets/Ruanti.ttf       软萌体
assets/click.wav        点击音效
```

## 说明

- 窗口使用 `transparent + alwaysOnTop('screen-saver') + skipTaskbar`，并默认整窗点击穿透，只有宠物、看板、胶囊区域接收鼠标事件——和 exe 的手感一致。
- Windows 上为了透明分层窗口稳定，会关闭硬件加速（与 dsh-pet 相同做法）。
- 计时全部在渲染进程里算，不依赖系统时钟轮询精度；宿主只负责持久化配置与窗口位置。

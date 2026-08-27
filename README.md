# dsh-token-usage-hud

DSH Web 插件：在界面**顶层**（悬浮、置顶）显示当前对话的 token 消耗、费用消耗与
账户剩余金额。

```
⚡ 本对话用量          ×
输入 217k · 缓存 57.1M · 输出 161k
总 tokens 57.4M · 275 步
费用 ¥7.81  [deepseek-v4-flash · 高峰]
上下文 ~964k / 1M (96%) · ≈¥2.89
余额 ¥110.00
```

## 功能

- **host 端**：订阅 `session/event`，对持久会话日志做增量折叠（provider 上报的
  `assistant/message` usage，按 `request/header` 记录的模型归账），并暴露
  loopback-only 的 JSON 接口 `/api/token-usage/stats?session=<id>`。
- **账户余额**：通过 credentials 服务解析 DeepSeek API Key（默认
  `DEEPSEEK_API_KEY`，与 llm 适配器同源），调用官方 `GET /user/balance` 实时
  显示剩余金额（充值/赠送明细悬停可见），带内存缓存与并发合并，Key 只在
  host 端使用、绝不进入浏览器。
- **上下文占用行**：读取与对话框（composer）下方同一数据源的
  `contextPressure` 投影（`~已用 / 上下文窗口` 及占用百分比），并按当前模型的
  输入单价 × 当前时段给出**下一次请求的上下文费用估算**（`≈¥X`）。
- **client 端**：跟随当前选中会话，轮询该接口，在页面顶层渲染悬浮框；**标题栏
  可拖拽移动**（鼠标/触摸，位置自动记忆——刷新、收起再展开后仍停留在原处），
  **双击标题栏复位**到配置位置；`×` 可收起为小药丸（localStorage 记忆），刷新
  页面可恢复。
- **费用估算**：按 token 桶 × 单价计算，单价表默认使用 **DeepSeek 官方 V4 定价**
  （¥/百万 tokens，区分高峰/空闲两档，历史步骤按其发生时段精确计价，见下文）；
  可在插件配置里修改；`cacheWrite` 缺省按 `cacheRead` 计。
- **估算兜底**：尚无 provider 用量时，显示基于字符数（约 4 字符/token）的
  `≈ 估算` 行，并标注“暂无计费用量”。

## 安装

**要求**：DSH ≥ 0.1.1-rc.1（`package.json` 的 `dsh.engines` 已声明）。

### 方式一：`dsh plugin`（推荐，自动加入 bundles 列表）

需要本机有 `pnpm`（在 PATH 中）：

```powershell
# 从 GitHub 仓库安装
dsh plugin --profile web add "git+https://github.com/user-Mrz/dsh-token-usage-hud.git"

# 或克隆到本地后按路径安装
git clone https://github.com/user-Mrz/dsh-token-usage-hud.git
dsh plugin --profile web add "C:\path\to\dsh-token-usage-hud"
```

本插件**零运行时依赖、无构建步骤**，git 安装无需 `pnpm-workspace.yaml`
的 `allowBuilds` 配置。安装完成后 `dsh plugin` 会自动把包名写进
`dsh.profile.bundles`。

### 方式二：手工编辑 `%USERPROFILE%\.dsh\profiles\web\package.json`

```json
{
  "dependencies": {
    "dsh-token-usage-hud": "git+https://github.com/user-Mrz/dsh-token-usage-hud.git"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@linxin666/dsh-web-ui-all",
        "dsh-token-usage-hud"
      ]
    }
  }
}
```

然后在 profile 目录 `pnpm install`（或把包目录放入
`%USERPROFILE%\.dsh\profiles\web\node_modules\`，hoisted 布局，junction 亦可）。

**两种方式都需要重启 `dsh web`**——loader 与 client-module 图只在启动时组合。

### 卸载

```powershell
dsh plugin --profile web remove dsh-token-usage-hud
# 然后重启 dsh web
```

## 配置

在 profile 的 `cordis.patch.yml` 中按行 id 覆盖（或直接改本包的
`cordis.patch.yml`）：

```yaml
- id: dsh-token-usage-hud
  config:
    enabled: true          # host 端开关
    currency: CNY          # CNY | USD
    pollMs: 1500           # 客户端轮询间隔(ms)，>=300
    position: top-right    # top-right | top-center | bottom-right
    visible: true          # 初始是否显示悬浮框
    balance:
      enabled: true        # 账户余额显示开关
      refreshMs: 30000     # 余额缓存/刷新间隔(ms)，>=5000
      apiKeyEnv: DEEPSEEK_API_KEY   # credentials 凭据引用（默认即此值）
      baseURL: https://api.deepseek.com
    prices:
      # 双档：高峰/空闲分别计价（官方 V4 价格，见下节）
      deepseek-v4-flash:
        peak:    { input: 3.0, cacheRead: 0.10, cacheWrite: 3.0, output: 9.0 }
        offpeak: { input: 1.5, cacheRead: 0.05, cacheWrite: 1.5, output: 4.5 }
      # 单档：两时段同价（旧模型兼容写法）
      deepseek-chat: { input: 2, cacheRead: 0.5, cacheWrite: 2, output: 8 }
```

`prices` 的单位为「每百万 tokens」；key 为模型 id，`default` 兜底未知模型。
每步消耗按**该步完成时的北京时间**判定高峰/空闲并计价（不是按查询时刻）。

余额通过 DSH 的 credentials 服务解析（env 继承 → `~/.dsh/.credentials.yaml`，
与 web「模型」页写入口一致），**Key 只在 host 端用于调用 DeepSeek
`GET /user/balance`，绝不随 HTTP 响应下发到浏览器**；接口本身仅回传余额数字。
若未配置 Key，悬浮框显示「余额 获取失败」。

## 官方定价（DeepSeek V4，¥/百万 tokens）

来源：[DeepSeek API 文档 · 模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)
（空闲时段价格为高峰时段价格的一半；高峰时段为北京时间周一至周五
09:00–12:00、14:00–18:00，其余为空闲时段。）

| 模型 | 输入·缓存未命中 空闲/高峰 | 输入·缓存命中 空闲/高峰 | 输出 空闲/高峰 |
| --- | --- | --- | --- |
| deepseek-v4-flash | 1.5 / 3.0 | 0.05 / 0.10 | 4.5 / 9.0 |
| deepseek-v4-pro | 4.5 / 9.0 | 0.15 / 0.30 | 13.5 / 27.0 |
| deepseek-v4-flash-vision-exp | 1.5 / 3.0 | 0.05 / 0.10 | 4.5 / 9.0 |

DeepSeek 无独立「缓存写入」计费项，故 `cacheWrite` 默认按「输入·缓存未命中」
价计（V4 场景下 provider 不上报该桶，实际不影响结果）。悬浮框费用行会标注
当前时段：`[deepseek-v4-flash · 高峰]` 或 `[空闲]`。

## 说明与限制

- 费用为**估算值**：单价表需与你的实际计费口径一致（可在配置中调整）；模型
  切换会按各自单价分桶计费，历史步骤按其发生时段（高峰/空闲）精确计价。
- token 数为 provider 上报的真实用量（输入/缓存读/缓存写/输出），与
  dsh-token-meter 的 `tokenUsage` 口径一致；`reasoningTokens` 是输出子项，不
  重复累加。
- 接口仅允许本机回环访问（与 dsh-perf 相同的防护）。
- **隐私**：插件不读写任何 API Key / 凭据 / 设置文件；浏览器端仅向本机
  loopback 接口发送当前会话 id；localStorage 只存显隐与拖拽坐标两个 UI 键。
- **移植性**：插件只用 DSH 标准服务（`sessions` / `webServer` /
  可选的 `sessionProjections`），任何标准 web profile 均可安装；“上下文占用”
  一行依赖 token-meter 注册的 `contextPressure` 投影（dsh-base 默认包含）。

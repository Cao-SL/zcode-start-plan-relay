# zcode-start-plan-relay

[English](README.md) | 简体中文 | [日本語](README.ja.md)

把 ZCode（Z.ai 的桌面编程 agent）内置的免费 **Start Plan** 反代成标准的
**Anthropic Messages 兼容接口**，给 [magpie](https://github.com/yetone/magpie)、
Claude Code、Codex 或任何能填 base URL 的 agent 使用。
单文件、零依赖、Node 18+、跨平台。

> ⚠️ **仅限使用自己的账号与额度。** 本项目与 Z.ai / 智谱 / ZCode 官方无任何关联；
> 是否违反其服务条款请自行评估，风控规则可能随时变化，本项目不保证持续可用。

```
你的 agent ──► 反代 (127.0.0.1:8791) ──► https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
                    │
                    └─ 每次调用都从 ZCode 自己的凭据库现解密活体登录令牌，
                       并把请求重构成网关接受的形状
```

---

## 背景：Start Plan 为什么不能直接用

ZCode 登录后内置几个"账号型"提供商，其中 **Start Plan** 是促销型计划
（`billing/current` 报告 `zcode-v3-start-plan-referral`，名称 "ZCode Global
Build"）。它的真实上游是：

```
POST https://zcode.z.ai/api/v1/zcode-plan/anthropic/v1/messages
```

自己拿令牌去调会被拒——有两道门。

### 门 1：令牌是加密的，而且明文副本是过期的

- 活令牌是 `~/.zcode/v2/credentials.json` 里的 `zcodejwttoken`，存储格式为
  `enc:v1:<iv>.<tag>.<data>`（base64url）。算法 **AES-256-GCM**，
  key = `sha256(secret)`，secret 是 `ZCODE_CREDENTIAL_SECRET` 或回退串
  `zcode-credential-fallback:<platform>:<homedir>:<username>`。
- `~/.zcode/v2/config.json` 里 `builtin:bigmodel-start-plan.options.apiKey`
  的明文 JWT 是历史遗留副本：实测 401 被拒，解密出的活令牌才被接受。
- ZCode 自身的请求签名层（`X-Client-Sig` / `X-Client-Pow` / …）对 Start Plan
  **不参与**：ZCode 自己的日志记录 `model.client_signing.unsigned_sent`、
  原因 `access_mode`。

### 门 2：请求必须"长得像 ZCode"

拿*有效*令牌发最小请求，会被边缘拦截：

```
HTTP 405 {"code":3012,"msg":"request has been blocked due to unusual activity."}
```

受控实验（同一个有效令牌，每次只改一处）得到如下规则：

| 请求体 | 结果 |
|---|---|
| 只有 `messages` | **拦截（3012）** |
| `messages` + 小 system | **拦截（3012）** |
| `messages` + ZCode 真实的 55 个 tools，无 system | **拦截（3012）** |
| 真实 tools + **ZCode 自己的 system 前言** | **200（SSE 正常）** |
| 同上，追加 / 删除一个 tool | 200 |
| 同上，前言里的 cwd/session 文字改写 | 200 |
| `system` 只留第 1 块 | **拦截（3012）** |
| `system` 保留前两块 | 200 |
| 调用方自己的 system **作为额外一块追加** | 200（且实测会生效） |
| 把文字**追加进第 1 块** | **拦截（3012）** |

一句话：**必须带 ZCode system 前言的前两块（第 1 块必须原样）**；tools、
messages、额外的 system 块都是自由的。

### 反代做了什么

1. 每次调用现解密 `credentials.json` 里的活令牌（按 mtime 缓存）；吃到 401 会
   强制重载一次并重放——所以 ZCode 换账号 / 重新登录**不需要重启任何东西**。
2. 用 ZCode 的前两块前言充当 `system`。前言**不随本仓库分发**（那是 Z.ai 的
   提示词）：首次启动时反代从本机 ZCode 的 model-io 日志
   （`~/.zcode/cli/rollout/model-io-*.jsonl`）里提取，缓存到脚本旁。
3. 调用方自己的 system 提示词作为额外一块附上；若该形状被边缘拒绝，自动退回
   "并入首条 user 消息"的形态再试一次。
4. `model` 映射：计划只开放 `GLM-5.3` 和 `GLM-5.3-Flash`，其余模型名（比如
   Claude 系列）落到默认模型。
5. 补齐 ZCode 的客户端请求头（`user-agent: ZCode/3.16.3`、`x-zcode-agent:
   glm`、`x-zcode-app-version` 等）。
6. SSE 与非流式原样透传，tool 调用可用。

## 快速开始

前置条件：

- ZCode 已登录，且账号确实有 Start Plan（`~/.zcode/v2/coding-plan-cache.json`
  中对应条目为 `available`）；
- **至少在 ZCode 里用 Start Plan 模型发过一条消息**（ZCode 会写 model-io
  日志，前言从这里提取）；
- Node 18+。

```bash
node zcode-plan-relay.js
# listening on http://127.0.0.1:8791
curl http://127.0.0.1:8791/health
```

Windows 便捷脚本（后台启动并打印健康状态）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\start-windows.ps1
```

首次启动应看到 `preamble extracted from model-io-….jsonl` —— 脚本旁会生成
`zcode-plan-preamble.json`（已 git-ignore；不要分发它）。

### 接入 magpie

```bash
magpie provider add "ZCode Start Plan" \
  anthropic=http://127.0.0.1:8791 key=zcode-plan models=GLM-5.3,GLM-5.3-Flash
magpie claude zcode-start-plan/GLM-5.3
```

### 直接给任何 agent

```sh
export ANTHROPIC_BASE_URL=http://127.0.0.1:8791
export ANTHROPIC_API_KEY=whatever          # 未设置 ZCODE_PLAN_KEY 时反代不校验
```

（OpenAI 形状的调用方：让它指向装有本 provider 的 magpie 网关即可——magpie
会在 API 间翻译；或自接转换层。）

### 共享到局域网 / 给远程 magpie

直接暴露反代：

```bash
HOST=0.0.0.0 ZCODE_PLAN_KEY=<长口令> node zcode-plan-relay.js
```

或者共享整台 magpie（远程会拿到本机全部 provider、账号和路由组；模型 id 形如
`office/zcode-start-plan/GLM-5.3`）：

```bash
# 本机
magpie gateway-key add "remote"            # 打印 sk-magpie-key-…，只显示一次
MAGPIE_ADDR=0.0.0.0:3425 magpie serve
# 远程那台
magpie provider add remote-magpie sk-magpie-key-… url=http://<本机IP>:3425 id=office
magpie claude office/zcode-start-plan/GLM-5.3
```

## 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/messages`（也收 `/messages`） | Anthropic Messages，流式 / 非流式 |
| GET | `/v1/models` | 模型清单（magpie 从这里填充目录） |
| GET | `/health` | 令牌状态、user id、模型列表 |

## 配置（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` / `HOST` | `8791` / `127.0.0.1` | 监听端口 / 地址 |
| `ZCODE_PLAN_MODEL` | `GLM-5.3-Flash` | 未知模型名的落点 |
| `ZCODE_PLAN_KEY` | 空 | 非空则要求调用方携带（`Authorization: Bearer` 或 `x-api-key`）；绑定到局域网时务必设置 |
| `ZCODE_PLAN_UPSTREAM` | `https://zcode.z.ai` | 上游源 |
| `ZCODE_PLAN_PREAMBLE` | 脚本旁 `zcode-plan-preamble.json` | 前言缓存位置 |
| `ZCODE_PLAN_ROLLOUT` | `~/.zcode/cli/rollout` | 提取前言时扫描的日志目录 |
| `ZCODE_PLAN_LOG` | `%TEMP%\zcode-plan-relay.log` | 日志文件 |
| `ZCODE_PLAN_VERBOSE` | 关 | 设 `1` 同时输出到 stdout |
| `ZCODE_CREDENTIAL_SECRET` | 回退字符串 | ZCode 凭据加密密钥（一般不用设） |

## 限制与已知问题

- 计划只放行 `GLM-5.3` 和 `GLM-5.3-Flash`；其它模型名上游直接拒绝
  （`3006 model not allowed`）或落到默认模型。
- system 主导权在 ZCode 那边：它的前言永远在，调用方指令是后加的一块
  （实测能压住，但毕竟不是原生 system 角色）。
- 额度算在你自己的 Start Plan 上——促销型计划，有有效期和限量。
- 门 2 是行为风控而非固定校验；Z.ai 随时可能调整，反代可能随之失效。
- 反代会保留调用方的 `tools` 与对话内容，但总是补上与 ZCode 自身请求一致的
  `thinking` / `output_config` 默认值。

## 排错

| 现象 | 处理 |
|---|---|
| `/health` 显示 `token.ok: false` | ZCode 未登录 / 凭据文件缺失——先在 ZCode 里登录 |
| 启动日志 `preamble not extracted` | 先在 ZCode 里用 Start Plan 发一条消息，再重启反代 |
| `upstream 405 … 3012` | 形状被风控：多半是前言文件被改坏（第 1 块必须原样） |
| `upstream 400 … model not allowed` | 请求了计划外的模型 |
| 连续 401 | 令牌确实失效：在 ZCode 里重新登录，反代自动重读 |

## 逆向过程（简述）

1. 静态分析 ZCode 打包的 CLI（`resources/glm/zcode.cjs`）：计划端点常量、凭据
   加密实现（`createZCodeCredentialCipher`）、客户端签名层及其对本计划的
   `access_mode` 跳过逻辑；
2. ZCode 自己的 model-io rollout 日志（`~/.zcode/cli/rollout/*.jsonl`）：真实
   请求的完整形状（认证头被 ZCode 自身脱敏，其余原样保留）；
3. 对上游做受控实验（同一个有效令牌，逐项增减请求成分）→ 上面的门槛矩阵；
4. magpie 侧读其开源文档与源码，确认消费端用到的 custom provider
   （`anthropic=`）与 Remote magpie 机制。

## 仓库结构

| 路径 | 用途 |
|---|---|
| `zcode-plan-relay.js` | 反代本体（单文件、零依赖） |
| `scripts/start-windows.ps1` | Windows 后台启动并打印健康状态 |
| `zcode-plan-preamble.json` | 首次启动时本地生成——**不要提交、不要分发** |

## License

[MIT](LICENSE)

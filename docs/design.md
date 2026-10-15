# Tako 设计说明

这份文档回答三个问题：清单怎么写、命令怎么设计、适配器怎么扩展。

---

## 一、清单规格（tako.json）

顶层字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `$schema` | 否 | 指向 `schema/tako.schema.json`，编辑器据此补全与校验 |
| `tako` | 是 | 格式版本，固定为 `1` |
| `project` | 是 | 项目标识，小写字母数字与连字符 |
| `description` | 否 | 项目说明 |
| `defaults` | 否 | 对所有动词生效的默认值：`risk` / `timeoutMs` / `arm` |
| `arms` | 是 | 连接列表，至少一条 |
| `verbs` | 是 | 动词列表，至少一条 |

### 连接（arm）

> 术语说明：字段名沿用英文 `arms`；中文一律叫「连接」，不用「腕」。
> 意象词（章鱼的腕）只出现在 README 首屏，不进功能语境 —— 功能位需要零推理的词。

```json
{
  "name": "internal",
  "adapter": "http",
  "baseUrl": "https://api.example.com",
  "description": "需要令牌的内部平台",
  "auth": { "type": "bearer", "tokenEnv": "DEMO_TOKEN" }
}
```

- `adapter`：`http` | `script` | `browser`
- `baseUrl`：仅 `http` 需要，支持 `${ENV_VAR}` 插值
- `auth.type`：`none` | `bearer` | `header` | `cookie` | `basic`
- `auth.tokenEnv`：令牌所在的环境变量名 —— **清单里永远不出现令牌本身**
- `auth.prefix`：令牌前缀，默认 `Bearer`
- `auth.header`：`type=header` 时使用的请求头名

### 动词（verb）

```json
{
  "name": "user.fetch",
  "arm": "internal",
  "description": "按 ID 查询用户",
  "aiExample": "当用户问「查一下这个人」并给出 ID 时调用。",
  "risk": "read",
  "idempotent": true,
  "timeoutMs": 10000,
  "tags": ["user"],
  "action": { "method": "GET", "path": "/users/:id" },
  "params": [
    { "name": "id", "in": "path", "type": "string", "required": true, "description": "用户 ID" }
  ]
}
```

- `name`：即命令名，允许 `a-z0-9._-`
- `risk`：`read` | `write` | `destructive`，缺省继承 `defaults.risk`，再缺省为 `read`
- `idempotent`：缺省时 `risk === 'read'` 即为 true；为 true 时 Agent 可安全重试
- `aiExample`：**自动路由的关键字段**。它描述的是「什么语境下该调用」，不是「这条能力做什么」
- `action`：
  - `method`：GET / POST / PUT / PATCH / DELETE / HEAD
  - `path`：支持 `:name` 与 `{name}` 占位符，由 `in=path` 的参数填充
  - `headers`：静态请求头
  - `script`：`script` 适配器的入口，相对清单目录
  - `flow`：`browser` 适配器的声明式操作序列标识

### 参数（param）

| 字段 | 说明 |
|---|---|
| `name` | 参数名，命令行里即 `--name` |
| `type` | `string` / `number` / `boolean` / `object` / `array` |
| `in` | `query` / `path` / `body` / `header` / `arg`；缺省时 http 为 `query`，script 为 `arg` |
| `required` | 必填；**与 `default` 互斥**（同时声明会被校验拒绝） |
| `default` | 缺省值 |
| `enum` | 取值白名单，GUI 会渲染成下拉框 |
| `secret` | 为 true 时从 `TAKO_SECRET_<NAME>` 读取，且输出中脱敏 |
| `description` | 面向人和 Agent 的说明 |
| `example` | 示例值，GUI 用作占位符 |

### 请求体拼装规则

- `in=body` 的参数有 **1 个** → 该值直接作为请求体
- `in=body` 的参数有 **多个** → 拼成一个对象

---

## 二、CLI 设计

### 命令面（刻意极窄，但不止六个）

**能力面** —— 命令只有一个 `run`，具体能力由清单提供：

```
tako ls [--arm <name>] [--risk <level>] [--json]
tako describe <verb> [--json]
tako run <verb> [--参数 值] [--dry-run] [--yes] [--json] [--verbose]
tako tools [--json]
tako schema
tako doctor
```

**平台面** —— 与「清单里有哪些能力」无关的固定动作：

```
tako context / integrate      把清单交给 Agent（hook / AGENTS.md）
tako ask                      本地意图匹配（best-effort，不引 LLM）
tako capture                  录制网页操作，反推 http 动词
tako verify                   能力能不能真跑（静态默认零副作用）
tako push / add --from …      能力仓库（git 即仓库，含审核元数据）
tako console / init / add     本地界面、脚手架、能力包
```

判据没有变：**能力本身永远不注册成命令**。平台面每个命令的行为都不随清单里的动词数量变化，
所以 CLI 的复杂度仍然是常数级。多出来的这些不是「第七个 run」，而是「谁来装、谁来验、谁来看」。

### 参数解析规则

- `--name value` 与 `--name=value` 等价
- 布尔参数可省略值：`--flag` 即 true，`--no-flag` 即 false
- 保留字不可被参数占用：`json` / `dry-run` / `yes` / `verbose` / `file` / `help` / `version` / `arm` / `risk`
- 传入未在清单中声明的参数会报错，并列出该能力支持的参数（不做静默忽略——静默忽略是 Agent 最隐蔽的故障源）

### 退出码约定

| 码 | 含义 |
|---|---|
| 0 | 成功 |
| 1 | 运行时失败（网络、鉴权、HTTP 非 2xx） |
| 2 | 用法错误或清单非法 |
| 3 | 危险操作被风险闸门拦截 |

### 输出约定

- `--json` 时 stdout **只有 JSON**，日志一律走 stderr。这保证 `| jq` 和 Agent 解析永远可靠。
- 非 `--json` 时输出面向人：表格对齐、风险徽章着色、`NO_COLOR` 时降级为纯文本。

---

## 三、适配器接口

适配器是一个实现 `Adapter` 接口的对象（定义见 `src/types.ts`）。加一种执行方式 = 加一个对象，不需要改动别处。

```ts
import type { Adapter, HttpPlan, AdapterResult } from '@hun-dun/tako';

const myAdapter: Adapter = {
  /** 只读：算出「将要发生什么」，供 --dry-run 使用 */
  plan({ manifest, arm, verb, values }): HttpPlan {
    return { kind: 'http', method: 'GET', url: '...', headers: {} };
  },

  /** 有副作用：真正执行 */
  async invoke({ manifest, arm, verb, values, log }): Promise<AdapterResult> {
    return { data: /* 任意可 JSON 序列化的结果 */ };
  },
};
```

约定：

1. **`plan` 必须无副作用、可 JSON 序列化**，否则 `--dry-run` 就失去意义。
2. **`invoke` 只返回 `data`**，外层会自动补上 `ok` / `durationMs` / `plan` 等元信息。
3. **凭证只在适配器内部解析**。清单里声明「去哪取」，适配器负责「怎么用」。
4. 失败时抛 `TakoError(message, code)`，退出码由 `code` 决定。

### 内置适配器

| 适配器 | 状态 | 说明 |
|---|---|---|
| `http` | 已实现 | 基于全局 `fetch`，支持 query / path / body / header 四类参数、超时、鉴权注入、非 2xx 转错误 |
| `script` | 已实现 | 动态 import 本地 ESM 脚本，`default export` 实现 `ScriptEntry`，收到 `ScriptContext` = `{ params, verb, log, readFile }` |
| `browser` | 已实现（驱动插件化） | 声明式 `action.steps` 网页操作序列，由驱动插件执行；核心只负责解析步骤、替换参数、托管鉴权与查找驱动。未安装插件时不静默失败，而是列出**依次找过哪些位置**。官方驱动在 `adapters/browser/`（Playwright 实现，含 `capture` 抓包）<br/>为什么插件化：Node 20 无内置 `WebSocket`，零依赖 CDP 需自写帧协议（数百行安全敏感代码），会打破「运行时依赖为 0」 |

---

## 四、校验策略

`tako doctor` 与 `tako run` 都会走同一套校验，问题一次性全部列出，而不是逐个报错：

**结构性校验**（阻断执行）
- 格式版本、必填字段、名称唯一性
- `verb.arm` 必须指向存在的连接
- `action.path` 与 `action.script` 至少有一个
- 参数不得同时声明 `required` 与 `default`

**环境校验**（提示，不阻断只读能力）
- `auth.tokenEnv` 对应的环境变量是否已设置
- `script` 适配器的脚本文件是否存在
- `browser` 适配器是否缺少插件
- 动词是否缺少 `description` 或 `aiExample`（缺了 Agent 就选不准）

---

## 五、扩展点

想加一个新的执行方式（gRPC、数据库、消息队列、SSH……），只需要实现一个 `Adapter` 并注册，清单层、CLI 层、Agent 层都不用动。这是 Tako 作为「平台」而非「工具」的关键：**能力的表达方式与能力的执行方式解耦。**

连接的 `adapter` 字段决定用哪个适配器；同一个连接下的所有动词共享它的地址与鉴权。

---

## 六、类型契约

`src/types.ts` 是唯一的数据形状来源。三条规则：

1. **清单的原始输入视为不可信**。`JSON.parse` 的结果只做形状描述，真正的把关是 `normalize()` 里的显式校验——非法值被收集成问题清单一次性抛出，而不是中途崩掉。
2. **归一化之后的可选字段全部补齐**。`Manifest` / `Verb` / `Param` 里的字段没有 `?`，投影层不需要到处写 `?? default`。
3. **投影层是纯函数**。`toCliUsage` / `toFormSpec` / `toToolSpecs` 只做形状转换，不读文件、不读环境、不产生副作用，因此可以直接被未来的控制台 import。

---

## 七、构建与发布

**只用 `tsc`，不引入打包器。**

| 方案 | 结论 |
|---|---|
| `tsc` | ✅ 采用。只做 TS→JS，零额外依赖，产物可读、栈追踪准确 |
| `vite` | ❌ 前端打包器。不理解 Node 内置模块外部化 / `bin` / shebang；`--ssr` 是给 SSR 应用准备的 |
| `tsup` / `esbuild` | 🟡 本项目运行时依赖为 0，打包只换来更差的调试体验 |
| `bun build` / `deno compile` | ❌ 把运行时绑进产物，对 npm 包是反向的 |

关键配置：

- `module` / `moduleResolution` = `NodeNext`：输出 ESM，相对导入必须带 `.js` 后缀（写 `./types.js`，实际文件是 `types.ts`）
- `strict` + `verbatimModuleSyntax`：类型导入必须显式写 `import type`，避免运行时残留
- `declaration` + `sourceMap`：发布后用户能跳转到源码
- shebang 保留：`cli.ts` 首行的 `#!/usr/bin/env node` 会被 `tsc` 原样带进 `dist/cli.js`
- build 末尾补 `chmod 755`：让 `npm link` 后可以直接 `./dist/cli.js` 执行（npm 安装时会自己设置 bin 权限）

`prepare` 钩子绑定 `npm run build`，因此 git 安装和本地 `npm install` 都会自动产出 `dist/`。

Vite 的归属在**可视化控制台**（未来的 `console/`）：那才是浏览器应用，且可以直接 `import { loadManifest, toFormSpec } from '@hun-dun/tako'`，与 CLI 共用同一份清单投影逻辑。

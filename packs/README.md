# 能力包（packs）

能力包是**纯数据 + 自包含脚本**，不是插件、不写 TypeScript、不改核心代码。

## 为什么能力包不进核心

Tako 的全部主张是「能力即数据，不是代码」。如果加一条文生图或 PPT 能力需要改 `src/`，这个主张就自相矛盾了。

更实际的理由：

| 把能力内置进核心 | 做成能力包 |
|---|---|
| 依赖爆炸（图像 SDK、pptx 库…） | 核心保持运行时零依赖，`npx` 秒起 |
| 认证冲突（各家 key 各不相同） | 令牌照样走 `auth.tokenEnv`，与连接的模型天然一致 |
| 发布节奏被业务拖着走 | 能力可以单独迭代，核心稳定 |

判据很简单：**加一个能力如果需要改 `src/`，说明抽象漏了；只改 `tako.json` + 脚本，才是对的。**

## 内置包

| 包 | 能力 | 说明 |
|---|---|---|
| `dev` | `git.recent`、`todo.scan` | 纯本地，不需要网络与令牌 |
| `office` | `image.generate`、`deck.html` | 文生图走接口（需令牌）；演示文稿本机生成 |

```bash
tako add --list        # 查看可用包
tako add dev           # 装上研发包
tako add office        # 装上办公包
```

装上之后：

- 清单（`tako.json`）里会多出对应的 `arms` 与 `verbs`
- 脚本被拷贝到 `<项目>/tako-packs/<包名>/`，路径同步改写
- **项目变自包含**：不依赖 npm 包的安装位置，可以直接提交到 git

## 目录约定

```
packs/dev/
├── tako.json            # arms + verbs 声明（与普通清单同构）
└── scripts/             # 会被整体拷进项目
    ├── git-recent.mjs
    └── todo-scan.mjs
```

清单里脚本路径写成 `./scripts/xxx.mjs`（相对包目录）。`tako add` 会自动改写成 `./tako-packs/<包名>/scripts/xxx.mjs`。

## 冲突规则

| 情况 | 行为 |
|---|---|
| arm 同名且 adapter 相同 | 视为同一个连接，跳过 |
| arm 同名但 adapter 不同 | 冲突，需 `--force` |
| verb 同名 | 冲突，需 `--force` |
| `tako-packs/<包名>/` 已存在 | 默认不覆盖脚本，`--force` 才覆盖 |

## 写一个自己的包

```
my-pack/
├── tako.json
└── scripts/
    └── do-something.mjs
```

`tako.json` 与普通清单完全同构（`arms` + `verbs`），脚本遵守 `ScriptContext` 约定：

```js
export default function doSomething({ params, verb, root, log, readFile }) {
  log(`root = ${root}`);        // 项目根目录，别用 process.cwd()
  return { ok: true };          // 返回值会被 tako run 打印
}
```

然后从任意目录装入别人的项目：

```bash
tako add my-pack --from /path/to/packs
```

## 想加但还没做的能力

这些能力**不需要改核心**，谁都可以做成包贡献回来：

- 真 `.pptx` 输出（把 `deck.html` 的脚本换成调用 pptx 库即可）
- 会议纪要 / 周报生成
- 数据库只读查询（`adapter: script` 包一层客户端）
- 各类内部平台操作（`adapter: http` + `auth.tokenEnv`）

# ligule

[![npm](https://img.shields.io/npm/v/ligule?label=npm&color=4d6bfe)](https://www.npmjs.com/package/ligule)
[![node](https://img.shields.io/static/v1?label=node&message=%3E%3D20&color=339933&logo=node.js&logoColor=white)](https://nodejs.org)
[![license](https://img.shields.io/badge/license-MIT-22c55e.svg)](./LICENSE)

**开发中。这一版是占位发布**，把仓库、npm 包名和许可先占下来；行为尚未定型，不要依赖它。

`ligule` 读 /ˈlɪɡjuːl/。拉丁语 *ligula*「小舌头」，是禾本科植物叶鞘与叶片交界处、环抱茎的那层膜——包裹层与执行层之间的接口与边界，就是这个名字要指的东西。

## 现在有什么

一个内核对象，工具表是空的：

```js
import { createKernel } from 'ligule'

const kernel = createKernel()
kernel.list()                                        // [] 内核自己不提供任何工具
const dispose = kernel.register({ name: 'read', run: async (args) => '...' })
await kernel.call('read', args)
dispose()
```

三条已经写死的规则：

- **内核不提供任何工具**，全新构造后工具表为空。一切能力由 `register()` 装进来。
- 重名注册**抛错而不是静默丢弃**；`register()` 返回反注册函数。
- 失败一律带稳定错误码（`KernelError#code`）：`tool_name_required`、`tool_run_required`、`tool_already_registered`、`tool_not_found`。

命令行目前只做三件事：`ligule --version` 打印版本、`ligule tools` 列出已注册工具（现在是空的）、其它参数打印一行开发中。

## 状态

未完成。工具集、权限判定链、传输层、会话记录都还没做，接口随时会变。

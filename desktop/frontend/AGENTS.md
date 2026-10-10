# Desktop frontend

`desktop/frontend/` 是 Vite、React 与 TypeScript 前端。仓库根指南和 [../AGENTS.md](../AGENTS.md) 同时适用；本文件只规定前端与 Host、壳之间的职责边界。

- 界面经 `src/protocol.ts` 收发 Host 帧。业务操作交给 Host；前端不读写会话文件，也不自行执行工具或模型请求。`src/main.tsx` 允许检查页面注入 `window.__LIGULE_TRANSPORT__`，正常桌面运行使用 Tauri 载体。
- 新增可插拔界面内容时，在 `src/slots.ts` 注册槽位；不让壳识别界面内容或插件名称。
- 会话记录由 Host 持有。转录按页读取并使用 `react-virtuoso` 渲染；投影行保留来源事件的 `seq`，供搜索定位和会话内跳转使用。前端生成的状态行没有记录事件编号。
- 请求、审批、提问、取消和状态都绑定发起它们的会话或请求标识。后台会话完成一轮不得发送当前会话的队列文本；界面不得把一份会话的审批或提问交给另一份会话处理。`question.request` 独立于审批；无人回答的题目应明确显示未回答。
- 草稿、队列、界面偏好由 Host 通过 `prefs.read`、`prefs.write` 读写数据根下的桌面偏好文档。WebView 的 `ligule.ui` 作首屏缓存；数据根文档为空时，已有缓存可能提交一次。当前完整恢复流程尚未验证。输入历史使用共享 Host 接口，不能另存一份前端历史。
- 配置编辑经 Host 的 `config.get`、`config.set` 完成，并携带读取到的版本与写入层。界面不得直接改配置文件；未保存内容或进行中的保存必须经过 `src/edit-gate.ts` 的离开确认。
- 按键判断集中在 `src/hotkeys.ts`；输入法组合期间不得触发发送、历史导航、关闭面板或取消操作。
- 文件保存对话框由壳提供。前端只使用 `@tauri-apps/plugin-dialog` 的保存权限，并把用户选择的目标交给 Host 导出；不得另开文件系统访问能力。
- 前端依赖和命令维护在本目录的 `package.json`。运行 `npm --prefix desktop/frontend run check` 检查投影、协议、按键、退出和编辑门控，再运行 TypeScript 与 Vite 构建。
- `react-virtuoso`、`radix-ui`、`lucide-react` 和 `@tauri-apps/plugin-dialog` 的版本由前端清单固定；前端锁文件与清单保持一致。

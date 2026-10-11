# Desktop frontend

`desktop/frontend/` 是 Vite、React 与 TypeScript 前端。仓库根指南和 [../AGENTS.md](../AGENTS.md) 同时适用；本文件只规定前端与 Host、壳之间的职责边界。

- 界面经 `src/protocol.ts` 收发 Host 帧。业务操作交给 Host；前端不读写会话文件，也不自行执行工具或模型请求。`src/main.tsx` 允许检查页面注入 `window.__LIGULE_TRANSPORT__`，正常桌面运行使用 Tauri 载体。
- 新增可插拔界面内容时，在 `src/slots.ts` 注册槽位；不让壳识别界面内容或插件名称。
- 会话记录由 Host 持有。转录按页读取并使用 `react-virtuoso` 渲染；投影行保留来源事件的 `seq`，供搜索定位和会话内跳转使用。前端生成的状态行没有记录事件编号。
- 请求、审批、提问、取消和状态都绑定发起它们的会话或请求标识。后台会话完成一轮不得发送当前会话的队列文本；界面不得把一份会话的审批或提问交给另一份会话处理。`question.request` 独立于审批；无人回答的题目应明确显示未回答。
- 草稿、队列、界面偏好由 Host 通过 `prefs.read`、`prefs.write` 读写数据根下的桌面偏好文档。WebView 的 `ligule.ui` 作首屏缓存；只有数据根文档不存在时才迁移缓存。读写携带文档版本，读取失败停止保存，冲突停止自动覆盖。输入历史使用共享 Host 接口，不能另存一份前端历史。
- 通知由前端管理状态和偏好，并通过 `@tauri-apps/plugin-notification` 查询和请求系统权限；Tauri 壳调用 `tauri-plugin-notification` 与 `notify-rust` 显示系统通知并接收点击。五类通知分别对应提问、审批、完成、失败和断连。通知目标只携带会话标识和工作区路径，不包含提示词或工具正文；通知点击通过 Host 定位会话。系统托盘状态由前端提交给壳更新。
- 界面语言使用双语系统元信息；会话正文、工具输出与用户输入保持原样，不作自动翻译。显示详细度 `brief` 隐藏推理、工具调用、工具结果和上下文行，`standard` 隐藏推理和上下文行；两档均隐藏每轮参数记录。
- 配置编辑经 Host 的 `config.get`、`config.set` 完成，并携带读取到的版本与写入层。界面不得直接改配置文件；未保存内容或进行中的保存必须经过 `src/edit-gate.ts` 的离开确认。
- 按键判断集中在 `src/hotkeys.ts`；输入法组合期间不得触发发送、历史导航、关闭面板或取消操作。
- 文件保存对话框由壳提供。前端只使用 `@tauri-apps/plugin-dialog` 的保存权限，并把用户选择的目标交给 Host 导出；不得另开文件系统访问能力。
- 前端依赖和命令维护在本目录的 `package.json`。运行 `npm --prefix desktop/frontend run check` 检查投影、协议、按键、退出、编辑门控和通知，再运行 TypeScript 与 Vite 构建。
- `react-virtuoso`、`radix-ui`、`lucide-react` 和 `@tauri-apps/plugin-dialog` 的版本由前端清单固定；前端锁文件与清单保持一致。
- 通知依赖 `@tauri-apps/plugin-notification` 2.5.1、`tauri-plugin-notification` 2.5.1 和 `notify-rust` 4.18.2；版本由前端与 Rust 清单固定。

// Vite 的 `?raw` 导入：构建时把仓库内那两份手册的正文并进界面产物。
declare module '*.md?raw' {
  const content: string;
  export default content;
}

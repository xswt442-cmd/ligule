// 配置装载侧（D8）：读三层文件与命令行的点号路径，交出 createConfig 要的层对象。
// 用户层是 ~/.ligule/config.toml，项目层是 <项目根>/.ligule/config.toml，本地层是同目录下的 config.local.toml。
// 管理端那一层暂不读：D8 定了五层，装载侧先读三层，管理端的路径按平台分，等有使用者再接。
// 凭据不从文件读（D13）：这三份文件里的每一个键都会进只读快照，工具都读得到，所以秘密只走环境变量。
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { parse } from 'smol-toml';
import { mergeInto } from './config.js';
import { KernelError } from './error.js';

export const CONFIG_DIRECTORY = '.ligule';
export const CONFIG_FILE = 'config.toml';
export const LOCAL_CONFIG_FILE = 'config.local.toml';

// 项目根与用户主目录都由调用方给出：向上找根标记是项目指令装载那一步的事，这里不重复做一遍；
// 主目录可以换，绿色安装与测试都不必去改进程环境。
export function configPaths(projectRoot, userHome = homedir()) {
  if (typeof projectRoot !== 'string' || projectRoot === '') throw new KernelError('config_project_root_required');
  return {
    user: join(dataRoot(userHome), CONFIG_FILE),
    project: join(projectRoot, CONFIG_DIRECTORY, CONFIG_FILE),
    local: join(projectRoot, CONFIG_DIRECTORY, LOCAL_CONFIG_FILE),
  };
}

// 应用数据根只有这一个解析处（D110，方案 5.5.2）：`LIGULE_HOME` 指了就用那一格，没写就是 `<主目录>/.ligule`。
// 配置、模式、技能、提示模板、扩展、终端界面的历史与草稿都从这一处取，界面与工具不再各自拼一份。
// 空的那一格按没写处理：它不能被读成当前目录，否则同一份配置在两个目录下会写出两份东西。
// 相对写法直接拒掉，同一个理由。
export function dataRoot(home = homedir(), env = process.env) {
  const written = typeof env.LIGULE_HOME === 'string' ? env.LIGULE_HOME.trim() : '';
  if (written === '') return join(home, CONFIG_DIRECTORY);
  if (!isAbsolute(written)) {
    throw new KernelError('data_root_invalid', { detail: `LIGULE_HOME must name an absolute directory, got "${env.LIGULE_HOME}"` });
  }
  return written;
}

async function readLayer(path, layer) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    // 三层里任何一层都可以不存在，缺文件是正常状态。
    if (error.code === 'ENOENT') return {};
    throw new KernelError('config_file_read_failed', { cause: error, detail: `${layer}: ${path}` });
  }
  try {
    return parse(text);
  } catch (error) {
    // 解析失败当场报，并说清是哪一层的哪个文件：一份写坏的配置不该以「少了一层」的形式静默生效。
    throw new KernelError('config_file_invalid', { cause: error, detail: `${layer}: ${path}` });
  }
}

// 一条 `a.b=c` 当成一份只有一行的 TOML 文档来解析，值的类型由 TOML 定，不自己写一套类型推断。
// 多条覆盖之间按键合并，合并语义与层间合并是同一个函数。
export function flagLayer(flags) {
  const layer = {};
  for (const flag of flags) {
    let parsed;
    try {
      parsed = parse(flag);
    } catch (error) {
      throw new KernelError('config_flag_invalid', { cause: error, detail: flag });
    }
    mergeInto(layer, parsed);
  }
  return layer;
}

export async function loadConfigLayers({ projectRoot, userHome, flags = [] }) {
  const paths = configPaths(projectRoot, userHome);
  return {
    user: await readLayer(paths.user, 'user'),
    project: await readLayer(paths.project, 'project'),
    local: await readLayer(paths.local, 'local'),
    flag: flagLayer(flags),
  };
}

import { closeSync, fstatSync, openSync } from 'node:fs';
import { dirname, isAbsolute, parse, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { KernelError } from '../kernel/error.js';

type NativeFailureCode = 'EEXIST' | 'EXDEV' | 'EACCES' | 'EPERM' | 'EBUSY' | 'ENOENT' | 'ENOTSUP' | 'EIO';
type NativeHandle = number | bigint;

export interface RenameIdentity {
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
}

export interface RenameNoReplaceOptions {
  readonly sourceRoot: string;
  readonly destinationRoot: string;
  readonly expectedSource: RenameIdentity;
}

interface FileAttributeTagInfo {
  FileAttributes: number;
  ReparseTag: number;
}

interface FileTime {
  dwLowDateTime: number;
  dwHighDateTime: number;
}

interface ByHandleFileInformation {
  dwFileAttributes: number;
  ftCreationTime: FileTime;
  ftLastAccessTime: FileTime;
  ftLastWriteTime: FileTime;
  dwVolumeSerialNumber: number;
  nFileSizeHigh: number;
  nFileSizeLow: number;
  nNumberOfLinks: number;
  nFileIndexHigh: number;
  nFileIndexLow: number;
}

interface WindowsRenameApi {
  lastError(): number;
  createFile(path: string, access: number, share: number, security: unknown, disposition: number, flags: number, template: number): NativeHandle;
  getFileInformationEx(handle: NativeHandle, informationClass: number, information: FileAttributeTagInfo, size: number): number;
  getFileInformation(handle: NativeHandle, information: ByHandleFileInformation): number;
  renameByHandle(handle: NativeHandle, ioStatus: Buffer, information: Buffer, size: number, informationClass: number): number;
  getFinalPath(handle: NativeHandle, buffer: Buffer, capacity: number, flags: number): number;
  closeHandle(handle: NativeHandle): number;
  fileAttributeTagInfoSize: number;
  byHandleFileInformationSize: number;
}

interface LinuxOpenHow {
  flags: bigint;
  mode: bigint;
  resolve: bigint;
}

interface LinuxRenameApi {
  openAt2Syscall(number: number, directory: number, path: string, how: unknown, size: number): number;
  renameAt2(oldDirectory: number, source: string, newDirectory: number, destination: string, flags: number): number;
  close(fd: number): number;
  errno(): number;
  errnoNames: Record<string, number>;
  openHowType: any;
  openHowSize: number;
  allocate(type: any): unknown;
  encode(pointer: unknown, type: any, value: LinuxOpenHow): void;
  free(pointer: unknown): void;
}

const FILE_READ_ATTRIBUTES = 0x00000080;
const FILE_LIST_DIRECTORY = 0x00000001;
const FILE_TRAVERSE = 0x00000020;
const SYNCHRONIZE = 0x00100000;
const FILE_ADD_FILE = 0x00000002;
const FILE_ADD_SUBDIRECTORY = 0x00000004;
const DELETE_ACCESS = 0x00010000;
const FILE_SHARE_READ = 0x00000001;
const OPEN_EXISTING = 3;
const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000;
const FILE_ATTRIBUTE_TAG_INFO_CLASS = 9;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400;
const FILE_ATTRIBUTE_DIRECTORY = 0x00000010;
const FILE_RENAME_INFORMATION_CLASS = 10;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;
const ERROR_ACCESS_DENIED = 5;
const ERROR_NOT_SAME_DEVICE = 17;
const ERROR_SHARING_VIOLATION = 32;
const ERROR_NOT_SUPPORTED = 50;
const ERROR_FILE_EXISTS = 80;
const ERROR_INVALID_PARAMETER = 87;
const ERROR_ALREADY_EXISTS = 183;
const STATUS_OBJECT_NAME_NOT_FOUND = 0xc0000034;
const STATUS_OBJECT_NAME_COLLISION = 0xc0000035;
const STATUS_OBJECT_PATH_NOT_FOUND = 0xc000003a;
const STATUS_SHARING_VIOLATION = 0xc0000043;
const STATUS_NOT_SAME_DEVICE = 0xc00000d4;
const STATUS_ACCESS_DENIED = 0xc0000022;
const STATUS_INVALID_PARAMETER = 0xc000000d;
const STATUS_NOT_IMPLEMENTED = 0xc0000002;
const STATUS_INVALID_INFO_CLASS = 0xc0000003;
const STATUS_NOT_SUPPORTED = 0xc00000bb;

const RENAME_NOREPLACE = 1;
const SYS_OPENAT2: Partial<Record<NodeJS.Architecture, number>> = { x64: 437, arm64: 437 };
const O_RDONLY = 0;
const O_CLOEXEC = 0x80000;
const O_DIRECTORY = 0x10000;
const O_NOFOLLOW = 0x20000;
const O_PATH = 0x200000;
const RESOLVE_NO_MAGICLINKS = 0x02;
const RESOLVE_NO_SYMLINKS = 0x04;
const RESOLVE_BENEATH = 0x08;
const RESOLVE_STRICT = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS;
const FILE_TYPE_MASK = 0o170000;

let windowsApi: Promise<WindowsRenameApi> | undefined;
let linuxApi: Promise<LinuxRenameApi> | undefined;

function fail(code: string, detail: string, cause?: unknown): never {
  throw new KernelError(code, { detail, ...(cause === undefined ? {} : { cause }) });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code : undefined;
}

function nativeError(code: NativeFailureCode, detail: string, cause?: unknown): KernelError {
  if (code === 'EEXIST') return new KernelError('managed_trash_target_exists', { detail, ...(cause === undefined ? {} : { cause }) });
  if (code === 'EXDEV') return new KernelError('managed_trash_cross_device', { detail, ...(cause === undefined ? {} : { cause }) });
  if (code === 'ENOTSUP') return new KernelError('managed_trash_noreplace_unsupported', { detail, ...(cause === undefined ? {} : { cause }) });
  return new KernelError('managed_trash_move_failed', { detail, ...(cause === undefined ? {} : { cause }) });
}

function windowsError(code: number): NativeFailureCode {
  if (code === ERROR_FILE_EXISTS || code === ERROR_ALREADY_EXISTS) return 'EEXIST';
  if (code === ERROR_NOT_SAME_DEVICE) return 'EXDEV';
  if (code === ERROR_ACCESS_DENIED) return 'EACCES';
  if (code === ERROR_SHARING_VIOLATION) return 'EBUSY';
  if (code === ERROR_FILE_NOT_FOUND || code === ERROR_PATH_NOT_FOUND) return 'ENOENT';
  if (code === ERROR_NOT_SUPPORTED || code === ERROR_INVALID_PARAMETER) return 'ENOTSUP';
  return 'EIO';
}

function windowsNtStatus(status: number): NativeFailureCode {
  const code = status >>> 0;
  if (code === STATUS_OBJECT_NAME_COLLISION) return 'EEXIST';
  if (code === STATUS_NOT_SAME_DEVICE) return 'EXDEV';
  if (code === STATUS_ACCESS_DENIED) return 'EACCES';
  if (code === STATUS_SHARING_VIOLATION) return 'EBUSY';
  if (code === STATUS_OBJECT_NAME_NOT_FOUND || code === STATUS_OBJECT_PATH_NOT_FOUND) return 'ENOENT';
  if (code === STATUS_INVALID_PARAMETER || code === STATUS_NOT_IMPLEMENTED
    || code === STATUS_INVALID_INFO_CLASS || code === STATUS_NOT_SUPPORTED) return 'ENOTSUP';
  return 'EIO';
}

function linuxError(api: LinuxRenameApi): NativeFailureCode {
  const number = api.errno();
  const name = Object.keys(api.errnoNames).find(key => api.errnoNames[key] === number);
  if (name === 'EEXIST') return 'EEXIST';
  if (name === 'EXDEV') return 'EXDEV';
  if (name === 'EACCES') return 'EACCES';
  if (name === 'EPERM') return 'EPERM';
  if (name === 'EBUSY') return 'EBUSY';
  if (name === 'ENOENT') return 'ENOENT';
  if (name === 'ENOTSUP' || name === 'EOPNOTSUPP' || name === 'EINVAL' || name === 'ENOSYS') return 'ENOTSUP';
  return 'EIO';
}

async function windows(): Promise<WindowsRenameApi> {
  windowsApi ??= (async () => {
    try {
      const koffi = (await import('koffi')).default;
      const kernel32 = koffi.load('kernel32.dll');
      const ntdll = koffi.load('ntdll.dll');
      const fileAttributeTagInfo = koffi.struct('LIGULE_FILE_ATTRIBUTE_TAG_INFO', {
        FileAttributes: 'uint32_t',
        ReparseTag: 'uint32_t',
      });
      const fileTime = koffi.struct('LIGULE_FILETIME', { dwLowDateTime: 'uint32_t', dwHighDateTime: 'uint32_t' });
      const byHandleFileInformation = koffi.struct('LIGULE_BY_HANDLE_FILE_INFORMATION', {
        dwFileAttributes: 'uint32_t',
        ftCreationTime: fileTime,
        ftLastAccessTime: fileTime,
        ftLastWriteTime: fileTime,
        dwVolumeSerialNumber: 'uint32_t',
        nFileSizeHigh: 'uint32_t',
        nFileSizeLow: 'uint32_t',
        nNumberOfLinks: 'uint32_t',
        nFileIndexHigh: 'uint32_t',
        nFileIndexLow: 'uint32_t',
      });
      const lastError = kernel32.func('__stdcall', 'GetLastError', 'uint', []);
      const createFile = kernel32.func('__stdcall', 'CreateFileW', 'intptr', [
        'str16', 'uint', 'uint', 'void*', 'uint', 'uint', 'intptr',
      ]);
      const getFileInformationEx = kernel32.func('__stdcall', 'GetFileInformationByHandleEx', 'int', [
        'intptr', 'int', '_Out_ LIGULE_FILE_ATTRIBUTE_TAG_INFO *', 'uint32_t',
      ]);
      const getFileInformation = kernel32.func('__stdcall', 'GetFileInformationByHandle', 'int', [
        'intptr', '_Out_ LIGULE_BY_HANDLE_FILE_INFORMATION *',
      ]);
      const renameByHandle = ntdll.func('__stdcall', 'NtSetInformationFile', 'long', [
        'intptr', 'void*', 'void*', 'uint32_t', 'int',
      ]);
      const getFinalPath = kernel32.func('__stdcall', 'GetFinalPathNameByHandleW', 'uint32_t', [
        'intptr', 'void*', 'uint32_t', 'uint32_t',
      ]);
      const closeHandle = kernel32.func('__stdcall', 'CloseHandle', 'int', ['intptr']);
      return {
        lastError: () => Number(lastError()),
        createFile: (path, access, share, security, disposition, flags, template) =>
          createFile(path, access, share, security, disposition, flags, template) as NativeHandle,
        getFileInformationEx: (handle, informationClass, information, size) =>
          Number(getFileInformationEx(handle, informationClass, information, size)),
        getFileInformation: (handle, information) => Number(getFileInformation(handle, information)),
        renameByHandle: (handle, ioStatus, information, size, informationClass) =>
          Number(renameByHandle(handle, ioStatus, information, size, informationClass)),
        getFinalPath: (handle, buffer, capacity, flags) => Number(getFinalPath(handle, buffer, capacity, flags)),
        closeHandle: handle => Number(closeHandle(handle)),
        fileAttributeTagInfoSize: koffi.sizeof(fileAttributeTagInfo),
        byHandleFileInformationSize: koffi.sizeof(byHandleFileInformation),
      };
    } catch (cause) {
      throw new KernelError('managed_trash_noreplace_unsupported', { cause, detail: 'the Windows handle rename API could not be loaded' });
    }
  })();
  return windowsApi;
}

async function linux(): Promise<LinuxRenameApi> {
  linuxApi ??= (async () => {
    if (SYS_OPENAT2[process.arch] === undefined) {
      throw new KernelError('managed_trash_noreplace_unsupported', { detail: `openat2 syscall number is not configured for ${process.arch}` });
    }
    try {
      const koffi = (await import('koffi')).default;
      let libc: ReturnType<typeof koffi.load>;
      try { libc = koffi.load('libc.so.6'); }
      catch { libc = koffi.load('libc.so'); }
      const openHowType = koffi.struct('LIGULE_OPEN_HOW', { flags: 'uint64_t', mode: 'uint64_t', resolve: 'uint64_t' });
      const openAt2Syscall = libc.func('long syscall(long number, int dirfd, const char *pathname, void *how, size_t size)');
      const nativeRenameAt2 = libc.func('int renameat2(int olddirfd, const char *oldpath, int newdirfd, const char *newpath, unsigned int flags)');
      const nativeClose = libc.func('int close(int fd)');
      return {
        openAt2Syscall: (number, directory, path, how, size) => Number(openAt2Syscall(number, directory, path, how, size)),
        renameAt2: (oldDirectory, source, newDirectory, destination, flags) =>
          Number(nativeRenameAt2(oldDirectory, source, newDirectory, destination, flags)),
        close: fd => Number(nativeClose(fd)),
        errno: koffi.errno,
        errnoNames: koffi.os.errno,
        openHowType,
        openHowSize: koffi.sizeof(openHowType),
        allocate: type => koffi.alloc(type, 1),
        encode: (pointer, type, value) => koffi.encode(pointer, type, value),
        free: pointer => koffi.free(pointer),
      };
    } catch (cause) {
      throw new KernelError('managed_trash_noreplace_unsupported', { cause, detail: 'Linux openat2 or renameat2 is unavailable' });
    }
  })();
  return linuxApi;
}

function validHandle(handle: NativeHandle): boolean {
  return handle !== -1 && handle !== -1n && handle !== 0 && handle !== 0n;
}

function within(root: string, path: string): boolean {
  const value = relative(root, path);
  return value !== '' && value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function assertRelativeTo(root: string, path: string): string {
  const relativePath = relative(resolve(root), resolve(path));
  if (!within(resolve(root), resolve(path)) && relativePath !== '') {
    fail('managed_trash_noreplace_unsupported', `${path} is not below its authorized root`);
  }
  if (relativePath === '') fail('managed_trash_noreplace_unsupported', 'the rename object cannot be its authorized root');
  const pieces = relativePath.split(sep);
  const name = pieces.pop();
  if (name === undefined || name === '' || name === '.' || name === '..') {
    fail('managed_trash_noreplace_unsupported', `invalid rename path ${path}`);
  }
  const parent = pieces.length === 0 ? resolve(root) : resolve(root, ...pieces);
  if (!within(resolve(root), parent) && !samePath(resolve(root), parent)) {
    fail('managed_trash_noreplace_unsupported', `${path} has an invalid parent`);
  }
  return name;
}

function samePath(left: string, right: string): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function assertExpected(info: { dev: number; ino: number; mode: number }, expected: RenameIdentity, path: string): void {
  if (info.dev !== expected.dev || info.ino !== expected.ino
    || (info.mode & FILE_TYPE_MASK) !== (expected.mode & FILE_TYPE_MASK)) {
    fail('managed_trash_source_changed', path);
  }
}

function openWindowsHandle(
  api: WindowsRenameApi, path: string, access: number, directory: boolean,
  share = FILE_SHARE_READ,
): NativeHandle {
  const handle = api.createFile(
    toNamespacedPath(path),
    access,
    share,
    null,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | (directory ? FILE_FLAG_BACKUP_SEMANTICS : 0),
    0,
  );
  if (!validHandle(handle)) {
    const errorCode = api.lastError();
    throw nativeError(windowsError(errorCode), `CreateFileW could not securely open ${path}`);
  }
  return handle;
}

function windowsHandleInfo(api: WindowsRenameApi, handle: NativeHandle, path: string): ByHandleFileInformation {
  const tag: FileAttributeTagInfo = { FileAttributes: 0, ReparseTag: 0 };
  if (api.getFileInformationEx(handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, tag, api.fileAttributeTagInfoSize) === 0) {
    const errorCode = api.lastError();
    throw nativeError(windowsError(errorCode), `GetFileInformationByHandleEx could not inspect ${path}`);
  }
  if ((tag.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    fail('managed_trash_link_unsupported', path);
  }
  const info: ByHandleFileInformation = {
    dwFileAttributes: 0,
    ftCreationTime: { dwLowDateTime: 0, dwHighDateTime: 0 },
    ftLastAccessTime: { dwLowDateTime: 0, dwHighDateTime: 0 },
    ftLastWriteTime: { dwLowDateTime: 0, dwHighDateTime: 0 },
    dwVolumeSerialNumber: 0,
    nFileSizeHigh: 0,
    nFileSizeLow: 0,
    nNumberOfLinks: 0,
    nFileIndexHigh: 0,
    nFileIndexLow: 0,
  };
  if (api.getFileInformation(handle, info) === 0) {
    const errorCode = api.lastError();
    throw nativeError(windowsError(errorCode), `GetFileInformationByHandle could not inspect ${path}`);
  }
  return info;
}

function windowsIdentity(info: ByHandleFileInformation): RenameIdentity {
  const fileIndex = (BigInt(info.nFileIndexHigh >>> 0) << 32n) | BigInt(info.nFileIndexLow >>> 0);
  return {
    dev: info.dwVolumeSerialNumber >>> 0,
    ino: Number(fileIndex),
    mode: (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) !== 0 ? 0o040000 : 0o100000,
  };
}

function normalizedWindowsPath(path: string): string {
  return toNamespacedPath(resolve(path)).replace(/[\\/]+$/u, '').toLowerCase();
}

function windowsFinalPath(api: WindowsRenameApi, handle: NativeHandle, path: string): string {
  const capacity = 32_768;
  const buffer = Buffer.alloc(capacity * 2);
  const length = api.getFinalPath(handle, buffer, capacity, 0);
  if (length === 0 || length >= capacity) {
    const errorCode = length === 0 ? api.lastError() : ERROR_INVALID_PARAMETER;
    throw nativeError(windowsError(errorCode), `GetFinalPathNameByHandleW could not resolve ${path}`);
  }
  let end = 0;
  while (end < buffer.length && buffer.readUInt16LE(end) !== 0) end += 2;
  const value = buffer.toString('utf16le', 0, Math.min(end, length * 2));
  return value.replace(/[\\/]+$/u, '').toLowerCase();
}

function openWindowsDirectoryChain(api: WindowsRenameApi, directoryPath: string, finalAccess = FILE_READ_ATTRIBUTES): NativeHandle[] {
  const absolute = resolve(directoryPath);
  if (absolute.startsWith('\\\\')) fail('managed_trash_noreplace_unsupported', 'handle-relative rename is unavailable for Windows network paths');
  const root = parse(absolute).root;
  if (root === '') fail('managed_trash_noreplace_unsupported', `Windows path has no volume root: ${directoryPath}`);
  const handles: NativeHandle[] = [];
  let current = root;
  try {
    const directoryShare = FILE_SHARE_READ | 0x00000002 | 0x00000004;
    const rootHandle = openWindowsHandle(api, current, FILE_READ_ATTRIBUTES, true, directoryShare);
    handles.push(rootHandle);
    const rootInfo = windowsHandleInfo(api, rootHandle, current);
    if ((rootInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) === 0
      || windowsFinalPath(api, rootHandle, current) !== normalizedWindowsPath(current)) {
      fail('managed_trash_link_unsupported', current);
    }
    const remainder = relative(root, absolute);
    const parts = remainder.split(/[\\/]+/u).filter(Boolean);
    for (const [index, part] of parts.entries()) {
      current = resolve(current, part);
      const access = index === parts.length - 1 ? finalAccess : FILE_READ_ATTRIBUTES;
      const handle = openWindowsHandle(api, current, access, true, directoryShare);
      handles.push(handle);
      const info = windowsHandleInfo(api, handle, current);
      if ((info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) === 0
        || windowsFinalPath(api, handle, current) !== normalizedWindowsPath(current)) {
        fail('managed_trash_link_unsupported', current);
      }
    }
    return handles;
  } catch (error) {
    closeWindowsHandles(api, handles);
    throw error;
  }
}

function closeWindowsHandles(api: WindowsRenameApi, handles: readonly NativeHandle[]): void {
  for (const handle of [...handles].reverse()) api.closeHandle(handle);
}

function sameLinuxIdentity(actual: { dev: bigint; ino: bigint; mode: bigint }, expected: RenameIdentity): boolean {
  return actual.dev === BigInt(expected.dev) && actual.ino === BigInt(expected.ino)
    && Number(actual.mode & BigInt(FILE_TYPE_MASK)) === (expected.mode & FILE_TYPE_MASK);
}

function openAt2(api: LinuxRenameApi, directory: number, path: string, flags: number): number {
  const encoded = api.allocate(api.openHowType);
  try {
    api.encode(encoded, api.openHowType, { flags: BigInt(flags), mode: 0n, resolve: BigInt(RESOLVE_STRICT) });
    const fd = api.openAt2Syscall(SYS_OPENAT2[process.arch]!, directory, path, encoded, api.openHowSize);
    if (fd < 0) {
      const code = linuxError(api);
      if (code === 'ENOTSUP') throw nativeError(code, `openat2 could not securely resolve ${path}`);
      throw nativeError(code, `openat2 could not securely resolve ${path}`);
    }
    return fd;
  } finally {
    api.free(encoded);
  }
}

function linuxRelative(root: string, path: string): string {
  const relativePath = relative(resolve(root), resolve(path));
  if (relativePath === '') return '.';
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    fail('managed_trash_noreplace_unsupported', `${path} is not below its authorized root`);
  }
  return relativePath;
}

function closeLinuxFds(api: LinuxRenameApi, fds: readonly number[]): void {
  for (const fd of [...fds].reverse()) api.close(fd);
}

async function renameWindows(source: string, destination: string, options: RenameNoReplaceOptions): Promise<void> {
  const api = await windows();
  assertRelativeTo(options.sourceRoot, source);
  const destinationBase = assertRelativeTo(options.destinationRoot, destination);
  const sourceParent = dirname(resolve(source));
  const destinationParent = dirname(resolve(destination));
  const isDirectory = (options.expectedSource.mode & FILE_TYPE_MASK) === 0o040000;
  const destinationRights = isDirectory ? FILE_ADD_SUBDIRECTORY : FILE_ADD_FILE;
  const sameParent = samePath(sourceParent, destinationParent);
  const sourceParentAccess = FILE_READ_ATTRIBUTES | (sameParent ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY : 0);
  const sourceDirectories = openWindowsDirectoryChain(api, sourceParent, sourceParentAccess);
  const destinationDirectories = sameParent ? sourceDirectories
    : openWindowsDirectoryChain(api, destinationParent, FILE_READ_ATTRIBUTES | destinationRights);
  let sourceHandle: NativeHandle | undefined;
  let destinationParentHandle: NativeHandle | undefined;
  let directoriesClosed = false;
  try {
    sourceHandle = openWindowsHandle(api, resolve(source), DELETE_ACCESS | FILE_READ_ATTRIBUTES, (options.expectedSource.mode & FILE_TYPE_MASK) === 0o040000);
    const sourceInfo = windowsHandleInfo(api, sourceHandle, source);
    assertExpected(windowsIdentity(sourceInfo), options.expectedSource, source);
    if (windowsFinalPath(api, sourceHandle, source) !== normalizedWindowsPath(source)) {
      fail('managed_trash_source_changed', source);
    }
    destinationParentHandle = openWindowsHandle(
      api,
      destinationParent,
      FILE_READ_ATTRIBUTES | FILE_LIST_DIRECTORY | FILE_TRAVERSE | SYNCHRONIZE | destinationRights,
      true,
      FILE_SHARE_READ | 0x00000002 | 0x00000004,
    );
    const destinationInfo = windowsHandleInfo(api, destinationParentHandle, destinationParent);
    if ((destinationInfo.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) === 0
      || windowsFinalPath(api, destinationParentHandle, destinationParent) !== normalizedWindowsPath(destinationParent)) {
      fail('managed_trash_link_unsupported', destinationParent);
    }
    // The chain walks reject reparse components. The rename itself uses only opened objects,
    // so close the walk handles before asking the filesystem to update the directory entry.
    if (!sameParent) closeWindowsHandles(api, destinationDirectories);
    closeWindowsHandles(api, sourceDirectories);
    directoriesClosed = true;
    if (destinationParentHandle === undefined) fail('managed_trash_noreplace_unsupported', 'destination parent handle is unavailable');
    const filename = Buffer.from(destinationBase, 'utf16le');
    const filenameOffset = 20;
    const information = Buffer.alloc(24 + filename.length);
    information.writeUInt32LE(0, 0); // ReplaceIfExists = FALSE.
    information.writeUInt32LE(0, 4); // Structure alignment.
    information.writeBigUInt64LE(BigInt(destinationParentHandle), 8);
    information.writeUInt32LE(filename.length, 16);
    filename.copy(information, filenameOffset);
    const ioStatus = Buffer.alloc(16);
    // NtSetInformationFile is the user-mode NT interface for this handle-relative rename;
    // unsupported OS/filesystem behavior is returned as an error and never falls back to paths.
    const status = api.renameByHandle(sourceHandle, ioStatus, information, information.length, FILE_RENAME_INFORMATION_CLASS);
    if (status !== 0) {
      const code = windowsNtStatus(status);
      throw nativeError(code, `NtSetInformationFile(FileRenameInformation) could not move ${source} to ${destination} (NTSTATUS 0x${(status >>> 0).toString(16)})`);
    }
    // The source handle is the renamed object. Do not re-resolve the destination pathname after commit.
    const movedInfo = windowsHandleInfo(api, sourceHandle, destination);
    assertExpected(windowsIdentity(movedInfo), options.expectedSource, destination);
  } finally {
    if (sourceHandle !== undefined) api.closeHandle(sourceHandle);
    if (destinationParentHandle !== undefined) api.closeHandle(destinationParentHandle);
    if (!directoriesClosed) {
      if (!sameParent) closeWindowsHandles(api, destinationDirectories);
      closeWindowsHandles(api, sourceDirectories);
    }
  }
}

async function renameLinux(source: string, destination: string, options: RenameNoReplaceOptions): Promise<void> {
  const api = await linux();
  const sourceBase = assertRelativeTo(options.sourceRoot, source);
  const destinationBase = assertRelativeTo(options.destinationRoot, destination);
  const sourceParent = dirname(resolve(source));
  const destinationParent = dirname(resolve(destination));
  const rootHandles: number[] = [];
  const directoryHandles: number[] = [];
  let sourceFd: number | undefined;
  let movedFd: number | undefined;
  try {
    const systemRoot = openSync('/', 'r');
    rootHandles.push(systemRoot);
    const sourceRootFd = openAt2(api, systemRoot, linuxRelative('/', options.sourceRoot), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    rootHandles.push(sourceRootFd);
    const destinationRootFd = openAt2(api, systemRoot, linuxRelative('/', options.destinationRoot), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    rootHandles.push(destinationRootFd);
    const sourceParentFd = openAt2(api, sourceRootFd, linuxRelative(options.sourceRoot, sourceParent), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    directoryHandles.push(sourceParentFd);
    const destinationParentFd = openAt2(api, destinationRootFd, linuxRelative(options.destinationRoot, destinationParent), O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    directoryHandles.push(destinationParentFd);
    sourceFd = openAt2(api, sourceParentFd, sourceBase, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    const sourceInfo = fstatSync(sourceFd, { bigint: true });
    if (!sameLinuxIdentity(sourceInfo, options.expectedSource)) fail('managed_trash_source_changed', source);

    if (api.renameAt2(sourceParentFd, sourceBase, destinationParentFd, destinationBase, RENAME_NOREPLACE) !== 0) {
      const code = linuxError(api);
      throw nativeError(code, `renameat2(RENAME_NOREPLACE) could not move ${source} to ${destination}`);
    }

    try {
      movedFd = openAt2(api, destinationParentFd, destinationBase, O_PATH | O_NOFOLLOW | O_CLOEXEC);
      const movedInfo = fstatSync(movedFd, { bigint: true });
      if (sameLinuxIdentity(movedInfo, options.expectedSource)) return;
    } catch (error) {
      if (error instanceof KernelError && codeOf(error) === 'managed_trash_source_changed') throw error;
      // A successful rename followed by an uninspectable target must be rolled back or reported as retained.
    } finally {
      if (movedFd !== undefined) {
        closeSync(movedFd);
        movedFd = undefined;
      }
    }

    if (api.renameAt2(destinationParentFd, destinationBase, sourceParentFd, sourceBase, RENAME_NOREPLACE) === 0) {
      fail('managed_trash_source_changed', source);
    }
    const rollbackCode = linuxError(api);
    fail('managed_trash_move_recovery_required', `${destination} contains a mismatched object; no-replace rollback failed (${rollbackCode})`);
  } finally {
    if (movedFd !== undefined) closeSync(movedFd);
    if (sourceFd !== undefined) closeSync(sourceFd);
    closeLinuxFds(api, directoryHandles);
    closeLinuxFds(api, rootHandles);
  }
}

/**
 * Move a same-filesystem file or directory using an opened source object and a pinned destination parent.
 * Linux dirfd rename still selects the source basename at the syscall; it verifies identity afterward and
 * rolls back without replacement on mismatch. Parent directories can still be moved by their owner.
 */
export async function renameNoReplace(source: string, destination: string, options: RenameNoReplaceOptions): Promise<void> {
  if (!isAbsolute(source) || !isAbsolute(destination)
    || !isAbsolute(options.sourceRoot) || !isAbsolute(options.destinationRoot)) {
    fail('managed_trash_noreplace_unsupported', 'source, destination, and roots must be absolute paths');
  }
  if (process.platform === 'win32') return renameWindows(source, destination, options);
  if (process.platform === 'linux') return renameLinux(source, destination, options);
  throw new KernelError('managed_trash_noreplace_unsupported', {
    detail: `handle-relative no-replace rename is not implemented for ${process.platform}`,
  });
}

/** Query FILE_ATTRIBUTE_REPARSE_POINT without following the path's final component. */
export async function isWindowsReparsePoint(path: string): Promise<boolean> {
  if (process.platform !== 'win32') return false;
  const api = await windows();
  const handle = api.createFile(
    toNamespacedPath(path),
    FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | 0x00000002 | 0x00000004,
    null,
    OPEN_EXISTING,
    FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
    0,
  );
  if (!validHandle(handle)) {
    const errorCode = api.lastError();
    throw nativeError(windowsError(errorCode), `CreateFileW could not inspect ${path} without following reparse points`);
  }
  try {
    const information: FileAttributeTagInfo = { FileAttributes: 0, ReparseTag: 0 };
    if (api.getFileInformationEx(handle, FILE_ATTRIBUTE_TAG_INFO_CLASS, information, api.fileAttributeTagInfoSize) === 0) {
      const errorCode = api.lastError();
      throw nativeError(windowsError(errorCode), `GetFileInformationByHandleEx could not inspect ${path}`);
    }
    return (information.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
  } finally {
    api.closeHandle(handle);
  }
}

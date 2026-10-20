type Koffi = typeof import('koffi')['default'];
import type { NativeHandle } from './windows-appcontainer-process.js';

export type AppContainerHandle = NativeHandle;

const SE_FILE_OBJECT = 1;
const DACL_SECURITY_INFORMATION = 0x00000004;
const GRANT_ACCESS = 1;
const REVOKE_ACCESS = 4;
const TRUSTEE_IS_SID = 0;
const TRUSTEE_IS_UNKNOWN = 0;
const OBJECT_AND_CONTAINER_INHERIT = 0x00000003;
const FILE_GENERIC_READ = 0x00120089;
const ACCESS_ALLOWED_ACE_TYPE = 0;
const ACE_OBJECT_TYPE_PRESENT = 0x00000001;
const ACE_INHERITED_OBJECT_TYPE_PRESENT = 0x00000002;
const INHERITED_ACE = 0x10;

const SIMPLE_ACE_SID_OFFSET = new Map([
  [0, 8], [1, 8], [2, 8], [3, 8], [9, 8], [10, 8], [13, 8], [14, 8],
  [17, 8], [18, 8], [19, 8], [20, 8], [21, 8],
]);
const OBJECT_ACE_TYPES = new Set([5, 6, 7, 8, 11, 12, 15, 16]);

interface AceRecord {
  readonly type: number;
  readonly flags: number;
  readonly mask: number | undefined;
  readonly sid: AppContainerHandle;
}

function isNull(pointer: AppContainerHandle | null | undefined): boolean {
  return pointer === null || pointer === undefined || pointer === 0 || pointer === 0n;
}

function pointerOffset(pointer: AppContainerHandle, offset: number): AppContainerHandle {
  return typeof pointer === 'bigint' ? pointer + BigInt(offset) : pointer + offset;
}

function bindings(koffi: Koffi) {
  const kernel = koffi.load('kernel32.dll');
  const advapi = koffi.load('advapi32.dll');
  const PVOID = koffi.pointer('void');
  const TRUSTEE_W = koffi.struct({
    pMultipleTrustee: PVOID,
    MultipleTrusteeOperation: 'int32_t',
    TrusteeForm: 'int32_t',
    TrusteeType: 'int32_t',
    ptstrName: PVOID,
  });
  const EXPLICIT_ACCESS_W = koffi.struct({
    grfAccessPermissions: 'uint32_t',
    grfAccessMode: 'int32_t',
    grfInheritance: 'uint32_t',
    Trustee: TRUSTEE_W,
  });
  const ACL_SIZE_INFORMATION = koffi.struct({ AceCount: 'uint32_t', AclBytesInUse: 'uint32_t', AclBytesFree: 'uint32_t' });
  const bind = (library: ReturnType<Koffi['load']>, name: string, result: string | ReturnType<Koffi['pointer']>, args: Array<string | ReturnType<Koffi['pointer']>>) =>
    library.func('__stdcall', name, result, args) as unknown as (...parameters: any[]) => any;
  return {
    PVOID,
    EXPLICIT_ACCESS_W,
    ACL_SIZE_INFORMATION,
    getNamedSecurityInfo: bind(advapi, 'GetNamedSecurityInfoW', 'uint32_t', [
      'str16', 'int32_t', 'uint32_t', koffi.pointer(PVOID), koffi.pointer(PVOID), koffi.pointer(PVOID), koffi.pointer(PVOID), koffi.pointer(PVOID),
    ]),
    setEntriesInAcl: bind(advapi, 'SetEntriesInAclW', 'uint32_t', ['uint32_t', koffi.pointer(EXPLICIT_ACCESS_W), PVOID, koffi.pointer(PVOID)]),
    setNamedSecurityInfo: bind(advapi, 'SetNamedSecurityInfoW', 'uint32_t', ['str16', 'int32_t', 'uint32_t', PVOID, PVOID, PVOID, PVOID]),
    equalSid: bind(advapi, 'EqualSid', 'int32_t', [PVOID, PVOID]),
    isValidSid: bind(advapi, 'IsValidSid', 'int32_t', [PVOID]),
    getAclInformation: bind(advapi, 'GetAclInformation', 'int32_t', [PVOID, PVOID, 'uint32_t', 'int32_t']),
    getAce: bind(advapi, 'GetAce', 'int32_t', [PVOID, 'uint32_t', koffi.pointer(PVOID)]),
    localFree: bind(kernel, 'LocalFree', PVOID, [PVOID]),
    lastError: bind(kernel, 'GetLastError', 'uint32_t', []),
  };
}

function aceSidOffset(koffi: Koffi, ace: AppContainerHandle, type: number): number {
  const simpleOffset = SIMPLE_ACE_SID_OFFSET.get(type);
  if (simpleOffset !== undefined) return simpleOffset;
  if (type === 4) return 12;
  if (OBJECT_ACE_TYPES.has(type)) {
    const objectFlags = Number(koffi.decode(ace, 8, 'uint32_t'));
    return 12
      + ((objectFlags & ACE_OBJECT_TYPE_PRESENT) === 0 ? 0 : 16)
      + ((objectFlags & ACE_INHERITED_OBJECT_TYPE_PRESENT) === 0 ? 0 : 16);
  }
  throw new Error(`unsupported ACE type ${type}; refusing to change an unfamiliar DACL`);
}

function readTargetAces(koffi: Koffi, api: ReturnType<typeof bindings>, dacl: AppContainerHandle, targetSid: AppContainerHandle): AceRecord[] {
  const info = koffi.alloc(api.ACL_SIZE_INFORMATION, 1) as Buffer;
  const aceOut = koffi.alloc(api.PVOID, 1) as Buffer;
  try {
    if (api.getAclInformation(dacl, info, koffi.sizeof(api.ACL_SIZE_INFORMATION), 2) === 0) {
      throw new Error(`GetAclInformation failed with Win32 error ${api.lastError() as number}`);
    }
    const count = Number(koffi.decode(info, 'uint32_t'));
    const matches: AceRecord[] = [];
    for (let index = 0; index < count; index += 1) {
      if (api.getAce(dacl, index, aceOut) === 0) throw new Error(`GetAce(${index}) failed with Win32 error ${api.lastError() as number}`);
      const ace = koffi.decode(aceOut, api.PVOID) as AppContainerHandle;
      const type = Number(koffi.decode(ace, 0, 'uint8_t'));
      const flags = Number(koffi.decode(ace, 1, 'uint8_t'));
      const size = Number(koffi.decode(ace, 2, 'uint16_t'));
      if (size < 8) throw new Error(`ACE ${index} has invalid size ${size}`);
      const sidOffset = aceSidOffset(koffi, ace, type);
      if (sidOffset >= size) throw new Error(`ACE ${index} has no SID at the expected offset`);
      const sid = pointerOffset(ace, sidOffset);
      if (api.isValidSid(sid) === 0) throw new Error(`ACE ${index} contains an invalid SID`);
      if (api.equalSid(sid, targetSid) !== 0) {
        const mask = type === ACCESS_ALLOWED_ACE_TYPE || type === 1 || type === 2 || type === 3
          ? Number(koffi.decode(ace, 4, 'uint32_t'))
          : undefined;
        matches.push({ type, flags, mask, sid });
      }
    }
    return matches;
  } finally {
    koffi.free(aceOut);
    koffi.free(info);
  }
}

function readDacl(koffi: Koffi, api: ReturnType<typeof bindings>, path: string): { dacl: AppContainerHandle; descriptor: AppContainerHandle } {
  const allocations = [
    koffi.alloc(api.PVOID, 1) as Buffer,
    koffi.alloc(api.PVOID, 1) as Buffer,
    koffi.alloc(api.PVOID, 1) as Buffer,
    koffi.alloc(api.PVOID, 1) as Buffer,
    koffi.alloc(api.PVOID, 1) as Buffer,
  ];
  const [owner, group, daclOut, sacl, descriptorOut] = allocations;
  try {
    const result = api.getNamedSecurityInfo(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, owner, group, daclOut, sacl, descriptorOut);
    if (result !== 0) throw new Error(`GetNamedSecurityInfoW failed with Win32 error ${result}`);
    const dacl = koffi.decode(daclOut, api.PVOID) as AppContainerHandle;
    const descriptor = koffi.decode(descriptorOut, api.PVOID) as AppContainerHandle;
    if (isNull(dacl)) throw new Error('GetNamedSecurityInfoW returned a null DACL; refusing to replace a permissive null DACL');
    if (isNull(descriptor)) throw new Error('GetNamedSecurityInfoW returned a null security descriptor');
    return { dacl, descriptor };
  } finally {
    for (const allocation of allocations) koffi.free(allocation);
  }
}

function freeNative(api: ReturnType<typeof bindings>, pointer: AppContainerHandle | undefined, operation: string): void {
  if (pointer === undefined || isNull(pointer)) return;
  const result = api.localFree(pointer) as AppContainerHandle;
  if (!isNull(result)) throw new Error(`LocalFree(${operation}) failed`);
}

async function updateDirectoryReadAce(path: string, sid: AppContainerHandle, action: 'grant' | 'revoke'): Promise<void> {
  if (process.platform !== 'win32') throw new Error('AppContainer directory ACLs are available only on Windows');
  if (typeof path !== 'string' || path.trim() === '' || path.includes('\0')) throw new TypeError('directory path must be a non-empty Windows path');
  if (isNull(sid)) throw new TypeError('AppContainer SID is required');
  const koffi = (await import('koffi')).default;
  const api = bindings(koffi);
  const current = readDacl(koffi, api, path);
  let newDacl: AppContainerHandle | undefined;
  let primaryError: unknown;
  try {
    const matches = readTargetAces(koffi, api, current.dacl, sid);
    if (action === 'grant' && matches.length !== 0) {
      throw new Error('target SID already has an ACE; refusing to alter pre-existing permissions');
    }
    if (action === 'revoke') {
      if (matches.length !== 1) throw new Error(`expected exactly one target SID ACE before revoke, found ${matches.length}`);
      const [match] = matches;
      if (match?.type !== ACCESS_ALLOWED_ACE_TYPE || match.mask !== FILE_GENERIC_READ || match.flags !== OBJECT_AND_CONTAINER_INHERIT) {
        throw new Error('target SID ACE changed; refusing to revoke a modified permission');
      }
    }

    const entry = koffi.alloc(api.EXPLICIT_ACCESS_W, 1) as Buffer;
    let daclOut = koffi.alloc(api.PVOID, 1) as Buffer;
    try {
      koffi.encode(entry, api.EXPLICIT_ACCESS_W, {
        grfAccessPermissions: action === 'grant' ? FILE_GENERIC_READ : 0,
        grfAccessMode: action === 'grant' ? GRANT_ACCESS : REVOKE_ACCESS,
        grfInheritance: OBJECT_AND_CONTAINER_INHERIT,
        Trustee: { pMultipleTrustee: 0n, MultipleTrusteeOperation: 0, TrusteeForm: TRUSTEE_IS_SID, TrusteeType: TRUSTEE_IS_UNKNOWN, ptstrName: sid },
      });
      const mergeResult = api.setEntriesInAcl(1, entry, current.dacl, daclOut);
      if (mergeResult !== 0) throw new Error(`SetEntriesInAclW(${action}) failed with Win32 error ${mergeResult}`);
      newDacl = koffi.decode(daclOut, api.PVOID) as AppContainerHandle;
      if (isNull(newDacl)) throw new Error('SetEntriesInAclW returned a null DACL');
      const applyResult = api.setNamedSecurityInfo(path, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION, 0n, 0n, newDacl, 0n);
      if (applyResult !== 0) throw new Error(`SetNamedSecurityInfoW(${action}) failed with Win32 error ${applyResult}`);
    } finally {
      freeNative(api, newDacl, 'merged DACL');
      newDacl = undefined;
      koffi.free(daclOut);
      koffi.free(entry);
    }

    const updated = readDacl(koffi, api, path);
    try {
      const updatedMatches = readTargetAces(koffi, api, updated.dacl, sid);
      if (action === 'grant') {
        if (updatedMatches.length !== 1 || updatedMatches[0]?.type !== ACCESS_ALLOWED_ACE_TYPE
          || updatedMatches[0].mask !== FILE_GENERIC_READ || updatedMatches[0].flags !== OBJECT_AND_CONTAINER_INHERIT) {
          throw new Error('target SID read ACE did not match the requested permission after grant');
        }
      } else if (updatedMatches.length !== 0) {
        throw new Error('target SID ACE remained after revoke');
      }
    } finally {
      freeNative(api, updated.descriptor, 'updated security descriptor');
    }
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    const cleanupErrors: Error[] = [];
    try { freeNative(api, newDacl, 'merged DACL'); }
    catch (error) { cleanupErrors.push(error as Error); }
    try { freeNative(api, current.descriptor, 'security descriptor'); }
    catch (error) { cleanupErrors.push(error as Error); }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(primaryError === undefined ? cleanupErrors : [primaryError, ...cleanupErrors], 'AppContainer directory ACL cleanup failed');
    }
  }
}

export async function grantAppContainerDirectoryRead(path: string, sid: AppContainerHandle): Promise<void> {
  await updateDirectoryReadAce(path, sid, 'grant');
}

export async function revokeAppContainerDirectoryRead(path: string, sid: AppContainerHandle): Promise<void> {
  await updateDirectoryReadAce(path, sid, 'revoke');
}

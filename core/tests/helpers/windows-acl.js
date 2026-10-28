export function withoutAutoInheritanceMarker(acl) {
  return acl.replaceAll('(I)', '');
}

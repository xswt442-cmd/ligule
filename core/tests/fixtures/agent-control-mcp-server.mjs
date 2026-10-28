import { serveMcp } from '../../dist/host/mcp-server.js';

const [projectRoot, grantId, operator] = process.argv.slice(2);
if (typeof projectRoot !== 'string' || projectRoot === '') throw new Error('project_root_required');
await serveMcp({
  projectRoot,
  version: 'test',
  ...(grantId === undefined || grantId === '' ? {} : { grantId }),
  operator: operator === 'operator',
});

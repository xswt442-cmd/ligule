export default function projectAudit(host) {
  host.registerTool({
    name: 'project_audit',
    description: 'Read and search one project file, then check the Node.js version through the Kernel.',
    access: 'exec',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 1_024 },
        pattern: { type: 'string', minLength: 1, maxLength: 256 },
      },
      required: ['path', 'pattern'],
      additionalProperties: false,
    },
    run: async ({ path, pattern }) => {
      const file = await host.request('read', { path });
      const matches = await host.request('search', { path, pattern });
      const runtime = await host.request('exec', { command: 'node --version' });
      return {
        text: JSON.stringify({
          file: file.text.slice(0, 1_200),
          matches: matches.text.slice(0, 1_200),
          node: runtime.text.trim().slice(0, 128),
        }),
      };
    },
  });
}

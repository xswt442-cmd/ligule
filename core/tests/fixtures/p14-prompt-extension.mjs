export default function p14PromptExtension(host) {
  host.registerPrompt({ name: 'parent-only', text: 'PARENT_ONLY_PROMPT_MARKER' });
  host.registerTool({
    name: 'parent_only_tool',
    description: 'A tool that the parent mode does not select.',
    access: 'read',
    parameters: { type: 'object', properties: {} },
    run: async () => ({ text: 'not selected' }),
  });
}

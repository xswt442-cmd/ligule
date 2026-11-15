const DEMO_MARKER = 'P11_EXTENSION_DEMO';

function isDemoRequest(messages) {
  return messages.some((message) => message.role === 'user'
    && typeof message.text === 'string' && message.text.includes(DEMO_MARKER));
}

export default function projectContext(host) {
  host.registerHook({
    phase: 'prepareRequest',
    name: 'project-context',
    run: async (context) => {
      if (!isDemoRequest(context.messages)) return;
      const readme = await context.request('read', { path: 'README.md' });
      return { context: `Project README excerpt read through the Kernel:\n${readme.text.slice(0, 512)}` };
    },
  });

  host.registerHook({
    phase: 'completeRun',
    name: 'delivery-check',
    run: async (context) => {
      if (typeof context.summary.text !== 'string' || !context.summary.text.includes(DEMO_MARKER)) {
        return { decision: 'accept' };
      }
      if (context.candidate.fromSeq !== context.userSeq
        || typeof context.candidate.id !== 'string'
        || typeof context.candidate.toSeq !== 'number'
        || context.candidate.toSeq < context.userSeq) {
        return { decision: 'fail', reason: 'The completion candidate is not bound to the current Session range.' };
      }
      if (context.summary.iterations < 2) {
        return {
          decision: 'continue',
          reason: 'P11_EXTENSION_DEMO_CHECK: use normal project tools to verify the result and save PASS in verification.txt.',
        };
      }
      const verification = await context.request('read', { path: 'verification.txt' });
      if (verification.text.trim() === 'PASS') return { decision: 'accept' };
      return {
        decision: 'continue',
        reason: 'P11_EXTENSION_DEMO_CHECK: verification.txt does not contain PASS; use normal project tools to check and update it.',
      };
    },
  });
}

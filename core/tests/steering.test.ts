import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createPermissionContext } from '../dist/kernel/permission.js';
import { TRUSTED_AGENT_CONTROL_ORIGIN } from '../dist/host/agent-control-runtime.js';
import { waitFor, withTuiHost } from './helpers/tui-host.ts';

const fullAccess = createPermissionContext('full-access', 'unrestricted', {
  filesystemRead: 'full', filesystemWrite: 'full', network: 'full', process: 'full',
});

test('P10 steering is bound to the active Run and applied before natural completion', { timeout: 20_000 }, async () => {
  let releaseFirstResponse!: () => void;
  let reportFirstRequest!: () => void;
  const firstResponse = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const firstRequest = new Promise<void>((resolve) => { reportFirstRequest = resolve; });
  let holdFirstResponse = true;

  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    const running = client.request('run.start', { sessionId, input: 'start the route task' })
      .then(() => undefined, (error: unknown) => error);
    let steerError: unknown;
    let steering: { inputId: string; runId: string; state: string; source: string } | undefined;
    try {
      await firstRequest;
      const record = await client.request('session.read', { sessionId }) as {
        events: { kind?: string; run?: { runId?: string } }[];
      };
      const runId = record.events.find((event) => event.kind === 'user')?.run?.runId;
      assert.equal(typeof runId, 'string', 'the active Session must contain its accepted Run identity');
      const stale = await client.request('run.steer', { sessionId, runId: 'old-run', input: 'must not be retargeted' })
        .then(() => undefined, (error: unknown) => error) as { code?: string } | undefined;
      assert.equal(stale?.code, 'run_steer_target_mismatch');
      steering = await client.request('run.steer', {
        sessionId, runId, input: 'keep the existing route and do not change its public path',
      }) as typeof steering;
    } catch (error) {
      steerError = error;
    } finally {
      releaseFirstResponse();
    }
    const runError = await running;
    if (steerError !== undefined) throw steerError;
    assert.equal(runError, undefined);
    assert.ok(steering);
    assert.equal(steering.state, 'accepted');
    assert.equal(steering.source, 'human');
    assert.equal(providerRequests.length, 2, 'natural completion must yield to the accepted steering input');
    const steeringText = 'keep the existing route and do not change its public path';
    assert.ok(providerRequests[1].messages.some((message) =>
      message.role === 'user' && typeof message.content === 'string' && message.content.includes(steeringText)),
    'the next actual Provider request must contain the applied input');

    const finalRecord = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; inputId?: string; runId?: string; state?: string; source?: string; text?: string }[];
    };
    const inputs = finalRecord.events.filter((event) => event.kind === 'runInput');
    assert.deepEqual(inputs.map((event) => event.state), ['accepted', 'applied']);
    assert.equal(inputs[0].inputId, steering.inputId);
    assert.equal(inputs[1].inputId, steering.inputId);
    assert.equal(inputs[0].runId, steering.runId);
    assert.equal(inputs[1].runId, steering.runId);
    assert.equal(inputs[0].source, 'human');
    assert.equal(inputs[0].text, steeringText);
  }, {
    beforeResponse: async () => {
      if (!holdFirstResponse) return;
      holdFirstResponse = false;
      reportFirstRequest();
      await firstResponse;
    },
    interactive: true,
    permissionControl: true,
    testDirectory: 'testplace/tmp',
  });
});

test('run steering cannot target a Run accepted through another caller scope', { timeout: 20_000 }, async () => {
  let releaseFirstResponse!: () => void;
  let reportFirstRequest!: () => void;
  const firstResponse = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const firstRequest = new Promise<void>((resolve) => { reportFirstRequest = resolve; });
  let holdFirstResponse = true;

  await withTuiHost(async ({ host, sessionId }) => {
    const humanConnection = {
      [TRUSTED_AGENT_CONTROL_ORIGIN]: true as const,
      notify() {},
      async request() { return { decision: 'deny' }; },
    };
    const started = await host.handle({ method: 'run.submit', params: { sessionId, input: 'human-owned active run', origin: 'human' } }, humanConnection) as { runId: string };
    try {
      await firstRequest;
      await assert.rejects(
        host.handle({ method: 'run.steer', params: { sessionId, runId: started.runId, input: 'untrusted steering' } }, {
          notify() {},
          async request() { return { decision: 'deny' }; },
        }),
        { code: 'run_not_found' },
      );
    } finally {
      releaseFirstResponse();
    }
    await host.handle({ method: 'run.wait', params: { sessionId, runId: started.runId } }, humanConnection);
  }, {
    beforeResponse: async () => {
      if (!holdFirstResponse) return;
      holdFirstResponse = false;
      reportFirstRequest();
      await firstResponse;
    },
    testDirectory: 'testplace/tmp',
  });
});

test('P10 steering source comes from the connection, and an untrusted caller cannot forge Human', { timeout: 20_000 }, async () => {
  let releaseFirstResponse!: () => void;
  let reportFirstRequest!: () => void;
  const firstResponse = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const firstRequest = new Promise<void>((resolve) => { reportFirstRequest = resolve; });
  let holdFirstResponse = true;

  await withTuiHost(async ({ client, sessionId }) => {
    const running = client.request('run.start', { sessionId, input: 'start the controller task' })
      .then(() => undefined, (error: unknown) => error);
    try {
      await firstRequest;
      const record = await client.request('session.read', { sessionId }) as {
        events: { kind?: string; run?: { runId?: string } }[];
      };
      const runId = record.events.find((event) => event.kind === 'user')?.run?.runId;
      assert.equal(typeof runId, 'string');
      const accepted = await client.request('run.steer', {
        sessionId, runId, input: 'controller request', origin: 'human', source: 'human',
      }) as { source: string };
      assert.equal(accepted.source, 'controller');
    } finally {
      releaseFirstResponse();
    }
    assert.equal(await running, undefined);
    const record = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; source?: string; state?: string; text?: string }[];
    };
    const accepted = record.events.find((event) => event.kind === 'runInput' && event.state === 'accepted');
    assert.equal(accepted?.source, 'controller');
    assert.equal(accepted?.text, 'controller request');
  }, {
    beforeResponse: async () => {
      if (!holdFirstResponse) return;
      holdFirstResponse = false;
      reportFirstRequest();
      await firstResponse;
    },
    permissionControl: false,
    testDirectory: 'testplace/tmp',
  });
});

test('P10 refuses steering in a version 2 Session while ordinary Runs remain available', { timeout: 20_000 }, async () => {
  let releaseFirstResponse!: () => void;
  let reportFirstRequest!: () => void;
  const firstResponse = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const firstRequest = new Promise<void>((resolve) => { reportFirstRequest = resolve; });
  let holdFirstResponse = true;
  const legacySessionId = 'legacy-steering-session';

  await withTuiHost(async ({ client, sessionDirectory, projectDirectory }) => {
    await client.request('session.open', { sessionId: legacySessionId, projectRoot: projectDirectory });
    const running = client.request('run.start', { sessionId: legacySessionId, input: 'continue the old session' })
      .then(() => undefined, (error: unknown) => error);
    try {
      await firstRequest;
      const record = await client.request('session.read', { sessionId: legacySessionId }) as {
        events: { kind?: string; run?: { runId?: string } }[];
      };
      const runId = record.events.find((event) => event.kind === 'user')?.run?.runId;
      assert.equal(typeof runId, 'string');
      const steeringError = await client.request('run.steer', {
        sessionId: legacySessionId, runId, input: 'do not write legacy events',
      }).then(() => undefined, (error: unknown) => error) as { code?: string } | undefined;
      assert.equal(steeringError?.code, 'run_steer_session_format_unsupported');
    } finally { releaseFirstResponse(); }
    assert.equal(await running, undefined);
    const record = await client.request('session.read', { sessionId: legacySessionId }) as {
      header?: { formatVersion?: number } | null;
      events: { kind?: string }[];
    };
    assert.equal(record.header?.formatVersion, 2);
    assert.equal(record.events.some((event) => event.kind === 'runInput'), false);
    assert.equal(await client.request('run.start', { sessionId: legacySessionId, input: 'a later ordinary Run still works' }).then(() => true), true);
  }, {
    setup: async ({ sessionDirectory, projectDirectory }) => {
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(join(sessionDirectory, `${legacySessionId}.jsonl`), `${JSON.stringify({
        kind: 'session', formatVersion: 2, sessionId: legacySessionId, projectRoot: projectDirectory,
        createdAt: '2026-11-15T00:00:00.000Z',
      })}\n`);
    },
    beforeResponse: async () => {
      if (!holdFirstResponse) return;
      holdFirstResponse = false;
      reportFirstRequest();
      await firstResponse;
    },
    testDirectory: 'testplace/tmp',
  });
});

test('P10 steering accepts at most 16 pending inputs for one Run', { timeout: 20_000 }, async () => {
  let releaseFirstResponse!: () => void;
  let reportFirstRequest!: () => void;
  const firstResponse = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const firstRequest = new Promise<void>((resolve) => { reportFirstRequest = resolve; });
  let holdFirstResponse = true;

  await withTuiHost(async ({ client, sessionId }) => {
    const running = client.request('run.start', { sessionId, input: 'start the bounded queue task' })
      .then(() => undefined, (error: unknown) => error);
    try {
      await firstRequest;
      const record = await client.request('session.read', { sessionId }) as {
        events: { kind?: string; run?: { runId?: string } }[];
      };
      const runId = record.events.find((event) => event.kind === 'user')?.run?.runId;
      assert.equal(typeof runId, 'string');
      const accepted = [];
      for (let index = 0; index < 16; index += 1) {
        accepted.push(await client.request('run.steer', { sessionId, runId, input: `steering ${index}` }));
      }
      assert.equal(accepted.length, 16);
      const overflow = await client.request('run.steer', { sessionId, runId, input: 'seventeenth input' })
        .then(() => undefined, (error: unknown) => error) as { code?: string } | undefined;
      assert.equal(overflow?.code, 'run_steer_limit_exceeded');
    } finally {
      releaseFirstResponse();
    }
    assert.equal(await running, undefined);
    const record = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; state?: string; inputId?: string }[];
    };
    const inputs = record.events.filter((event) => event.kind === 'runInput');
    assert.equal(inputs.filter((event) => event.state === 'accepted').length, 16);
    assert.equal(inputs.filter((event) => event.state === 'applied').length, 16);
    assert.equal(new Set(inputs.map((event) => event.inputId)).size, 16);
  }, {
    beforeResponse: async () => {
      if (!holdFirstResponse) return;
      holdFirstResponse = false;
      reportFirstRequest();
      await firstResponse;
    },
    permissionControl: true,
    testDirectory: 'testplace/tmp',
  });
});

test('P10 steering cancels a pending question without applying a late answer', { timeout: 20_000 }, async () => {
  let reportQuestion!: () => void;
  let answerQuestion!: (value: unknown) => void;
  let questionRequestId: string | undefined;
  const questionRequested = new Promise<void>((resolve) => { reportQuestion = resolve; });
  const lateAnswer = new Promise<unknown>((resolve) => { answerQuestion = resolve; });

  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    client.onRequest((message) => {
      if (message.method !== 'question.request') return undefined;
      const params = typeof message.params === 'object' && message.params !== null ? message.params as Record<string, unknown> : {};
      questionRequestId = typeof params.requestId === 'string' ? params.requestId : undefined;
      reportQuestion();
      return lateAnswer;
    });
    const running = client.request('run.start', {
      sessionId,
      input: JSON.stringify({ tool: 'ask_user_question', args: { questions: '[{"question":"Choose a route"}]' } }),
    }).then(() => undefined, (error: unknown) => error);
    await questionRequested;
    const record = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; run?: { runId?: string } }[];
    };
    const runId = record.events.find((event) => event.kind === 'user')?.run?.runId;
    assert.equal(typeof runId, 'string');
    const steering = await client.request('run.steer', { sessionId, runId, input: 'use the existing route' }) as {
      cancelledInteractions: number;
      cancelledInteractionIds?: string[];
    };
    assert.equal(steering.cancelledInteractions, 1);
    assert.equal(typeof questionRequestId, 'string');
    assert.deepEqual(steering.cancelledInteractionIds, [questionRequestId]);
    answerQuestion({ answers: [{ id: 'q1', selected: ['new route'] }] });
    assert.equal(await running, undefined);
    assert.ok(providerRequests[1].messages.some((message) =>
      message.role === 'user' && typeof message.content === 'string' && message.content.includes('use the existing route')));
    const finalRecord = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; result?: { code?: string } }[];
    };
    assert.equal(finalRecord.events.find((event) => event.kind === 'tool' && event.tool === 'ask_user_question')?.result?.code,
      'ask_user_cancelled');
  }, { interactive: true, permissionControl: true, testDirectory: 'testplace/tmp' });
});

test('P10 steering accepted during a response skips tool calls that have not started', { timeout: 20_000 }, async () => {
  let releaseFirstResponse!: () => void;
  let reportFirstRequest!: () => void;
  const firstResponse = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const firstRequest = new Promise<void>((resolve) => { reportFirstRequest = resolve; });
  let holdFirstResponse = true;
  let questionRequests = 0;

  await withTuiHost(async ({ client, sessionId, providerRequests }) => {
    client.onRequest((message) => {
      if (message.method !== 'question.request') return undefined;
      questionRequests += 1;
      return { answers: [{ id: 'q1', selected: ['north'] }] };
    });
    const running = client.request('run.start', {
      sessionId,
      input: JSON.stringify({ tool: 'ask_user_question', args: { questions: '[{"question":"Choose a route"}]' } }),
    }).then(() => undefined, (error: unknown) => error);
    try {
      await firstRequest;
      const record = await client.request('session.read', { sessionId }) as {
        events: { kind?: string; run?: { runId?: string } }[];
      };
      const runId = record.events.find((event) => event.kind === 'user')?.run?.runId;
      assert.equal(typeof runId, 'string');
      await client.request('run.steer', { sessionId, runId, input: 'Keep the existing route.' });
    } finally {
      releaseFirstResponse();
    }
    assert.equal(await running, undefined);
    assert.equal(questionRequests, 0, 'the undispatched question tool must be skipped after steering is accepted');
    const record = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; result?: { code?: string }; state?: string }[];
    };
    assert.equal(record.events.find((event) => event.kind === 'tool' && event.tool === 'ask_user_question')?.result?.code,
      'tool_skipped');
    assert.deepEqual(record.events.filter((event) => event.kind === 'runInput').map((event) => event.state), ['accepted', 'applied']);
    assert.ok(providerRequests[1].messages.some((message) =>
      message.role === 'user' && typeof message.content === 'string' && message.content.includes('Keep the existing route.')));
  }, {
    beforeResponse: async () => {
      if (!holdFirstResponse) return;
      holdFirstResponse = false;
      reportFirstRequest();
      await firstResponse;
    },
    interactive: true,
    permissionControl: true,
    testDirectory: 'testplace/tmp',
  });
});

test('P10 steering cancels pending approval and a late allow cannot start the write', { timeout: 20_000 }, async () => {
  let reportApproval!: () => void;
  let allowLate!: (value: unknown) => void;
  const approvalRequested = new Promise<void>((resolve) => { reportApproval = resolve; });
  const lateApproval = new Promise<unknown>((resolve) => { allowLate = resolve; });

  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    const marker = join(projectDirectory, 'steering-approval-marker.txt');
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? (reportApproval(), lateApproval) : undefined);
    const running = client.request('run.start', {
      sessionId,
      input: JSON.stringify({ tool: 'write', args: { path: 'steering-approval-marker.txt', content: 'executed' } }),
    }).then(() => undefined, (error: unknown) => error);
    await approvalRequested;
    const record = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; run?: { runId?: string } }[];
    };
    const runId = record.events.find((event) => event.kind === 'user')?.run?.runId;
    assert.equal(typeof runId, 'string');
    const steering = await client.request('run.steer', { sessionId, runId, input: 'Do not write that marker.' }) as {
      cancelledInteractions: number;
    };
    assert.equal(steering.cancelledInteractions, 1);
    allowLate({ decision: 'allow' });
    assert.equal(await running, undefined);
    assert.equal(existsSync(marker), false, 'the late approval answer must not start the pending write');
    assert.ok(providerRequests[1].messages.some((message) =>
      message.role === 'user' && typeof message.content === 'string' && message.content.includes('Do not write that marker.')));
    const finalRecord = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; result?: { failed?: boolean; code?: string } }[];
    };
    const write = finalRecord.events.find((event) => event.kind === 'tool' && event.tool === 'write');
    assert.equal(write?.result?.failed, true);
    assert.equal(write?.result?.code, 'policy_approval_cancelled');
  }, {
    permission: fullAccess,
    permissionControl: true,
    config: { policy: { mode: 'ask' } },
    testDirectory: 'testplace/tmp',
  });
});

test('P10 steering waits for an already-started process group to settle', { timeout: 20_000 }, async () => {
  await withTuiHost(async ({ client, sessionId, projectDirectory, providerRequests }) => {
    const startedMarker = join(projectDirectory, 'steering-process-started.txt');
    const completedMarker = join(projectDirectory, 'steering-process-completed.txt');
    await client.request('workspace.trust', {
      projectRoot: projectDirectory, trusted: true, confirmWorkspaceTrust: true,
    });
    client.onRequest((message) => message.method === 'approval.request' ? { decision: 'allow' } : undefined);
    const running = client.request('run.start', {
      sessionId, input: JSON.stringify({ tool: 'exec', args: { command: 'node steering-child.mjs' } }),
    }).then(() => undefined, (error: unknown) => error);
    await waitFor(() => existsSync(startedMarker), { within: 5_000, every: 20 });
    const record = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; run?: { runId?: string } }[];
    };
    const runId = record.events.find((event) => event.kind === 'user')?.run?.runId;
    assert.equal(typeof runId, 'string');
    const accepted = await client.request('run.steer', { sessionId, runId, input: 'Keep the public route unchanged.' }) as {
      cancelledInteractions: number;
    };
    assert.equal(accepted.cancelledInteractions, 0);
    await waitFor(() => existsSync(completedMarker), { within: 5_000, every: 20 });
    assert.equal(await running, undefined);
    assert.ok(providerRequests[1].messages.some((message) =>
      message.role === 'user' && typeof message.content === 'string' && message.content.includes('Keep the public route unchanged.')));
    const finalRecord = await client.request('session.read', { sessionId }) as {
      events: { kind?: string; tool?: string; result?: { failed?: boolean } }[];
    };
    assert.equal(finalRecord.events.find((event) => event.kind === 'tool' && event.tool === 'exec')?.result?.failed, false);
  }, {
    permission: fullAccess,
    permissionControl: true,
    setup: async ({ projectDirectory }) => {
      await writeFile(join(projectDirectory, 'steering-child.mjs'), [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('steering-process-started.txt', 'started');",
        'await new Promise((resolve) => setTimeout(resolve, 800));',
        "writeFileSync('steering-process-completed.txt', 'completed');",
      ].join('\n'));
    },
    config: { limits: { execTimeoutMs: 5_000 } },
    testDirectory: 'testplace/tmp',
  });
});

'use strict';
// Backend seam tests (lib/codex-backend.js) — the one seam the FakeBackend can't cover, because
// FakeBackend always returns a truthful threadId. These tests inject a fake MCP *client* so we can
// feed crafted callTool results (the shapes a real `codex mcp-server` could return) and assert the
// hard-error paths: B1 (missing threadId on resume) and M2 (empty content laundered as success).

const test = require('node:test');
const assert = require('node:assert/strict');

const { CodexBackend } = require('../lib/codex-backend');

// Build a backend whose connection is pre-satisfied with a fake client. _ensureConnected() returns
// early because _client is already set, so no child process is ever spawned.
function backendWithClient(callToolImpl) {
  const backend = new CodexBackend();
  backend._client = {
    callTool: callToolImpl,
    async listTools() {
      return { tools: [] };
    },
    async close() {},
  };
  return backend;
}

test('B1: continueSession with NO threadId in result HARD-ERRORS (does not borrow priorThreadId)', async () => {
  // Codex returns content but omits threadId on a resume — the dangerous, previously-laundered case.
  const backend = backendWithClient(async () => ({
    structuredContent: { content: 'here is your answer' }, // no threadId
    content: [{ type: 'text', text: 'here is your answer' }],
  }));

  await assert.rejects(
    () => backend.continueSession('prior-thread-123', 'continue please'),
    (err) => {
      assert.equal(err.code, 'NO_THREAD_ID_ON_RESUME');
      assert.match(err.message, /prior-thread-123/);
      assert.match(err.message, /silent amnesia/i);
      return true;
    }
  );
});

test('B1: continueSession with empty-string threadId on resume HARD-ERRORS', async () => {
  const backend = backendWithClient(async () => ({
    structuredContent: { threadId: '', content: 'answer' },
  }));
  await assert.rejects(
    () => backend.continueSession('prior-thread-456', 'go'),
    (err) => err.code === 'NO_THREAD_ID_ON_RESUME'
  );
});

test('B1: startSession with NO threadId still errors (NO_THREAD_ID), no prior to lie about', async () => {
  const backend = backendWithClient(async () => ({
    structuredContent: { content: 'started but no id' },
  }));
  await assert.rejects(
    () => backend.startSession('begin'),
    (err) => err.code === 'NO_THREAD_ID'
  );
});

test('happy path: continueSession with a real threadId returns {threadId, content}', async () => {
  const backend = backendWithClient(async (req) => {
    assert.equal(req.name, 'codex-reply');
    assert.equal(req.arguments.threadId, 'prior-thread-789');
    return { structuredContent: { threadId: 'prior-thread-789', content: 'real reply' } };
  });
  const out = await backend.continueSession('prior-thread-789', 'hi');
  assert.equal(out.threadId, 'prior-thread-789');
  assert.equal(out.content, 'real reply');
});

test('M2: non-error result with empty content HARD-ERRORS (EMPTY_REPLY) on start', async () => {
  const backend = backendWithClient(async () => ({
    structuredContent: { threadId: 't-1', content: '' },
  }));
  await assert.rejects(
    () => backend.startSession('say nothing'),
    (err) => {
      assert.equal(err.code, 'EMPTY_REPLY');
      return true;
    }
  );
});

test('M2: whitespace-only content HARD-ERRORS (EMPTY_REPLY) on continue', async () => {
  const backend = backendWithClient(async () => ({
    structuredContent: { threadId: 't-2', content: '   \n\t  ' },
  }));
  await assert.rejects(
    () => backend.continueSession('t-2', 'blank?'),
    (err) => err.code === 'EMPTY_REPLY'
  );
});

test('explicit isError result surfaces as CODEX_TOOL_ERROR before threadId/content checks', async () => {
  const backend = backendWithClient(async () => ({
    isError: true,
    content: [{ type: 'text', text: 'codex blew up' }],
  }));
  await assert.rejects(
    () => backend.continueSession('t-3', 'x'),
    (err) => {
      assert.equal(err.code, 'CODEX_TOOL_ERROR');
      assert.match(err.message, /codex blew up/);
      return true;
    }
  );
});

test('content falls back to text blocks when structuredContent.content is missing', async () => {
  const backend = backendWithClient(async () => ({
    structuredContent: { threadId: 't-4' }, // no content field
    content: [
      { type: 'text', text: 'part one ' },
      { type: 'text', text: 'part two' },
    ],
  }));
  const out = await backend.startSession('go');
  assert.equal(out.threadId, 't-4');
  assert.equal(out.content, 'part one part two');
});

test('M1: readiness probe failure surfaces as BACKEND_NOT_READY', async () => {
  // Fresh backend with NO pre-set client => _ensureConnected runs. Point it at a bogus command so
  // the spawned child never answers tools/list, and give a short readiness timeout.
  const backend = new CodexBackend({
    command: process.execPath,
    // a node one-liner that reads stdin forever but never speaks MCP => tools/list times out
    args: ['-e', 'process.stdin.resume()'],
    readinessTimeoutMs: 1500,
  });
  await assert.rejects(
    () => backend.startSession('hello'),
    (err) => {
      assert.equal(err.code, 'BACKEND_NOT_READY');
      return true;
    }
  );
  await backend.close();
});

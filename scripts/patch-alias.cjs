const path = require('path');
const Module = require('module');
const src = path.resolve('src');
const mocks = path.resolve('scripts/http-authz-mocks');
const mockMap = {
  '@/lib/auth': path.join(mocks,'lib/auth.js'),
  '@/lib/auth/guards': path.join(mocks,'lib/auth/guards.js'),
  '@/lib/auth/scope': path.join(mocks,'lib/auth/scope.js'),
  '@/lib/agent/runs': path.join(mocks,'lib/agent/runs.js'),
  '@/lib/pipeline': path.join(mocks,'lib/pipeline.js'),
  '@/lib/agent/write': path.join(mocks,'lib/agent/write.js'),
  '@/lib/verification/store': path.join(mocks,'lib/verification/store.js'),
  '@/lib/stories/store': path.join(mocks,'lib/stories/store.js'),
  '@/lib/investigations/store': path.join(mocks,'lib/investigations/store.js'),
  '@/lib/investigations/processor': path.join(mocks,'lib/investigations/processor.js'),
  '@/lib/repositories/connections': path.join(mocks,'lib/repositories/connections.js'),
  '@/lib/verification/outbox-worker': path.join(mocks,'lib/verification/outbox-worker.js'),
  '@/lib/auth/runner': path.join(mocks,'lib/auth/runner.js'),
  '@/lib/verification/jobs': path.join(mocks,'lib/verification/jobs.js'),
  '@/lib/verification/completion': path.join(mocks,'lib/verification/completion.js'),
  '@/lib/verification/outbox': path.join(mocks,'lib/verification/outbox.js'),
};
const orig = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(request, parent, isMain, options) {
  if (typeof request === 'string') {
    if (mockMap[request]) return orig(mockMap[request], parent, isMain, options);
    if (request.startsWith('@/')) return orig(path.join(src, request.slice(2)), parent, isMain, options);
  }
  return orig(request, parent, isMain, options);
};

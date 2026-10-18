// Mock GHCR API server for testing ghcr-retention.sh through the real HTTP path.
//
// Usage: node mock-ghcr-server.js <port> <scenario>
//
// Scenarios: normal, multipage, empty, non200, malformed, badmetadata, candidates4
//   normal      5 versions, mixed tags (report candidate: 1)
//   multipage   5 versions served 2 per page (report candidate: 1)
//   empty       no versions
//   non200      versions endpoint returns HTTP 404
//   malformed   versions endpoint returns invalid JSON
//   badmetadata a version with no id
//   candidates4 6 untagged versions (report/Delete candidates: 1 2 3 4)
//
// Environment:
//   MOCK_LOG_DIR          Directory for deletes.log and requests.log (default: os.tmpdir())
//   MOCK_FAIL_DELETE=1    DELETE requests return HTTP 500
//   MOCK_LIST_FAIL_AFTER  After this many successful version-list GETs, fail (default: -1 = never)
//   MOCK_LIST_FAIL_MODE   Failure style once MOCK_LIST_FAIL_AFTER is reached: non200 | malformed | object
//
// Prints "READY" on stdout once listening. Successful DELETEs remove the version
// from the in-memory list so subsequent list responses reflect the deletion.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const port = parseInt(process.argv[2], 10);
const scenario = process.argv[3] || 'normal';

const logDir = process.env.MOCK_LOG_DIR || os.tmpdir();
try { fs.mkdirSync(logDir, { recursive: true }); } catch {}
const deletesLog = path.join(logDir, 'deletes.log');
const requestsLog = path.join(logDir, 'requests.log');
fs.writeFileSync(deletesLog, '');
fs.writeFileSync(requestsLog, '');

const FAIL_DELETE = process.env.MOCK_FAIL_DELETE === '1';
const LIST_FAIL_AFTER = parseInt(process.env.MOCK_LIST_FAIL_AFTER || '-1', 10);
const LIST_FAIL_MODE = process.env.MOCK_LIST_FAIL_MODE || 'non200';

const scenarios = {
  normal: [
    { id: 1, created_at: '2024-01-01T00:00:00Z', metadata: { container: { tags: ['main'] } } },
    { id: 2, created_at: '2024-02-01T00:00:00Z', metadata: { container: { tags: ['sha-aaa'] } } },
    { id: 3, created_at: '2024-03-01T00:00:00Z', metadata: { container: { tags: ['sha-bbb', 'v1.0.0'] } } },
    { id: 4, created_at: '2024-04-01T00:00:00Z', metadata: { container: { tags: [] } } },
    { id: 5, created_at: '2024-05-01T00:00:00Z', metadata: { container: { tags: ['v2.0.0'] } } },
  ],
  multipage: [
    { id: 1, created_at: '2024-01-01T00:00:00Z', metadata: { container: { tags: ['main'] } } },
    { id: 2, created_at: '2024-02-01T00:00:00Z', metadata: { container: { tags: ['main'] } } },
    { id: 3, created_at: '2024-03-01T00:00:00Z', metadata: { container: { tags: ['sha-x'] } } },
    { id: 4, created_at: '2024-04-01T00:00:00Z', metadata: { container: { tags: ['sha-y'] } } },
    { id: 5, created_at: '2024-05-01T00:00:00Z', metadata: { container: { tags: ['v1.0.0'] } } },
  ],
  empty: [],
  // 6 untagged versions keep newest 2 => candidates 1 2 3 4
  candidates4: [
    { id: 1, created_at: '2024-01-01T00:00:00Z', metadata: { container: { tags: [] } } },
    { id: 2, created_at: '2024-02-01T00:00:00Z', metadata: { container: { tags: [] } } },
    { id: 3, created_at: '2024-03-01T00:00:00Z', metadata: { container: { tags: [] } } },
    { id: 4, created_at: '2024-04-01T00:00:00Z', metadata: { container: { tags: [] } } },
    { id: 5, created_at: '2024-05-01T00:00:00Z', metadata: { container: { tags: [] } } },
    { id: 6, created_at: '2024-06-01T00:00:00Z', metadata: { container: { tags: [] } } },
  ],
  non200: null,
  malformed: null,
  badmetadata: [
    { created_at: '2024-01-01T00:00:00Z', metadata: { container: { tags: [] } } },
  ],
};

// Mutable copy so successful deletes are reflected in later list responses.
let items = JSON.parse(JSON.stringify(scenarios[scenario] || []));
let listCount = 0;

function logRequest(method, pathname) {
  fs.appendFileSync(requestsLog, `${method} ${pathname}\n`);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  logRequest(req.method, url.pathname);

  // org endpoint probe
  if (url.pathname === '/orgs/test-owner') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ login: 'test-owner' }));
    return;
  }

  // versions list endpoint
  if (url.pathname === '/orgs/test-owner/packages/container/test-pkg/versions' && req.method === 'GET') {
    listCount += 1;
    if (LIST_FAIL_AFTER >= 0 && listCount > LIST_FAIL_AFTER) {
      if (LIST_FAIL_MODE === 'malformed') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{not: valid json array');
      } else if (LIST_FAIL_MODE === 'object') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'not an array' }));
      } else {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ message: 'server error' }));
      }
      return;
    }

    if (scenario === 'non200') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'Not Found' }));
      return;
    }
    if (scenario === 'malformed') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{not: json array');
      return;
    }
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const perPage = scenario === 'multipage' ? 2 : 100;
    const start = (page - 1) * perPage;
    const slice = items.slice(start, start + perPage);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(slice));
    return;
  }

  // delete endpoint
  if (req.method === 'DELETE' && /\/versions\/\d+$/.test(url.pathname)) {
    const id = parseInt(url.pathname.split('/').pop(), 10);
    fs.appendFileSync(deletesLog, id + '\n');
    if (FAIL_DELETE) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ message: 'delete failed' }));
      return;
    }
    items = items.filter((v) => v.id !== id);
    res.writeHead(204);
    res.end();
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ message: 'Not Found' }));
});

server.listen(port, () => {
  process.stdout.write('READY\n');
});

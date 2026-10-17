// Mock GHCR API server for testing ghcr-retention.sh API path.
// Usage: node mock-ghcr-server.js <port> <scenario>
// Scenarios: normal, multipage, empty, non200, malformed, badmetadata
// Prints "READY" on stdout once listening. Tracks DELETEs to /tmp/mock-deletes.log
const http = require('http');
const port = parseInt(process.argv[2], 10);
const scenario = process.argv[3] || 'normal';

const versions = {
  normal: [
    {id:1, created_at:"2024-01-01T00:00:00Z", metadata:{container:{tags:["main"]}}},
    {id:2, created_at:"2024-02-01T00:00:00Z", metadata:{container:{tags:["sha-aaa"]}}},
    {id:3, created_at:"2024-03-01T00:00:00Z", metadata:{container:{tags:["sha-bbb","v1.0.0"]}}},
    {id:4, created_at:"2024-04-01T00:00:00Z", metadata:{container:{tags:[]}}},
    {id:5, created_at:"2024-05-01T00:00:00Z", metadata:{container:{tags:["v2.0.0"]}}},
  ],
  multipage: [
    {id:1, created_at:"2024-01-01T00:00:00Z", metadata:{container:{tags:["main"]}}},
    {id:2, created_at:"2024-02-01T00:00:00Z", metadata:{container:{tags:["main"]}}},
    {id:3, created_at:"2024-03-01T00:00:00Z", metadata:{container:{tags:["sha-x"]}}},
    {id:4, created_at:"2024-04-01T00:00:00Z", metadata:{container:{tags:["sha-y"]}}},
    {id:5, created_at:"2024-05-01T00:00:00Z", metadata:{container:{tags:["v1.0.0"]}}},
  ],
  empty: [],
  non200: null,
  malformed: null,
  badmetadata: [
    {created_at:"2024-01-01T00:00:00Z", metadata:{container:{tags:[]}}},
  ],
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  // org endpoint check
  if (url.pathname === '/orgs/test-owner') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({login:'test-owner'}));
    return;
  }
  // versions endpoint
  if (url.pathname === '/orgs/test-owner/packages/container/test-pkg/versions') {
    if (scenario === 'non200') {
      res.writeHead(404, {'Content-Type':'application/json'});
      res.end(JSON.stringify({message:'Not Found'}));
      return;
    }
    if (scenario === 'malformed') {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end('{not: json array');
      return;
    }
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const all = versions[scenario] || [];
    // 2 per page for multipage; otherwise all on page 1
    const perPage = (scenario === 'multipage') ? 2 : 100;
    const start = (page-1)*perPage;
    const slice = all.slice(start, start+perPage);
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(slice));
    return;
  }
  // delete endpoint
  if (req.method === 'DELETE' && /\/versions\/\d+$/.test(url.pathname)) {
    const id = url.pathname.split('/').pop();
    require('fs').appendFileSync('/tmp/mock-deletes.log', id + '\n');
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(404, {'Content-Type':'application/json'});
  res.end(JSON.stringify({message:'Not Found'}));
});

server.listen(port, () => {
  process.stdout.write('READY\n');
});
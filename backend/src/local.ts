// Local development server: in-memory data, no AWS needed.
// Staff sign in with "Authorization: Dev <ngs|grow|tal>". Family sign in as normal with a seeded claim ID and passcode.
import { createServer } from 'node:http';
import { createApi } from './api';
import { DevAuthenticator } from './auth';
import { MemoryBlob } from './blob';
import { BedrockClassifier, FilenameClassifier } from './classifier';
import { MockGreenId } from './greenid';
import { MemoryKV } from './kv';
import { Repo } from './repo';
import { seedDemoClaims, seedStats } from './seed-data';
import { Service } from './service';

const PORT = Number(process.env.PORT ?? 8787);
const SECRET = 'local-dev-secret';
const base = `http://localhost:${PORT}`;
const blob = new MemoryBlob(base);
const repo = new Repo(new MemoryKV());
const service: Service = new Service({
  repo,
  blob,
  classifier: process.env.BEDROCK_MODEL_ID ? new BedrockClassifier(process.env.BEDROCK_MODEL_ID) : new FilenameClassifier(),
  greenId: new MockGreenId(),
  counsellingUrl: 'https://example.com/member-counselling',
  startVerification: async (claimId) => {
    setTimeout(() => service.verifyClaim(claimId).catch(console.error), 3000); // stands in for the Step Functions workflow
  },
});
const handle = createApi(service, new DevAuthenticator(SECRET), async () => SECRET);

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization,content-type',
  'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', base);
  if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks);

  if (url.pathname.startsWith('/blob/')) {
    const key = decodeURIComponent(url.pathname.slice(6));
    if (req.method === 'PUT') {
      blob.files.set(key, { data: raw, contentType: String(req.headers['content-type'] ?? 'application/octet-stream') });
      return void res.writeHead(200, CORS).end();
    }
    const f = blob.files.get(key);
    if (!f) return void res.writeHead(404, CORS).end();
    return void res.writeHead(200, { ...CORS, 'content-type': f.contentType, 'content-disposition': 'attachment' }).end(f.data);
  }

  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v[0] : v]));
  const r = await handle({ method: req.method ?? 'GET', path: url.pathname, headers, body: raw.toString() || undefined });
  res.writeHead(r.status, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(r.body));
});

await seedStats(repo);
await seedDemoClaims(service, blob);
server.listen(PORT, () => console.log(`\nLocal API on ${base}`));

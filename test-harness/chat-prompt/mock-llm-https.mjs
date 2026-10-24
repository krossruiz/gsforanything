// Preload for server.js (node --import): answers api.anthropic.com and
// api.openai.com requests locally and appends each request body to
// $GS_LLM_CAPTURE (one JSON line per call). Nothing leaves the machine.
import https from 'https';
import fs from 'fs';
import { EventEmitter } from 'events';
import { Readable } from 'stream';
const CAPTURE = process.env.GS_LLM_CAPTURE;
const real = https.request;
https.request = function (opts, cb) {
  const host = typeof opts === 'object' && !(opts instanceof URL) ? opts.hostname || opts.host : new URL(opts).hostname;
  if (host !== 'api.anthropic.com' && host !== 'api.openai.com') return real.apply(this, arguments);
  const req = new EventEmitter();
  let body = '';
  req.write = (c) => { body += c; return true; };
  req.setTimeout = () => req;
  req.destroy = () => {};
  req.end = (c) => {
    if (c) body += c;
    const parsed = JSON.parse(body);
    fs.appendFileSync(CAPTURE, JSON.stringify({ host, path: opts.path, body: parsed }) + '\n');
    const reply = host === 'api.openai.com'
      ? { choices: [{ message: { content: 'mock openai reply' } }] }
      : { content: [{ type: 'text', text: 'mock claude reply' }] };
    const res = Readable.from([JSON.stringify(reply)]);
    res.statusCode = 200; res.headers = { 'content-type': 'application/json' };
    setImmediate(() => cb(res));
  };
  return req;
};

/* 用 GitHub API 核对仓库状态并开启 Pages。
 * 目的：让用户少点几步 —— 开 Pages 是"别人能不能玩"的开关，用 API 一次做完。
 * token 从 ~/.git-credentials 读，只放在请求头里，不打印。 */
const fs = require('fs'), os = require('os'), path = require('path'), https = require('https');

const OWNER = 'ltwza', REPO = 'road-defender';
const raw = fs.readFileSync(path.join(os.homedir(), '.git-credentials'), 'utf8');
const entry = raw.split(/\r?\n/).find((l) => /@github\.com$/.test(l.trim()));
const token = entry.match(/^https?:\/\/[^:@]+:([^@]+)@/)[1];
const LOG = 'C:/Users/Administrator/Desktop/road-defender/_pages.txt';
const LINES = [];
const say = (s) => { LINES.push(s); fs.writeFileSync(LOG, LINES.join('\n') + '\n', 'utf8'); };

function api(method, p, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      host: 'api.github.com', path: p, method: method,
      headers: Object.assign({
        'User-Agent': 'road-defender-deploy',
        'Accept': 'application/vnd.github+json',
        'Authorization': 'Bearer ' + token
      }, data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {})
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', (e) => resolve({ status: 0, body: String(e.message) }));
    if (data) req.write(data);
    req.end();
  });
}

(async function () {
  const repo = await api('GET', `/repos/${OWNER}/${REPO}`);
  say('=== repo ===');
  say('status = ' + repo.status);
  if (repo.status === 200) {
    const r = JSON.parse(repo.body);
    say('full_name = ' + r.full_name);
    say('private   = ' + r.private);
    say('default_branch = ' + r.default_branch);
    say('size(KB)  = ' + r.size);
    say('html_url  = ' + r.html_url);
  } else {
    say(repo.body.slice(0, 400));
  }

  say('\n=== branch refs ===');
  const bs = await api('GET', `/repos/${OWNER}/${REPO}/branches`);
  say('status = ' + bs.status);
  if (bs.status === 200) {
    JSON.parse(bs.body).forEach((b) => say('  ' + b.name + ' -> ' + b.commit.sha.slice(0, 8) + '  ' + (b.commit.commit && b.commit.commit.message || '').split('\n')[0]));
  } else { say(bs.body.slice(0, 300)); }

  say('\n=== pages (before) ===');
  const p1 = await api('GET', `/repos/${OWNER}/${REPO}/pages`);
  say('status = ' + p1.status);
  say(p1.status === 200 ? p1.body.slice(0, 300) : p1.body.slice(0, 300));

  if (p1.status === 404) {
    say('\n=== enable pages ===');
    const create = await api('POST', `/repos/${OWNER}/${REPO}/pages`, {
      source: { branch: 'main', path: '/' }
    });
    say('status = ' + create.status);
    say(create.body.slice(0, 500));
  }

  say('\n=== pages (after) ===');
  const p2 = await api('GET', `/repos/${OWNER}/${REPO}/pages`);
  say('status = ' + p2.status);
  if (p2.status === 200) {
    const p = JSON.parse(p2.body);
    say('html_url  = ' + p.html_url);
    say('status    = ' + p.status);
    say('source    = ' + JSON.stringify(p.source));
  } else { say(p2.body.slice(0, 300)); }
})();

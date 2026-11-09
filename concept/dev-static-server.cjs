// 极简静态服务器（仅本地回环，只读服务仓库文件），供无头截图验证新渲染层。
// 用途：file:// 协议无法加载 type=module 的 ES 产物，需要 http 源。
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]);
  const fp = path.join(root, p);
  if (!fp.startsWith(root)) { res.writeHead(403); return res.end(); }
  fs.readFile(fp, (e, buf) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(5199, '127.0.0.1', () => console.log('static server on 5199'));

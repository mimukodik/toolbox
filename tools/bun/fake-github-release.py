import http.server, json, os, sys, hashlib
root = sys.argv[1]; port = int(sys.argv[2]); tag = sys.argv[3]; with_digest = sys.argv[4] == "digest"
base = f"http://127.0.0.1:{port}"
names = sorted(os.listdir(os.path.join(root, "files")))
def release():
    assets = []
    for i, n in enumerate(names, 1):
        p = os.path.join(root, "files", n)
        a = {"id": i, "name": n, "size": os.path.getsize(p), "state": "uploaded", "content_type": "application/octet-stream",
             "url": f"{base}/repos/mimukodik/toolbox/releases/assets/{i}", "browser_download_url": f"{base}/dl/{tag}/{n}",
             "created_at": "2026-11-27T00:00:00Z", "updated_at": "2026-11-27T00:00:00Z"}
        if with_digest and not n.endswith((".sha256", ".json")):
            a["digest"] = "sha256:" + hashlib.sha256(open(p, "rb").read()).hexdigest()
        assets.append(a)
    return {"id": 1, "tag_name": tag, "name": tag, "draft": False, "prerelease": False, "created_at": "2026-11-27T00:00:00Z",
            "published_at": "2026-11-27T00:00:00Z", "html_url": f"{base}/r", "assets": assets, "body": "", "url": f"{base}/r"}
class H(http.server.BaseHTTPRequestHandler):
    def log_message(self, f, *a): sys.stderr.write("api: " + f % a + "\n")
    def send(self, code, body, ctype="application/json"):
        self.send_response(code); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        path = self.path.split("?")[0]
        if path.endswith("/releases"): return self.send(200, json.dumps([release()]).encode())
        if path.endswith("/releases/latest") or "/releases/tags/" in path: return self.send(200, json.dumps(release()).encode())
        if "/releases/assets/" in path: n = names[int(path.rsplit("/", 1)[1]) - 1]
        elif path.startswith("/dl/"): n = path.rsplit("/", 1)[1]
        else: return self.send(404, b"{}")
        return self.send(200, open(os.path.join(root, "files", n), "rb").read(), "application/octet-stream")
http.server.ThreadingHTTPServer(("127.0.0.1", port), H).serve_forever()

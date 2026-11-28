# Stand-in model server for testing SwarmBench: python fake_server.py llama|ollama|openai PORT
import json, sys, time, re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
MODE, PORT = sys.argv[1], int(sys.argv[2])
PROMPT_TPS, GEN_TPS = 2000.0, 40.0
def ntok(p): return max(1, int(len(p.split()) * 1.3))
class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def j(self, o, code=200):
        b = json.dumps(o).encode(); self.send_response(code); self.send_header("Content-Type","application/json"); self.send_header("Content-Length",str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self):
        if MODE=="llama" and self.path=="/props": return self.j({"model_path":"/m/Qwen3.5-35B-A3B-Q4_K_M.gguf","build_info":"b12359","total_slots":1,"default_generation_settings":{"n_ctx":16384,"params":{}}})
        if MODE=="ollama" and self.path=="/api/tags": return self.j({"models":[{"name":"qwen3:8b"},{"name":"gemma3:4b"}]})
        if MODE=="ollama" and self.path=="/api/ps": return self.j({"models":[{"name":"qwen3:8b","size":6000000000,"size_vram":4500000000,"details":{"quantization_level":"Q4_K_M","parameter_size":"8.2B"}}]})
        if MODE=="openai" and self.path=="/v1/models": return self.j({"data":[{"id":"local-model"}]})
        self.j({"error":"nope"},404)
    def stream(self):
        self.send_response(200); self.send_header("Content-Type","text/event-stream"); self.end_headers()
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        p = body.get("prompt") or body.get("messages",[{}])[0].get("content","")
        n = body.get("n_predict") or body.get("max_tokens") or (body.get("options") or {}).get("num_predict")
        pn = ntok(p); pms = pn / PROMPT_TPS * 1000; time.sleep(0.03 + pms/1000)
        if MODE=="llama" and self.path=="/completion":
            self.stream()
            for i in range(n):
                if i: time.sleep(1/GEN_TPS)
                self.wfile.write(b"data: "+json.dumps({"content":"x "}).encode()+b"\n\n"); self.wfile.flush()
            self.wfile.write(b"data: "+json.dumps({"content":"","stop":True,"timings":{"prompt_n":pn,"prompt_ms":pms,"predicted_n":n,"predicted_ms":n/GEN_TPS*1000}}).encode()+b"\n\n"); return
        if MODE=="ollama" and self.path=="/api/generate":
            self.stream(); k=min(n, 50)  # stops early
            for i in range(k):
                if i: time.sleep(1/GEN_TPS)
                self.wfile.write((json.dumps({"response":"x "})+"\n").encode()); self.wfile.flush()
            self.wfile.write((json.dumps({"done":True,"prompt_eval_count":pn,"prompt_eval_duration":int(pms*1e6),"eval_count":k,"eval_duration":int(k/GEN_TPS*1e9),"load_duration":1000000})+"\n").encode()); return
        if MODE=="openai" and self.path=="/v1/completions":
            if "ignore_eos" in body: return self.j({"error":"unknown field ignore_eos"},400)
            self.stream()
            for i in range(n):
                if i: time.sleep(1/GEN_TPS)
                self.wfile.write(b"data: "+json.dumps({"choices":[{"text":"x "}]}).encode()+b"\n\n"); self.wfile.flush()
            self.wfile.write(b"data: "+json.dumps({"choices":[],"usage":{"prompt_tokens":pn,"completion_tokens":n}}).encode()+b"\n\n")
            self.wfile.write(b"data: [DONE]\n\n"); return
        self.j({"error":"nope"},404)
ThreadingHTTPServer(("127.0.0.1",PORT),H).serve_forever()

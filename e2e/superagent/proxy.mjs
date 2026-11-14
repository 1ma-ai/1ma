import { createServer, request } from "node:http";

export class FaultProxy {
  constructor(target) {
    this.target = new URL(target);
    this.mode = { kind: "pass" };
    this.log = [];
    this.server = createServer((req, res) => this.#handle(req, res));
  }

  listen(port) {
    return new Promise((resolve) => this.server.listen(port, "127.0.0.1", resolve));
  }

  close() {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  get url() {
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  setMode(mode) {
    this.mode = mode;
  }

  #forward(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const upstream = request(
        {
          host: this.target.hostname,
          port: this.target.port,
          method,
          path: url,
          headers: { ...headers, host: this.target.host },
          agent: false,
        },
        (response) => {
          const chunks = [];
          response.on("data", (chunk) => chunks.push(chunk));
          response.on("end", () =>
            resolve({
              status: response.statusCode ?? 502,
              headers: response.headers,
              body: Buffer.concat(chunks),
            }),
          );
          response.on("error", reject);
        },
      );
      upstream.on("error", reject);
      upstream.end(body);
    });
  }

  #handle(req, res) {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const mode = this.mode;
      const spawn = req.method === "POST" && req.url === "/api/v1/threads";
      this.log.push({ method: req.method, url: req.url, mode: spawn ? mode.kind : "pass" });
      if (mode.kind === "refuse") {
        req.socket.destroy();
        return;
      }
      if (spawn && mode.kind !== "pass") {
        if (mode.once) this.mode = { kind: "pass" };
        if (mode.kind === "swallow") {
          req.socket.destroy();
          return;
        }
        if (mode.kind === "drop-response") {
          await this.#forward(req.method, req.url, req.headers, body).catch(() => {});
          req.socket.destroy();
          return;
        }
        if (mode.kind === "forward-later") {
          req.socket.destroy();
          setTimeout(
            () => void this.#forward(req.method, req.url, req.headers, body).catch(() => {}),
            mode.delayMs,
          );
          return;
        }
        if (mode.kind === "delay") {
          setTimeout(async () => {
            const upstream = await this.#forward(req.method, req.url, req.headers, body).catch(
              () => null,
            );
            if (upstream === null || res.destroyed) return;
            res.writeHead(upstream.status, {
              "content-type": upstream.headers["content-type"] ?? "application/json",
            });
            res.end(upstream.body);
          }, mode.delayMs);
          return;
        }
      }
      try {
        const upstream = await this.#forward(req.method, req.url, req.headers, body);
        res.writeHead(upstream.status, {
          "content-type": upstream.headers["content-type"] ?? "application/json",
        });
        res.end(upstream.body);
      } catch {
        res.writeHead(502);
        res.end("upstream unavailable");
      }
    });
  }
}
